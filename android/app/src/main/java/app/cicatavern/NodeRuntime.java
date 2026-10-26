package app.cicatavern;

import android.content.Context;
import android.content.res.AssetManager;
import android.os.Build;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

/**
 * The embedded Node (nodejs-mobile) running bin/android.mjs. Node can start
 * only once per process, so this lives as long as the process: a recreated
 * activity finds it already running and just reconnects.
 */
final class NodeRuntime {
    /** Why libnode.so would not load (kept, not thrown: an Error here would take the whole app down). */
    private static final Throwable LOAD_ERROR;

    static {
        Throwable error = null;
        try {
            System.loadLibrary("node");
            System.loadLibrary("native-lib");
        } catch (Throwable e) {
            error = e;
        }
        LOAD_ERROR = error;
    }

    private static native int startNode(String[] arguments, String logPath);

    private static final String ASSETS = "nodejs-project";
    /** Exists from Node's start until the page connects: left over, it means the last start crashed. */
    private static final String STARTING = "starting";

    private static boolean started;

    static synchronized boolean isStarted() {
        return started;
    }
    static volatile int port;
    static volatile String token;
    /** Set once Node has exited (it should not); the activity shows the log then. */
    static volatile Integer exitCode;
    static volatile File logFile;
    /** Written by bin/android.mjs when the server could not start (Node stays alive, see there). */
    static volatile File errorFile;

    private NodeRuntime() {}

    /** Page size, Android version and device, for error pages. */
    static String deviceInfo() {
        return "Android " + Build.VERSION.RELEASE + "（API " + Build.VERSION.SDK_INT + "），" + Build.MANUFACTURER + " " + Build.MODEL
            + "，内存页 " + (Os.sysconf(OsConstants._SC_PAGESIZE) / 1024) + " KB，" + String.join("/", Build.SUPPORTED_ABIS);
    }

    /**
     * When the last start never reached the page (Node crashed natively and
     * took the process with it), the end of its log; otherwise null. Read
     * once: the marker is removed, so "retry" starts normally.
     */
    static synchronized String previousCrash(Context context) {
        File marker = new File(context.getFilesDir(), STARTING);
        if (started || !marker.exists()) return null;
        marker.delete();
        logFile = new File(context.getFilesDir(), "server.log");
        return logTail(8000);
    }

    /** The page connected: this start worked. */
    static void markReady(Context context) {
        new File(context.getFilesDir(), STARTING).delete();
    }

    static synchronized void ensureStarted(Context context) throws IOException {
        if (started) return;
        if (LOAD_ERROR != null) {
            long page = Os.sysconf(OsConstants._SC_PAGESIZE);
            String hint = page > 4096 ? "这台手机的内存页是 " + (page / 1024) + " KB，内置的 Node（nodejs-mobile）只支持 4 KB 内存页。\n\n" : "";
            throw new IOException(hint + "内置 Node 加载失败：" + LOAD_ERROR);
        }
        File files = context.getFilesDir();
        File project = new File(files, ASSETS);
        extractIfChanged(context.getAssets(), project);
        File data = new File(files, "data");
        if (!data.isDirectory() && !data.mkdirs()) throw new IOException("无法创建数据目录 " + data);

        // One log per start, so an error page shows only this start; the last one stays as server.prev.log.
        logFile = new File(files, "server.log");
        File previousLog = new File(files, "server.prev.log");
        previousLog.delete();
        if (logFile.exists() && !logFile.renameTo(previousLog)) logFile.delete();
        errorFile = new File(files, "startup-error.txt");
        errorFile.delete();
        try {
            Os.setenv("HOME", files.getAbsolutePath(), true);
            Os.setenv("TMPDIR", context.getCacheDir().getAbsolutePath(), true);
        } catch (ErrnoException ignored) {
            // Node falls back to its own defaults.
        }

        port = stablePort(files);
        token = randomHex(24);
        String[] arguments = {
            "node",
            new File(project, "bin/android.mjs").getAbsolutePath(),
            "--data", data.getAbsolutePath(),
            "--port", String.valueOf(port),
            "--token", token,
            "--log", logFile.getAbsolutePath(),
            "--error-file", errorFile.getAbsolutePath(),
        };
        String log = logFile.getAbsolutePath();
        try (OutputStream out = new FileOutputStream(new File(files, STARTING))) {
            out.write(String.valueOf(System.currentTimeMillis()).getBytes(StandardCharsets.UTF_8));
        }
        // Node's own main thread wants a larger stack than Java's default.
        Thread thread = new Thread(null, () -> exitCode = startNode(arguments, log), "node", 16L * 1024 * 1024);
        thread.setDaemon(true);
        thread.start();
        started = true;
    }

