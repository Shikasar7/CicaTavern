package app.cicatavern;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.text.TextUtils;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
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
    private static final long START_TIMEOUT_MS = 60_000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private ValueCallback<Uri[]> pendingChooser;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // chrome://inspect from a computer the phone has authorised for USB debugging; a personal build.
        WebView.setWebContentsDebuggingEnabled(true);

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
            : "<p><button onclick='AgentTavernAndroid.retry()'>重试</button>";
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
            + "<style>body{font:16px/1.6 system-ui,sans-serif;margin:24px;color:#ddd;background:#111}"
            + "@media(prefers-color-scheme:light){body{color:#222;background:#fafafa}}"
            + "pre{white-space:pre-wrap;word-break:break-all;font-size:12px;opacity:.8;user-select:text}"
            + "button{font:inherit;padding:8px 18px;margin-right:8px;border-radius:8px;border:1px solid #888;background:transparent;color:inherit}</style>"
            + "<h3>" + TextUtils.htmlEncode(title) + "</h3>"
            + (failed ? retry
                + "<button onclick='AgentTavernAndroid.copy(document.querySelector(\"pre\").innerText)'>复制报错</button></p>" : "")
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
    protected void onDestroy() {
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

    /** Only the local server opens inside the app; any other link goes to the browser. */
    private final class LocalOnlyClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if ("127.0.0.1".equals(uri.getHost())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) {
                // Nothing can open it.
            }
            return true;
        }
    }

    /** <input type=file>: the system picker; images only when the page asks only for images (reference pictures), else any file (card PNGs, JSON). */
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

    /** window.AgentTavernAndroid: story archives go to Downloads (web/app.js saveFile); retry and copy on error pages. */
    private final class Bridge {
        @JavascriptInterface
        public void retry() {
            main.post(MainActivity.this::start);
        }

        @JavascriptInterface
        public void copy(String text) {
            main.post(() -> {
                android.content.ClipboardManager clipboard = getSystemService(android.content.ClipboardManager.class);
                clipboard.setPrimaryClip(ClipData.newPlainText("CicaTavern 报错", text));
                android.widget.Toast.makeText(MainActivity.this, "已复制", android.widget.Toast.LENGTH_SHORT).show();
            });
        }

        @JavascriptInterface
        public boolean saveFile(String name, String text) {
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
