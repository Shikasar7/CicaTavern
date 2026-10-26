package app.cicatavern;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * 设置 → 更多 → 更新 on the phone: downloads the release APK, checks it (the
 * SHA-256 the release publishes, this app's package, a newer version, the same
 * signing certificate) and hands it to the system installer, which asks the
 * user. Only the repository's own release downloads are fetched (GitHub's, or the
 * same file on the mirror in mainland China, server/update/release.mjs MIRROR),
 * so a page that calls the bridge can at most offer the official newer version.
 *
 * The page follows along through window events 'cicatavern-apk' whose detail is
 * the state: { step: idle | downloading | verifying | permission | installing | error,
 * received, total, error: network | hash | package | older | signature | storage | installer | denied, detail }.
 */
final class ApkUpdate {
    private static final String[] RELEASES = {
        "https://github.com/Shikasar7/CicaTavern/releases/download/",
        "https://cnb.cool/cicatavern/CicaTavern/-/releases/download/",
    };
    private static final String APK_TYPE = "application/vnd.android.package-archive";

    interface Listener {
        void report(String stateJson);
    }

    /** A failed step, by the code the page shows a message for. */
    private static final class Problem extends Exception {
        final String code;

        Problem(String code, String detail) {
            super(detail);
            this.code = code;
        }
    }

    private static final class Cancelled extends Exception {
    }

    // One for the whole app: an activity made again (a dark-mode switch) finds the download it started,
    // instead of a second one writing the same file.
    private static ApkUpdate shared;

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    // The activity on screen and its page; null between one activity and the next.
    private volatile Activity activity;
    private volatile Listener listener;
    private volatile boolean cancelled;
    private Thread thread;
    private boolean waitingForPermission;
    // On the main thread: whether the activity is in front, and an install waiting for it to be.
    private boolean foreground;
    private boolean pendingInstall;
    private String state = "{\"step\":\"idle\"}";

    private ApkUpdate(Context context) {
        this.context = context;
    }

    /** The app's update, now reporting to this activity's page. */
    static synchronized ApkUpdate attach(Activity activity, Listener listener) {
        if (shared == null) shared = new ApkUpdate(activity.getApplicationContext());
        shared.activity = activity;
        shared.listener = listener;
        return shared;
    }

    /** The activity is gone: the download carries on, and reports to the next one. */
    void detach(Activity gone) {
        if (activity != gone) return;
        activity = null;
        listener = null;
        foreground = false;
    }

    /** In front or not (onResume / onPause): Android blocks starting Settings or the installer from behind. */
    void foreground(boolean now) {
        foreground = now;
    }

    /** Where the download goes; ApkProvider serves this one file to the installer. */
    static File file(android.content.Context context) {
        return new File(new File(context.getCacheDir(), "update"), "CicaTavern.apk");
    }

    synchronized String state() {
        return state;
    }

    private static boolean fromRelease(String url) {
        for (String prefix : RELEASES) if (url.startsWith(prefix)) return true;
        return false;
    }

    /** false when the address or hash is not one this accepts. */
    synchronized boolean start(String url, String sha256) {
        if (url == null || sha256 == null) return false;
        if (!fromRelease(url) || !url.endsWith("-android-arm64.apk") || url.contains("..")) return false;
        if (!sha256.matches("[0-9a-fA-F]{64}")) return false;
        if (thread != null && thread.isAlive()) return true;
        cancelled = false;
        String expected = sha256.toLowerCase(java.util.Locale.ROOT);
        thread = new Thread(() -> run(url, expected), "apk-update");
        thread.start();
        return true;
    }

    void cancel() {
        cancelled = true;
    }

    /** Back in front: the install that waited for it, or back from the 安装未知应用 settings page. */
    void resume() {
        if (pendingInstall) {
            pendingInstall = false;
            install();
            return;
        }
        if (!waitingForPermission) return;
        waitingForPermission = false;
        if (context.getPackageManager().canRequestPackageInstalls() && file(context).exists()) install();
        else report(step("error").put("error", "denied"));
    }

    private void run(String url, String sha256) {
        File out = file(context);
        try {
            File dir = out.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new Problem("storage", dir.getPath());
            // The same file downloaded before (the installer was refused, or the app was restarted): not again.
            if (!sha256.equals(hashOf(out))) {
                if (out.exists() && !out.delete()) throw new Problem("storage", out.getPath());
                download(url, out, sha256);
            }
            report(step("verifying"));
            check(out);
            main.post(this::install);
        } catch (Cancelled e) {
            out.delete();
            report(step("idle"));
        } catch (Problem e) {
            out.delete();
            report(step("error").put("error", e.code).put("detail", e.getMessage()));
        }
    }

    /**
     * GitHub's asset host sometimes drops a connection partway, as browsers find
     * too: carry on from the last byte (a Range request) a few times before giving up.
     */
    private static final int ATTEMPTS = 6;

