package app.cicatavern;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.text.TextUtils;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Starts the embedded server (NodeRuntime), waits for it, then shows the web
 * UI in a WebView. The access token goes in as a cookie, so other apps on the
 * phone that find the port still cannot use it.
 */
public class MainActivity extends Activity {
    private static final int PICK_FILES = 1;
    private static final int ASK_MICROPHONE = 2;
    private static final long START_TIMEOUT_MS = 60_000;

    private final Handler main = new Handler(Looper.getMainLooper());
    // The bridge (window.AgentTavernAndroid) is in every frame of the WebView, card frames too: each call carries
    // this launch's key, a cookie of the app's own page that an opaque-origin card frame cannot read (web/app.js android).
    private final String bridgeKey = newKey();
    private WebView web;
    private ValueCallback<Uri[]> pendingChooser;
    // The page's microphone request (语音输入) while Android asks the user for RECORD_AUDIO.
    private PermissionRequest pendingMicrophone;
    private ApkUpdate update;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // chrome://inspect from a computer the phone has authorised for USB debugging: a debug build only
        // (assembleDebug, as android/README.md says). The release APK keeps its page, chats and keys to itself.
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        update = ApkUpdate.attach(this, state -> main.post(() ->
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('cicatavern-apk', { detail: " + state + " }))", null)));
        newWebView();
        recordCrashes();

        // Show what went wrong last time instead of crashing again.
        String javaCrash = takeCrashFile();
        String nativeCrash = NodeRuntime.previousCrash(getApplicationContext());
        if (javaCrash != null) {
            showMessage("上次打开时应用崩溃了", javaCrash, true);
            return;
        }
        if (nativeCrash != null) {
            showMessage("上次启动时内置 Node 崩溃了", "服务日志的最后一段：\n" + (nativeCrash.isEmpty() ? "（没有输出）" : nativeCrash), true);
            return;
        }
        start();
    }

    /** The WebView the app shows, a fresh one in place of any before it (onRenderProcessGone). */
    private void newWebView() {
        WebView previous = web;
        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // The WebView scales text by the system font size, but the layout is in px:
        // at a large font size labels overflow their buttons and dialogs. Keep the page's own sizes.
        settings.setTextZoom(100);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        web.setWebViewClient(new LocalOnlyClient());
        web.setWebChromeClient(new Chooser());
        web.addJavascriptInterface(new Bridge(), "AgentTavernAndroid");
        setContentView(web);
        if (previous != null) previous.destroy();
    }

    private void start() {
        showMessage("正在启动…", "", false);
        startForegroundService(new Intent(this, NodeService.class));
        new Thread(this::startAndConnect, "connect").start();
    }

    /** An uncaught exception is written to crash.txt before the process dies; the next launch shows it. */
    private void recordCrashes() {
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        File file = new File(getFilesDir(), "crash.txt");
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            StringWriter trace = new StringWriter();
            error.printStackTrace(new PrintWriter(trace));
            try (OutputStream out = new FileOutputStream(file)) {
                out.write(("线程 " + thread.getName() + "\n" + trace).getBytes(StandardCharsets.UTF_8));
            } catch (IOException ignored) {
                // Nothing more to do while dying.
            }
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }

