package io.github.linuxcockpit.client;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsAnimation;
import android.view.WindowInsetsController;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Cockpit 安卓客户端：一个全屏 WebView，直接打开宿主（本机 Termux 里的无头宿主，或局域网电脑）托管的网页。
 * 前端全部来自宿主，所以宿主更新后这里不用重新打包；原生侧只补浏览器给不了的东西：
 * 连接设置、文件选择、后台保活、原生剪贴板 / 外部链接、系统栏配色、返回键关弹窗。
 *
 * 与网页的通信（{@link Bridge}）：
 * - 页面 → 原生：`CockpitAndroid.call(id, method, argsJson)` 异步调用，结果经
 *   `window.__cockpitNative.reply(id, ok, json)` 回到页面（web-shim 包装成 `window.cockpit.client`）；
 * - 原生 → 页面：`window.__cockpitNative.event(name, json)`，页面就绪（shim 调 `ready`）前排队；
 * - 文件不经过页面：原生直接流式上传到宿主 `/api/upload`（{@link Uploader}），只把宿主路径交给页面。
 */
public class MainActivity extends Activity {
    static final String PREFS = "cockpit";
    static final String DEFAULT_URL = "http://127.0.0.1:47810";
    private static final String CONNECT_PAGE = "file:///android_asset/connect.html";
    private static final int REQ_FILE = 1;
    private static final int REQ_NOTIFY = 2;
    private static final int REQ_PICK = 3;

    private FrameLayout root;
    private WebView web;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> fileCallback;
    /** 连接页要显示的错误（下次 state() 取走） */
    private String pendingError = "";
    /** 深链接带来的预填值（只预填，必须用户自己点「连接」） */
    private JSONObject prefill;
    /** 当前宿主 origin（只有它和连接页能在 WebView 里打开，其余交给系统浏览器） */
    private String hostOrigin = "";
    /** 宿主页面的 shim 已就绪（调过 ready），之前的事件排队 */
    private boolean pageReady = false;
    private final List<String[]> pendingEvents = new ArrayList<>();
    /** 进行中的 pickFiles 调用 id（一次只允许一个） */
    private String pickCallId;
    /** 别的应用「分享」进来、还没交给页面的内容 */
    private final List<Uri> sharedUris = new ArrayList<>();
    private String sharedText = "";
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    /** 探测 / 页面加载时的原生转圈（盖在网页加载之上，用户看得到"在连"） */
    private ProgressBar spinner;
    /** 连接尝试代号：新的一次尝试让旧探测的回调作废（用户换了目标 / 打开连接页 / 页面销毁） */
    private int probeSeq = 0;
    /** 正在探测的目标签名（url + token）：同一目标不重复连接 */
    private String pendingConnect;
    /** 最近一次「静止」时量到的 IME 高度，>0 = 键盘弹着（API 30+ 以 isVisible 为准） */
    private int imeRestBottom = 0;
    /** 键盘动画进行中：这期间不改 padding，只平移 WebView */
    private boolean imeAnimating = false;

    /** 关网页弹窗 / 菜单：找到一个激活的 overlay，朝当前焦点发 Escape */
    private static final String JS_DISMISS_OVERLAY =
            "(function(){var o=document.querySelectorAll('.v-overlay--active:not(.v-snackbar):not(.v-tooltip)');"
                    + "if(!o.length)return false;var t=document.activeElement||document.body;"
                    + "t.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,bubbles:true}));"
                    + "return true})()";