    /** What bin/android.mjs reported about a failed start, or null. */
    static String startupError() {
        File file = errorFile;
        if (file == null || !file.exists()) return null;
        try (InputStream in = new java.io.FileInputStream(file)) {
            return new String(readAll(in), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return String.valueOf(e);
        }
    }

    /** The last part of the server log, for an error page. */
    static String logTail(int maxBytes) {
        File file = logFile;
        if (file == null || !file.exists()) return "";
        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            long start = Math.max(0, raf.length() - maxBytes);
            byte[] bytes = new byte[(int) (raf.length() - start)];
            raf.seek(start);
            raf.readFully(bytes);
            return new String(bytes, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            return socket.getLocalPort();
        }
    }

    /**
     * The last start's port while it is free, else a new one kept for next time: the page's localStorage (theme,
     * what was new, card permissions…) belongs to http://127.0.0.1:<port> and was empty after every cold start.
     */
    private static int stablePort(File files) throws IOException {
        File saved = new File(files, "port.txt");
        try {
            int previous = Integer.parseInt(readFile(saved));
            if (previous > 1024 && previous < 65536 && portFree(previous)) return previous;
        } catch (NumberFormatException ignored) {
            // None kept yet.
        }
        int fresh = freePort();
        try (OutputStream out = new FileOutputStream(saved)) {
            out.write(String.valueOf(fresh).getBytes(StandardCharsets.UTF_8));
        }
        return fresh;
    }

    private static boolean portFree(int port) {
        try (ServerSocket socket = new ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"))) {
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private static String randomHex(int bytes) {
        byte[] buffer = new byte[bytes];
        new SecureRandom().nextBytes(buffer);
        StringBuilder hex = new StringBuilder();
        for (byte b : buffer) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    /** Copy assets/nodejs-project to files/ when the APK's stamp differs from the copy on disk. */
    private static void extractIfChanged(AssetManager assets, File target) throws IOException {
        String stamp = readAsset(assets, ASSETS + "/stamp.txt");
        File stampFile = new File(target, "stamp.txt");
        if (stampFile.exists() && stamp.equals(readFile(stampFile))) return;
        deleteTree(target);
        copyAssets(assets, ASSETS, target);
    }

    private static void copyAssets(AssetManager assets, String path, File target) throws IOException {
        String[] children = assets.list(path);
        if (children == null || children.length == 0) {
            File parent = target.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("无法创建 " + parent);
            try (InputStream in = assets.open(path); OutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                int n;
                while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            }
            return;
        }
        if (!target.isDirectory() && !target.mkdirs()) throw new IOException("无法创建 " + target);
        for (String child : children) copyAssets(assets, path + "/" + child, new File(target, child));
    }

    private static String readAsset(AssetManager assets, String path) throws IOException {
        try (InputStream in = assets.open(path)) {
            return new String(readAll(in), StandardCharsets.UTF_8).trim();
        }
    }

    private static String readFile(File file) {
        try (InputStream in = new java.io.FileInputStream(file)) {
            return new String(readAll(in), StandardCharsets.UTF_8).trim();
        } catch (IOException e) {
            return "";
        }
    }

    /** InputStream.readAllBytes needs Android 13. */
    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int n;
        while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
        return out.toByteArray();
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