    private void download(String address, File out, String sha256) throws Problem, Cancelled {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (Exception e) {
            throw new Problem("network", String.valueOf(e));
        }
        long received = 0;
        long total = 0;
        long reported = 0;
        String lastError = "";
        report(step("downloading").put("received", 0).put("total", 0));
        for (int failures = 0; failures < ATTEMPTS; ) {
            if (cancelled) throw new Cancelled();
            long before = received;
            HttpURLConnection connection = null;
            try {
                // GitHub redirects to its asset host, https to https, which HttpURLConnection follows.
                connection = (HttpURLConnection) new URL(address).openConnection();
                connection.setConnectTimeout(15_000);
                connection.setReadTimeout(30_000);
                connection.setRequestProperty("User-Agent", "CicaTavern-Android");
                if (received > 0) connection.setRequestProperty("Range", "bytes=" + received + "-");
                int code = connection.getResponseCode();
                boolean append = received > 0 && code == 206;
                if (code == 200) {
                    // From the start: the server sent the whole file.
                    received = 0;
                    before = 0;
                    digest.reset();
                    total = Math.max(connection.getContentLengthLong(), 0);
                } else if (!append) {
                    throw new Problem("network", "HTTP " + code);
                }
                try (InputStream in = connection.getInputStream(); OutputStream file = new FileOutputStream(out, append)) {
                    byte[] buffer = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buffer)) > 0) {
                        if (cancelled) throw new Cancelled();
                        file.write(buffer, 0, n);
                        digest.update(buffer, 0, n);
                        received += n;
                        long now = System.currentTimeMillis();
                        if (now - reported > 250) {
                            reported = now;
                            report(step("downloading").put("received", received).put("total", total));
                        }
                    }
                }
                if (total > 0 && received < total) throw new IOException("ended at " + received + " / " + total);
                if (!sha256.equals(hex(digest.digest()))) throw new Problem("hash", "");
                return;
            } catch (Problem | Cancelled e) {
                throw e;
            } catch (IOException e) {
                if (cancelled) throw new Cancelled();
                lastError = String.valueOf(e.getMessage() != null ? e.getMessage() : e);
            } finally {
                if (connection != null) connection.disconnect();
            }
            // Progress this time round starts the count again; only stalls in a row give up.
            failures = received > before ? 1 : failures + 1;
            try {
                Thread.sleep(1500L * failures);
            } catch (InterruptedException e) {
                throw new Cancelled();
            }
        }
        throw new Problem("network", lastError);
    }

    /** The SHA-256 of a file there, or "" when there is none or it can't be read. */
    private static String hashOf(File file) {
        if (!file.isFile()) return "";
        try (InputStream in = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) > 0) digest.update(buffer, 0, n);
            return hex(digest.digest());
        } catch (Exception e) {
            return "";
        }
    }

    /** This app, a newer version, signed with the same certificate (the installer refuses another one anyway). */
    private void check(File apk) throws Problem {
        PackageManager pm = context.getPackageManager();
        PackageInfo next = pm.getPackageArchiveInfo(apk.getPath(), PackageManager.GET_SIGNING_CERTIFICATES);
        if (next == null) throw new Problem("package", "");
        PackageInfo self;
        try {
            self = pm.getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
        } catch (PackageManager.NameNotFoundException e) {
            throw new Problem("package", String.valueOf(e));
        }
        if (!self.packageName.equals(next.packageName)) throw new Problem("package", next.packageName);
        Set<String> mine = signers(self.signingInfo);
        Set<String> theirs = signers(next.signingInfo);
        if (mine != null && theirs != null && !mine.equals(theirs)) throw new Problem("signature", "");
        if (next.getLongVersionCode() <= self.getLongVersionCode()) throw new Problem("older", String.valueOf(next.versionName));
    }

    /** The signing certificates' SHA-256, or null when the system did not read them. */
    private static Set<String> signers(SigningInfo info) {
        if (info == null) return null;
        Signature[] all = info.hasMultipleSigners() ? info.getApkContentsSigners() : info.getSigningCertificateHistory();
        if (all == null || all.length == 0) return null;
        if (!info.hasMultipleSigners()) all = Arrays.copyOfRange(all, all.length - 1, all.length);
        Set<String> out = new HashSet<>();
        try {
            for (Signature signature : all) out.add(hex(MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())));
        } catch (Exception e) {
            return null;
        }
        return out;
    }

    /**
     * On the main thread: ask for 安装未知应用 the first time, then open the system installer. With the app
     * behind another one, Android would block both without a word: it waits until the app is in front.
     */
    private void install() {
        Activity front = activity;
        if (front == null || !foreground) {
            pendingInstall = true;
            return;
        }
        if (!context.getPackageManager().canRequestPackageInstalls()) {
            waitingForPermission = true;
            report(step("permission"));
            try {
                front.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName())));
            } catch (ActivityNotFoundException e) {
                waitingForPermission = false;
                report(step("error").put("error", "denied"));
            }
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(ApkProvider.uri(context), APK_TYPE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            front.startActivity(intent);
            report(step("installing"));
        } catch (ActivityNotFoundException e) {
            report(step("error").put("error", "installer"));
        }
    }

    private static Json step(String name) {
        return new Json().put("step", name);
    }

    private void report(Json json) {
        String text = json.toString();
        synchronized (this) {
            state = text;
        }
        Listener now = listener;
        if (now != null) now.report(text);
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format("%02x", b));
        return out.toString();
    }

    /** JSONObject whose put does not throw. */
    private static final class Json {
        private final JSONObject object = new JSONObject();

        Json put(String key, Object value) {
            try {
                object.put(key, value);
            } catch (JSONException ignored) {
                // Only strings and numbers go in.
            }
            return this;
        }

        @Override
        public String toString() {
            return object.toString();
        }
    }
}