    /**
     * 系统栏跟随网页主题：MutationObserver 盯 class/style，用 requestAnimationFrame 合并
     * （一帧最多通知一次），替换原来的 setInterval(…, 1000) 每秒轮询。
     * 5 秒的慢同步只是兜底（主题变了却没碰 html/body 属性时补上）。
     */
    private static final String JS_THEME_OBSERVER =
            "(function(){if(window.__cockpitBar)return;window.__cockpitBar=1;var last='',raf=0;"
                    + "function send(){raf=0;try{var c=getComputedStyle(document.documentElement).backgroundColor;"
                    + "if(c&&c!==last){last=c;CockpitAndroid.setBarColor(c)}}catch(e){}}"
                    + "function tick(){if(raf)return;raf=requestAnimationFrame(send)}"
                    + "new MutationObserver(tick).observe(document.documentElement,"
                    + "{attributes:true,attributeFilter:['class','style']});"
                    + "new MutationObserver(tick).observe(document.body,"
                    + "{attributes:true,attributeFilter:['class','style']});"
                    + "setInterval(tick,5000);send()})()";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(0x12, 0x12, 0x12));
        setContentView(root);
        setupInsets();
        createSpinner();
        createWebView();

        boolean restored = false;
        if (savedInstanceState != null && web.restoreState(savedInstanceState) != null) {
            // 恢复上次的页面回来。**恢复不能吞掉本次启动带来的深链接 / 分享**：
            // 它们照常在下面 handleIntent 里处理（深链接直接开连接页，分享等页面 ready 再交）。
            hostOrigin = originOf(prefs.getString("url", DEFAULT_URL));
            pageReady = false;
            restored = true;
        }
        setupBackHandling();
        boolean handled = handleIntent(getIntent());
        if (!handled && !restored) {
            if (!prefs.getString("url", "").isEmpty()) connect();
            else showConnect("");
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    /** linuxcockpit://connect?url=…&token=… 只预填连接页；启动器快捷方式「连接设置」打开连接页 */
    private boolean handleIntent(Intent intent) {
        if (intent == null) return false;
        Uri data = intent.getData();
        if (data != null && "linuxcockpit".equals(data.getScheme())) {
            prefill = new JSONObject();
            try {
                String u = data.getQueryParameter("url");
                String t = data.getQueryParameter("token");
                if (u != null) prefill.put("url", u);
                if (t != null) prefill.put("token", t);
            } catch (JSONException ignored) {
            }
            showConnect("");
            setIntent(new Intent(this, MainActivity.class));
            return true;
        }
        if ("io.github.linuxcockpit.client.CONNECT_SETTINGS".equals(intent.getAction())) {
            showConnect("");
            setIntent(new Intent(this, MainActivity.class));
            return true;
        }
        if (Intent.ACTION_SEND.equals(intent.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            collectShare(intent);
            setIntent(new Intent(this, MainActivity.class));
            // 不占用这次启动：照常连接；页面就绪后再交给它（已就绪则立刻交）
            if (pageReady) deliverShare();
            return false;
        }
        return false;
    }

    @SuppressWarnings("deprecation")
    private void collectShare(Intent intent) {
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) sharedUris.addAll(list);
        } else {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) sharedUris.add(u);
        }
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text != null && text.length() > 0)
            sharedText = sharedText.isEmpty() ? text.toString() : sharedText + "\n" + text;
    }

    /** 分享的文件先传到宿主，再以 `shared` 事件交给页面（{paths, text}） */
    private void deliverShare() {
        if (sharedUris.isEmpty() && sharedText.isEmpty()) return;
        final List<Uri> uris = new ArrayList<>(sharedUris);
        final String text = sharedText;
        sharedUris.clear();
        sharedText = "";
        final String base = trimSlash(prefs.getString("url", DEFAULT_URL));
        final String token = prefs.getString("token", "");
        io.execute(() -> {
            JSONObject ev = new JSONObject();
            try {
                List<String> paths = Uploader.uploadAll(getContentResolver(), base, token, uris,
                        (i, n, pct, name) -> emitProgress(i, n, pct, name, "share"));
                ev.put("paths", new JSONArray(paths));
                ev.put("text", text);
            } catch (Exception e) {
                try {
                    ev.put("paths", new JSONArray());
                    ev.put("text", text);
                    ev.put("error", String.valueOf(e.getMessage()));
                } catch (JSONException ignored) {
                }
            }
            emit("shared", ev);
        });
    }

    // ---------------------------------------------------------------- 窗口 / 系统栏

    private void setupInsets() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R)
            return; // Android 8–10：系统自己留出系统栏，adjustResize 处理键盘
        // 统一走 edge-to-edge（targetSdk 35 在 Android 15 上强制），自己按系统栏 + 键盘留白：
        // WebView 的可见区域就是真正能用的区域，网页里的 --app-vh 量到的也是它
        w.setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            // Apply the final layout before onStart; progress only transforms the WebView.
            if (!imeAnimating) applySettledInsets(insets);
            return WindowInsets.CONSUMED;
        });
        // Android 11+：键盘弹起 / 收起走 WindowInsetsAnimationCallback——动画中只平移 WebView
        // （translation，不重排），动画结束（含取消 / 被打断 / 旋转）才把最终 padding 落下去再清零。
        root.setWindowInsetsAnimationCallback(new WindowInsetsAnimation.Callback(WindowInsetsAnimation.Callback.DISPATCH_MODE_STOP) {
            /** 动画开始时 root 的底 padding，即内容的起始底边 */
            private int startPadding;
            private int endPadding;
            private WindowInsetsAnimation activeIme;

            @Override
            public void onPrepare(WindowInsetsAnimation animation) {
                if ((animation.getTypeMask() & WindowInsets.Type.ime()) == 0) return;
                activeIme = animation;
                imeAnimating = false;
                startPadding = root.getPaddingBottom();
            }

            @Override
            public WindowInsetsAnimation.Bounds onStart(WindowInsetsAnimation animation,
                    WindowInsetsAnimation.Bounds bounds) {
                if (animation != activeIme) return bounds;
                imeAnimating = true;
                endPadding = root.getPaddingBottom();
                web.setTranslationY(endPadding - startPadding);
                return bounds;
            }

            @Override
            public WindowInsets onProgress(WindowInsets insets, List<WindowInsetsAnimation> running) {
                boolean hasIme = false;
                for (WindowInsetsAnimation a : running)
                    if (a == activeIme) hasIme = true;
                if (hasIme) {
                    int cur = insets.getInsets(WindowInsets.Type.ime()).bottom;
                    int bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()).bottom;
                    // 目标底边 = 窗口底 - max(系统栏, 当前键盘高度)；现在底边 = 窗口底 - startPadding
                    web.setTranslationY(endPadding - Math.max(bars, cur));
                }
                return insets;
            }

            @Override
            public void onEnd(WindowInsetsAnimation animation) {
                if (animation != activeIme) return;
                activeIme = null;
                imeAnimating = false;
                WindowInsets finalInsets = root.getRootWindowInsets();
                if (finalInsets != null) applySettledInsets(finalInsets);
                web.setTranslationY(0f);
                root.requestApplyInsets(); // 用静止下来的最终 inset 重算 padding
            }
        });
    }

    /** 键盘没动的时候：按系统栏 + 当前键盘高度设置 root padding（也是动画结束后的最终态） */
    private void applySettledInsets(WindowInsets insets) {
        Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
        Insets ime = insets.getInsets(WindowInsets.Type.ime());
        imeRestBottom = ime.bottom;
        root.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
    }

    // ---------------------------------------------------------------- 加载指示

    /** 原生转圈：探测 /api/info 与宿主页面加载期间显示，用户知道"正在连"而不是白屏 */
    private void createSpinner() {
        if (spinner != null) return;
        spinner = new ProgressBar(this);
        spinner.setContentDescription(getString(R.string.loading));
        spinner.setVisibility(View.GONE);
        root.addView(spinner, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
    }

    void showLoading(boolean on) {
        if (spinner != null) spinner.setVisibility(on ? View.VISIBLE : View.GONE);
    }

    // ---------------------------------------------------------------- 返回键

    /** Android 13+ 用 OnBackInvokedCallback；旧系统走 {@link #onBackPressed()} */
    private void setupBackHandling() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            OnBackInvokedCallback cb = this::onBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb);
        }
    }

    /**
     * 返回键：先收键盘（键盘开着就只收，不让网页收到 Escape），
     * 再关网页弹窗 / 菜单，再后退，最后退到后台（连接不断）。
     */
    void onBack() {
        if (imeVisible()) {
            hideIme();
            return;
        }
        web.evaluateJavascript(JS_DISMISS_OVERLAY, handled -> {
            if ("true".equals(handled)) return;
            if (web.canGoBack()) web.goBack();
            else moveTaskToBack(true);
        });
    }

    private boolean imeVisible() {
        WindowInsets ri = root.getRootWindowInsets();
        if (ri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
            return ri.isVisible(WindowInsets.Type.ime());
        return imeRestBottom > 0;
    }

    private void hideIme() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) c.hide(WindowInsets.Type.ime());
            return;
        }
        View focus = getCurrentFocus();
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(
                (focus != null ? focus : web).getWindowToken(), 0);
    }

    /** 系统栏跟随网页背景色（主题），浅色背景用深色图标 */
    void applyBarColor(int color) {
        root.setBackgroundColor(color);
        Window w = getWindow();
        boolean light = luminance(color) > 0.6;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(light ? mask : 0, mask);
            }
        } else {
            w.setStatusBarColor(color);
            w.setNavigationBarColor(color);
            int flags = w.getDecorView().getSystemUiVisibility();
            flags = light ? (flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR)
                    : (flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
            w.getDecorView().setSystemUiVisibility(flags);
        }
    }

    private static double luminance(int c) {
        return (0.299 * Color.red(c) + 0.587 * Color.green(c) + 0.114 * Color.blue(c)) / 255.0;
    }

    // ---------------------------------------------------------------- WebView

    private void createWebView() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
        }
        web = new WebView(this);
        // index 0：转圈进度条（createSpinner 加的）永远盖在网页上面
        root.addView(web, 0, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG); // chrome://inspect 做性能分析

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // 播放器引擎由宿主推送指令开始播放，没有用户手势
        s.setMediaPlaybackRequiresUserGesture(false);
        // 布局按网页自己的缩放设置，不吃系统字体放大
        s.setTextZoom(100);
        // 页面缩放保持关闭：捏合手势留给网页自己的画布（ft 等），WebView 不抢
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " CockpitAndroid/" + BuildConfig.VERSION_NAME);

        web.addJavascriptInterface(new Bridge(), "CockpitAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, ua, cd, mime, len) -> openExternal(url));
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            String url = req.getUrl().toString();
            if (url.startsWith(CONNECT_PAGE)) return false;
            if (!hostOrigin.isEmpty() && hostOrigin.equals(originOf(url))) return false;
            openExternal(url);
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (!req.isForMainFrame()) return;
            showConnect(getString(R.string.err_disconnected) + "（" + err.getDescription() + "）");
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            if (url.startsWith(CONNECT_PAGE)) return;
            // 页面（重新）加载：等新页面的 shim 再调 ready 才发事件，期间显示原生转圈
            pageReady = false;
            showLoading(true);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            showLoading(false);
            if (url.startsWith(CONNECT_PAGE)) {
                applyBarColor(Color.rgb(0x12, 0x12, 0x12));
                return;
            }
            // 主题在运行中切换：MutationObserver 看 class/style 变更 + requestAnimationFrame
            // 合并（一帧最多通知一次），不再每秒轮询。兜底的低频慢同步留给不用属性变更的改法。
            view.evaluateJavascript(JS_THEME_OBSERVER, null);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // 渲染进程崩溃 / 被系统回收：默认会带着整个应用一起退出；换一个新 WebView 重连
            createWebView();
            connect();
            return true;
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = cb;
            Intent intent = params.createIntent();
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE)
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(intent, REQ_FILE);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK) {
            onPicked(resultCode, data);
            return;
        }
        if (requestCode != REQ_FILE || fileCallback == null) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) result[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    // ---------------------------------------------------------------- 连接

    void showConnect(String error) {
        pendingError = error == null ? "" : error;
        hostOrigin = "";
        pageReady = false;
        probeSeq++; // 让还在探测中的回调作废（它属于上一次尝试）
        pendingConnect = null;
        showLoading(false);
        web.loadUrl(CONNECT_PAGE);
    }

    /** 先在原生侧探一次 /api/info：宿主没开 / token 不对时给出明确提示，而不是一张白页 */
    void connect() {
        final String base = trimSlash(prefs.getString("url", DEFAULT_URL));
        final String token = prefs.getString("token", "");
        final String sig = base + "\n" + token;
        if (sig.equals(pendingConnect)) return; // 同一目标正在探测：不重复连接
        pendingConnect = sig;
        final int seq = ++probeSeq;
        showLoading(true);
        if (prefs.getBoolean("keepAlive", true)) startKeepAlive();
        else stopService(new Intent(this, KeepAliveService.class));
        new Thread(() -> {
            String err = probe(base, token);
            runOnUiThread(() -> {
                if (seq != probeSeq) return; // 用户换了目标 / 打开连接页 / 页面已销毁：过期结果丢弃
                pendingConnect = null;
                showLoading(false);
                if (err != null) {
                    showConnect(err);
                    return;
                }
                hostOrigin = originOf(base);
                pageReady = false;
                String q = token.isEmpty() ? "" : "/?token=" + enc(token);
                web.loadUrl(base + q); // 真正的加载进度接着由 onPageStarted / onPageFinished 显示
            });
        }).start();
    }

    private String probe(String base, String token) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(base + "/api/info").openConnection();
            c.setConnectTimeout(4000);
            c.setReadTimeout(4000);
            if (!token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
            int code = c.getResponseCode();
            if (code == 401) return getString(R.string.err_token);
            if (code / 100 != 2) return getString(R.string.err_http) + " " + code;
            return null;
        } catch (Exception e) {
            return getString(R.string.err_unreachable);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void startKeepAlive() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        try {
            startForegroundService(new Intent(this, KeepAliveService.class));
        } catch (Exception ignored) {
            // 后台时系统不允许启动前台服务：下次回到前台再试
        }
    }

    // ---------------------------------------------------------------- 生命周期

    @Override
    protected void onPause() {
        super.onPause();
        // 保活开着时不暂停 WebView：播放器 / SSE 在后台继续
        if (!prefs.getBoolean("keepAlive", true)) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        probeSeq++; // 丢弃还没回来的探测结果，别让它动已销毁的界面
        pendingConnect = null;
        showLoading(false);
        stopService(new Intent(this, KeepAliveService.class));
        io.shutdownNow();
        web.destroy();
        super.onDestroy();
    }

    /** Android 12 及以下的返回键（13+ 由 setupBackHandling 注册的 OnBackInvokedCallback 处理） */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return;
        onBack();
    }

    // ---------------------------------------------------------------- 原生调用（RPC）

    /** 页面 → 原生的异步调用；在 JavaBridge 线程上进来，耗时的转到 io 线程 / 主线程 */
    private void dispatch(String id, String method, JSONObject args) {
        try {
            switch (method) {
                case "ready":
                    runOnUiThread(() -> {
                        pageReady = true;
                        for (String[] ev : pendingEvents) sendEvent(ev[0], ev[1]);
                        pendingEvents.clear();
                        deliverShare();
                    });
                    reply(id, true, new JSONObject());
                    return;
                case "info": {
                    JSONObject o = new JSONObject();
                    o.put("version", BuildConfig.VERSION_NAME);
                    o.put("versionCode", BuildConfig.VERSION_CODE);
                    o.put("sdk", Build.VERSION.SDK_INT);
                    o.put("device", Build.MANUFACTURER + " " + Build.MODEL);
                    o.put("url", prefs.getString("url", DEFAULT_URL));
                    o.put("keepAlive", prefs.getBoolean("keepAlive", true));
                    reply(id, true, o);
                    return;
                }
                case "settings.set": {
                    if (args.has("keepAlive")) {
                        boolean on = args.getBoolean("keepAlive");
                        prefs.edit().putBoolean("keepAlive", on).apply();
                        runOnUiThread(() -> {
                            if (on) startKeepAlive();
                            else stopService(new Intent(this, KeepAliveService.class));
                        });
                    }
                    JSONObject o = new JSONObject();
                    o.put("keepAlive", prefs.getBoolean("keepAlive", true));
                    reply(id, true, o);
                    return;
                }
                case "openConnect":
                    runOnUiThread(() -> showConnect(""));
                    reply(id, true, new JSONObject());
                    return;
                case "pickFiles":
                    runOnUiThread(() -> startPick(id, args.optBoolean("multiple", false)));
                    return;
                default:
                    reply(id, false, errorJson("unknown method: " + method));
            }
        } catch (Exception e) {
            reply(id, false, errorJson(String.valueOf(e.getMessage())));
        }
    }

    private void startPick(String id, boolean multiple) {
        if (pickCallId != null) {
            reply(id, false, errorJson("busy"));
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        if (multiple) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        pickCallId = id;
        try {
            startActivityForResult(intent, REQ_PICK);
        } catch (ActivityNotFoundException e) {
            pickCallId = null;
            reply(id, false, errorJson("no file picker"));
        }
    }

    private void onPicked(int resultCode, Intent data) {
        final String id = pickCallId;
        pickCallId = null;
        if (id == null) return;
        final List<Uri> uris = new ArrayList<>();
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
            else if (data.getData() != null) uris.add(data.getData());
        }
        if (uris.isEmpty()) {
            try {
                reply(id, true, new JSONObject().put("paths", new JSONArray()));
            } catch (JSONException ignored) {
            }
            return;
        }
        final String base = trimSlash(prefs.getString("url", DEFAULT_URL));
        final String token = prefs.getString("token", "");
        io.execute(() -> {
            try {
                List<String> paths = Uploader.uploadAll(getContentResolver(), base, token, uris,
                        (i, n, pct, name) -> emitProgress(i, n, pct, name, id));
                reply(id, true, new JSONObject().put("paths", new JSONArray(paths)));
            } catch (Exception e) {
                reply(id, false, errorJson(String.valueOf(e.getMessage())));
            }
        });
    }

    private void emitProgress(int index, int total, int pct, String name, String call) {
        try {
            JSONObject o = new JSONObject();
            o.put("index", index);
            o.put("total", total);
            o.put("pct", pct);
            o.put("name", name);
            o.put("call", call);
            emit("upload-progress", o);
        } catch (JSONException ignored) {
        }
    }

    private static JSONObject errorJson(String msg) {
        JSONObject o = new JSONObject();
        try {
            o.put("error", msg);
        } catch (JSONException ignored) {
        }
        return o;
    }

    private void reply(String id, boolean ok, JSONObject data) {
        String js = "window.__cockpitNative&&window.__cockpitNative.reply(" + JSONObject.quote(id) + ","
                + ok + "," + data + ")";
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    /** 原生 → 页面事件；页面没就绪（还在连接页 / 宿主页面加载中）时排队 */
    void emit(String name, JSONObject data) {
        runOnUiThread(() -> {
            if (pageReady) sendEvent(name, data.toString());
            else pendingEvents.add(new String[]{name, data.toString()});
        });
    }

    private void sendEvent(String name, String json) {
        web.evaluateJavascript("window.__cockpitNative&&window.__cockpitNative.event("
                + JSONObject.quote(name) + "," + json + ")", null);
    }

    // ---------------------------------------------------------------- 网页可用的原生能力

    private class Bridge {
        /** 通用异步调用（见类注释）；argsJson 为 JSON 对象文本 */
        @JavascriptInterface
        public void call(String id, String method, String argsJson) {
            JSONObject args;
            try {
                args = argsJson == null || argsJson.isEmpty() ? new JSONObject() : new JSONObject(argsJson);
            } catch (JSONException e) {
                args = new JSONObject();
            }
            dispatch(id, method, args);
        }

        /** 连接页：已保存的设置 + 待显示的错误 + 深链接预填 */
        @JavascriptInterface
        public String state() {
            JSONObject o = new JSONObject();
            try {
                o.put("url", prefs.getString("url", DEFAULT_URL));
                o.put("token", prefs.getString("token", ""));
                o.put("keepAlive", prefs.getBoolean("keepAlive", true));
                o.put("error", pendingError);
                o.put("version", BuildConfig.VERSION_NAME);
                if (prefill != null) o.put("prefill", prefill);
            } catch (JSONException ignored) {
            }
            pendingError = "";
            prefill = null;
            return o.toString();
        }

        @JavascriptInterface
        public void connect(String url, String token, boolean keepAlive) {
            prefs.edit()
                    .putString("url", trimSlash(url.trim()))
                    .putString("token", token.trim())
                    .putBoolean("keepAlive", keepAlive)
                    .apply();
            runOnUiThread(MainActivity.this::connect);
        }

        /** 网页里的「切换宿主」入口 */
        @JavascriptInterface
        public void openConnect() {
            runOnUiThread(() -> showConnect(""));
        }

        @JavascriptInterface
        public void copyText(String text) {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("Cockpit", text));
        }

        @JavascriptInterface
        public String pasteText() {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            CharSequence t = clip.getItemAt(0).coerceToText(MainActivity.this);
            return t == null ? "" : t.toString();
        }

        @JavascriptInterface
        public void openExternal(String url) {
            runOnUiThread(() -> MainActivity.this.openExternal(url));
        }

        @JavascriptInterface
        public void setBarColor(String css) {
            int color = parseCssColor(css);
            if (color != 0) runOnUiThread(() -> applyBarColor(color));
        }

        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }
    }

    void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException ignored) {
        }
    }

    // ---------------------------------------------------------------- 小工具

    static String trimSlash(String s) {
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    static String originOf(String url) {
        try {
            Uri u = Uri.parse(url);
            if (u.getScheme() == null || u.getHost() == null) return "";
            int port = u.getPort();
            return u.getScheme() + "://" + u.getHost() + (port > 0 ? ":" + port : "");
        } catch (Exception e) {
            return "";
        }
    }

    static String enc(String s) {
        try {
            return URLEncoder.encode(s, StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return s;
        }
    }

    /** rgb(r, g, b) / rgba(r, g, b, a)；透明返回 0（不改） */
    static int parseCssColor(String css) {
        if (css == null) return 0;
        String[] p = css.replaceAll("[^0-9.,]", "").split(",");
        if (p.length < 3) return 0;
        try {
            if (p.length >= 4 && Float.parseFloat(p[3]) < 0.5f) return 0;
            return Color.rgb(Math.round(Float.parseFloat(p[0])),
                    Math.round(Float.parseFloat(p[1])), Math.round(Float.parseFloat(p[2])));
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