    private String takeCrashFile() {
        File file = new File(getFilesDir(), "crash.txt");
        if (!file.exists()) return null;
        try (InputStream in = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) Math.min(file.length(), 16000)];
            int n = in.read(bytes);
            return new String(bytes, 0, Math.max(n, 0), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return String.valueOf(e);
        } finally {
            file.delete();
        }
    }

    private void startAndConnect() {
        try {
            NodeRuntime.ensureStarted(getApplicationContext());
        } catch (Throwable e) {
            main.post(() -> showMessage("启动失败", e.getMessage() != null ? e.getMessage() : String.valueOf(e), true));
            return;
        }
        long deadline = System.currentTimeMillis() + START_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            if (NodeRuntime.exitCode != null) break;
            String error = NodeRuntime.startupError();
            if (error != null) {
                // Reported here; the next launch should not also call it a crash.
                NodeRuntime.markReady(getApplicationContext());
                main.post(() -> showMessage("服务启动失败", error + "\n\n服务日志：\n" + NodeRuntime.logTail(6000), true));
                return;
            }
            if (healthy()) {
                main.post(this::openApp);
                return;
            }
            try {
                Thread.sleep(250);
            } catch (InterruptedException e) {
                return;
            }
        }
        String reason = NodeRuntime.exitCode != null ? "服务已退出（代码 " + NodeRuntime.exitCode + "）" : "服务一分钟内没有响应";
        main.post(() -> showMessage(reason, NodeRuntime.logTail(8000), true));
    }

    private boolean healthy() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(base() + "api/health").openConnection();
            connection.setConnectTimeout(1000);
            connection.setReadTimeout(2000);
            connection.setRequestProperty("Cookie", "tavern_key=" + NodeRuntime.token);
            return connection.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String base() {
        return "http://127.0.0.1:" + NodeRuntime.port + "/";
    }

    private void openApp() {
        NodeRuntime.markReady(getApplicationContext());
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setCookie(base(), "tavern_key=" + NodeRuntime.token + "; Path=/");
        cookies.setCookie(base(), "cicatavern_bridge=" + bridgeKey + "; Path=/");
        cookies.flush();
        web.loadUrl(base());
    }

    /**
     * A plain page for starting and for errors; errors carry the device details
     * and a retry button. Node runs once per process, so once it has started,
     * "retry" means swiping the app away and opening it again.
     */
    private void showMessage(String title, String detail, boolean failed) {
        String body = failed ? detail + "\n\n设备：" + NodeRuntime.deviceInfo() : detail;
        String retry = NodeRuntime.isStarted()
            ? "<p>要重试，在最近任务里划掉本应用，再重新打开。</p><p>"
            : "<p><button onclick='AgentTavernAndroid.retry(\"" + bridgeKey + "\")'>重试</button>";
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
            + "<style>body{font:16px/1.6 system-ui,sans-serif;margin:24px;color:#ddd;background:#111}"
            + "@media(prefers-color-scheme:light){body{color:#222;background:#fafafa}}"
            + "pre{white-space:pre-wrap;word-break:break-all;font-size:12px;opacity:.8;user-select:text}"
            + "button{font:inherit;padding:8px 18px;margin-right:8px;border-radius:8px;border:1px solid #888;background:transparent;color:inherit}</style>"
            + "<h3>" + TextUtils.htmlEncode(title) + "</h3>"
            + (failed ? retry
                + "<button onclick='AgentTavernAndroid.copy(\"" + bridgeKey + "\", document.querySelector(\"pre\").innerText)'>复制报错</button></p>" : "")
            + "<pre>" + TextUtils.htmlEncode(body) + "</pre>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    /** Back closes the top dialog or drawer; with none open, the app goes to the background (it keeps running). */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        String script = "(() => {"
            + "const d = [...document.querySelectorAll('dialog[open]')].pop();"
            + "if (d) { d.close(); return 'closed' }"
            + "const app = document.querySelector('.app');"
            + "if (app && (app.classList.contains('show-left') || app.classList.contains('show-right'))) { app.classList.remove('show-left', 'show-right'); return 'closed' }"
            + "return 'none' })()";
        web.evaluateJavascript(script, result -> {
            if (!"\"closed\"".equals(result)) moveTaskToBack(true);
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (update == null) return;
        update.foreground(true);
        update.resume();
    }

    @Override
    protected void onPause() {
        if (update != null) update.foreground(false);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (update != null) update.detach(this);
        if (isFinishing()) stopService(new Intent(this, NodeService.class));
        web.destroy();
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK_FILES) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        ValueCallback<Uri[]> callback = pendingChooser;
        pendingChooser = null;
        if (callback == null) return;
        Uri[] picked = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                picked = new Uri[clip.getItemCount()];
                for (int i = 0; i < picked.length; i++) picked[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                picked = new Uri[] {data.getData()};
            }
        }
        callback.onReceiveValue(picked);
    }

    /**
     * The page's renderer crashed or was killed (a card frame that used up its memory, a phone short of memory).
     * Left to Android, the whole app goes, and the embedded server and a reply being written with it: instead a new
     * WebView says so, and the app opens again only when asked (a page that kills it every time cannot loop).
     */
    private void rendererGone(boolean crashed) {
        newWebView();
        String why = crashed ? "页面的渲染进程崩溃了" : "页面的渲染进程被系统回收了（手机内存不够）";
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
            + "<style>body{font:16px/1.6 system-ui,sans-serif;margin:24px;color:#ddd;background:#111}"
            + "@media(prefers-color-scheme:light){body{color:#222;background:#fafafa}}"
            + "button{font:inherit;padding:8px 18px;border-radius:8px;border:1px solid #888;background:transparent;color:inherit}</style>"
            + "<h3>" + TextUtils.htmlEncode(why) + "</h3>"
            + "<p>后台服务还在运行，对话和正在写的回复都在。可能是某张卡片的界面占满了内存。</p>"
            + "<p><button onclick='AgentTavernAndroid.reopen(\"" + bridgeKey + "\")'>重新打开</button></p>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    /** Only the local server opens inside the app; any other link goes to the browser. */
    private final class LocalOnlyClient extends WebViewClient {
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // On the main thread already, and the dead view may not be touched again: replaced at once.
            if (view == web) rendererGone(detail.didCrash());
            return true;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if ("127.0.0.1".equals(uri.getHost())) return false;
            // A card frame moving on by itself, with no tap: dropped, so it can't keep opening other apps.
            if (!request.isForMainFrame() && !request.hasGesture()) return true;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) {
                // Nothing can open it.
            }
            return true;
        }
    }

    /**
     * <input type=file>: the system picker; images only when the page asks only for images (reference pictures), else any file
     * (card PNGs, JSON). Also the page's microphone requests (onPermissionRequest).
     */
    private final class Chooser extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (pendingChooser != null) pendingChooser.onReceiveValue(null);
            pendingChooser = callback;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            String[] images = imageTypes(params.getAcceptTypes());
            if (images != null) intent.putExtra(Intent.EXTRA_MIME_TYPES, images);
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(intent, PICK_FILES);
            } catch (ActivityNotFoundException e) {
                pendingChooser = null;
                callback.onReceiveValue(null);
            }
            return true;
        }

        /**
         * 语音输入: the app's own page may record from the microphone once Android has
         * RECORD_AUDIO (asked for on the first press). The camera, or any other origin
         * (a card frame), is refused.
         */
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            Uri origin = request.getOrigin();
            boolean own = origin != null && "127.0.0.1".equals(origin.getHost()) && origin.getPort() == NodeRuntime.port;
            String[] wanted = request.getResources();
            boolean audioOnly = wanted.length > 0;
            for (String resource : wanted) {
                if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) audioOnly = false;
            }
            if (!own || !audioOnly) {
                request.deny();
                return;
            }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                request.grant(wanted);
                return;
            }
            if (pendingMicrophone != null) pendingMicrophone.deny();
            pendingMicrophone = request;
            requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, ASK_MICROPHONE);
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (request == pendingMicrophone) pendingMicrophone = null;
        }
    }

    /** Android's answer about the microphone: the page's request waiting on it is granted or refused (getUserMedia fails). */
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != ASK_MICROPHONE) {
            super.onRequestPermissionsResult(requestCode, permissions, results);
            return;
        }
        PermissionRequest request = pendingMicrophone;
        pendingMicrophone = null;
        if (request == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        else request.deny();
    }

    /** The accept list when every entry is an image MIME type, else null (no filter). */
    private static String[] imageTypes(String[] accept) {
        java.util.List<String> types = new java.util.ArrayList<>();
        for (String group : accept == null ? new String[0] : accept) {
            for (String type : group.split(",")) {
                String t = type.trim();
                if (t.isEmpty()) continue;
                if (!t.startsWith("image/")) return null;
                types.add(t);
            }
        }
        return types.isEmpty() ? null : types.toArray(new String[0]);
    }

    private static String newKey() {
        byte[] bytes = new byte[16];
        new java.security.SecureRandom().nextBytes(bytes);
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    /**
     * window.AgentTavernAndroid: story archives go to Downloads (web/app.js saveFile); retry and copy on error pages;
     * installUpdate / cancelUpdate / updateState for 设置 → 更多 → 更新 (web/update.js, ApkUpdate). Every call
     * needs this launch's key (bridgeKey); without it nothing happens.
     */
    private final class Bridge {
        private boolean allowed(String key) {
            return bridgeKey.equals(key);
        }

        @JavascriptInterface
        public void retry(String key) {
            if (allowed(key)) main.post(MainActivity.this::start);
        }

        /** After the renderer went (rendererGone): the app again, the server never stopped. */
        @JavascriptInterface
        public void reopen(String key) {
            if (allowed(key)) main.post(MainActivity.this::openApp);
        }

        @JavascriptInterface
        public void copy(String key, String text) {
            if (!allowed(key)) return;
            main.post(() -> {
                android.content.ClipboardManager clipboard = getSystemService(android.content.ClipboardManager.class);
                clipboard.setPrimaryClip(ClipData.newPlainText("CicaTavern 报错", text));
                android.widget.Toast.makeText(MainActivity.this, "已复制", android.widget.Toast.LENGTH_SHORT).show();
            });
        }

        @JavascriptInterface
        public boolean installUpdate(String key, String url, String sha256) {
            return allowed(key) && update.start(url, sha256);
        }

        @JavascriptInterface
        public void cancelUpdate(String key) {
            if (allowed(key)) update.cancel();
        }

        @JavascriptInterface
        public String updateState(String key) {
            return allowed(key) ? update.state() : "{\"step\":\"idle\"}";
        }

        @JavascriptInterface
        public boolean saveFile(String key, String name, String text) {
            if (!allowed(key)) return false;
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) return false;
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                if (out == null) return false;
                out.write(text.getBytes(StandardCharsets.UTF_8));
                return true;
            } catch (Exception e) {
                getContentResolver().delete(uri, null, null);
                return false;
            }
        }
    }
}
