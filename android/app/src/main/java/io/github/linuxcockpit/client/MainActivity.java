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
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.DocumentsContract;
import android.text.InputType;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.ClientCertRequest;
import android.webkit.HttpAuthHandler;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.SSLException;

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
    private static final int REQ_DIR = 4;
    private static final int REQ_MIC = 5;
    /** 网页的麦克风请求（语音输入）：等系统录音权限的结果 */
    private PermissionRequest pendingMic;
    /** 等着用户在系统 KeyChain 里挑客户端证书的请求（mTLS，弹窗开着时的那个）；WebView 换了就作废 */
    private ClientCertRequest pendingCertRequest;
    /** 客户端证书这条路的现场记录：选了什么、发的链有几级、卡在哪——出错时摆到连接页 */
    private String certDiag = "";
    /**
     * 本进程是否已经走过一次 requestPermissions(RECORD_AUDIO)。MIUI / HyperOS 等 ROM 在系统权限之外
     * 还有一层自己的管控：在设置里手动打开后 checkSelfPermission 已经是 GRANTED，但不经过一次
     * 运行时申请，录音照样被拦（表现为「没有麦克风权限」）。所以每个进程第一次用麦克风前都申请一次——
     * 原生 Android 上已授权时这个调用立刻返回，不弹窗。
     */
    boolean micAsked;

    private FrameLayout root;
    /** 打开着的网页登录页（webLogin RPC）；同一时间最多一个 */
    private WebLogin webLogin;
    private WebView web;
    /** 系统媒体控制（通知栏 / 锁屏）；页面经 media.update 驱动 */
    private MediaBridge media;
    /** 系统 TTS / 语音识别（0.8.0） */
    private SpeechBridge speech;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> fileCallback;
    /** 连接页要显示的错误（下次 state() 取走） */
    private String pendingError = "";
    /** 深链接带来的预填值（只预填，必须用户自己点「连接」） */
    private JSONObject prefill;
    /** 当前宿主 origin（只有它和连接页能在 WebView 里打开，其余交给系统浏览器） */
    private String hostOrigin = "";
    /**
     * 代理流程中（0.9.0）：服务器重定向把页面带离了宿主 origin——典型是 forward_auth 先去登录门户。
     * 这期间页面脚本发起的导航（门户登录成功后 location.replace 回跳）也留在 App 内，
     * 回到宿主 origin 时由 {@link Client#onPageFinished} 清除。
     */
    private boolean proxyFlow = false;
    /** 代理认证对话框开着：防重入（同一挑战可能来多次，别叠对话框） */
    private boolean authShowing = false;
    /** 开着的代理认证对话框（showConnect / reauth 时撤掉：页面都要换了，别再问） */
    private android.app.AlertDialog authDialog;
    /** 待显示的代理认证挑战（host + realm），对话框关掉后才用 */
    private String[] pendingAuth;
    /**
     * 同一轮加载里已经自动 proceed 过几次（存过的凭据被代理拒了会再挑战一次）。
     * 上限 2：超过就改弹窗问用户，否则错误的凭据会让 WebView 无限重试。
     */
    private int autoAuthTries = 0;
    /** 宿主页面的 shim 已就绪（调过 ready），之前的事件排队 */
    private boolean pageReady = false;
    private final List<String[]> pendingEvents = new ArrayList<>();
    /** 进行中的 pickFiles 调用 id（一次只允许一个） */
    private String pickCallId;
    /** 进行中的 pickDirectory 调用 id（与 pickFiles 互斥） */
    private String dirCallId;
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

    // ---------------------------------------------------------------- 代理认证 / 重认证（0.9.0）
    /** 重认证节流：并发 401 只触发一次，短窗口内不重复 reload */
    private static final long REAUTH_THROTTLE_MS = 30_000;
    /** 重认证没治好的次数上限：超过就停手，回连接页让用户手动处理 */
    private static final int REAUTH_MAX = 3;
    /**
     * 重认证「观察期」：重认证之后这么久没再触发下一次，就认为治好了（计数归零）。
     * 没有它就麻烦了：一个用很久的会话会隔三差五过期，计数只增不减，迟早误触发降级。
     */
    private static final long REAUTH_HEALTHY_MS = 20_000;
    /** 门户页面停留超时：这么久没回到宿主 origin 就降级到连接页 */
    private static final long PORTAL_TIMEOUT_MS = 120_000;
    /** 最近一次 reauth 的时间戳（uptimeMillis）；0 = 没有过 */
    private long lastReauthAt = 0;
    /** 连续重认证失败计数（每次 reauth +1，观察期内没再犯就归零） */
    private int reauthFails = 0;
    /** reauth 序号：观察期回调只认最新的一次（中途又触发过就作废） */
    private int reauthSeq = 0;
    /** 门户超时 / 重认证观察期的定时器（Handler 而不是 WebView.postDelayed：撤得干净） */
    private final Handler timer = new Handler(Looper.getMainLooper());
    /** 门户停留超时的 runnable（proxyFlow 时挂着，回宿主 origin 或关连接页时撤掉） */
    private final Runnable portalTimeout = this::onPortalTimeout;

    /** 关网页弹窗 / 菜单：找到一个激活的 overlay，朝当前焦点发 Escape */
    private static final String JS_DISMISS_OVERLAY =
            "(function(){var o=document.querySelectorAll('.v-overlay--active:not(.v-snackbar):not(.v-tooltip)');"
                    + "if(!o.length)return false;var t=document.activeElement||document.body;"
                    + "t.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,bubbles:true}));"
                    + "return true})()";

    /**
     * 问页面的返回链（back-nav.ts 装的 window.__cockpitBack）：
     * 1 = 页面消化了这次返回（关了浮层 / 弹了 ability 内部层级 / 切了 ability）；
     * 0 = 已在返回链根上（Java 侧双击退出）；其它（含桥没就绪）= 走旧行为兜底。
     */
    private static final String JS_BACK_QUERY =
            "(function(){var f=window.__cockpitBack;if(!f)return 2;var r=f();"
                    + "return r==='handled'?1:(r==='root'?0:2)})()";

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
        media = new MediaBridge(this);
        speech = new SpeechBridge(this);

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

    /**
     * 外部进来的 intent：
     * <ul>
     *   <li>{@code linuxcockpit://connect?url=…&token=…} 只预填连接页；启动器快捷方式「连接设置」打开连接页；</li>
     *   <li>{@code linuxcockpit://open?ability=…&target=…} 跳到某个能力页（桌面快捷方式用；页面没就绪时排队）；</li>
     *   <li>{@code linuxcockpit://pin?package=…|ability=…&label=…&icon=…} 请求固定桌面快捷方式
     *       （Termux 里 {@code termux-open-url} 就能触发，YAYA 的安卓插件用它）。</li>
     * </ul>
     * open / pin 不占用这次启动：照常连接宿主。
     */
    private boolean handleIntent(Intent intent) {
        if (intent == null) return false;
        Uri data = intent.getData();
        if (data != null && "linuxcockpit".equals(data.getScheme()) && "open".equals(data.getHost())) {
            String ability = data.getQueryParameter("ability");
            if (ability != null && !ability.isEmpty()) {
                try {
                    JSONObject o = new JSONObject();
                    o.put("ability", ability);
                    String target = data.getQueryParameter("target");
                    if (target != null && !target.isEmpty()) o.put("target", new JSONObject(target));
                    emit("open", o);
                } catch (JSONException ignored) {
                }
            }
            setIntent(new Intent(this, MainActivity.class));
            return false;
        }
        if (data != null && "linuxcockpit".equals(data.getScheme()) && "pin".equals(data.getHost())) {
            final String pkg = data.getQueryParameter("package");
            final String ability = data.getQueryParameter("ability");
            final String label = data.getQueryParameter("label");
            final String iconUrl = data.getQueryParameter("icon");
            io.execute(() -> {
                Bitmap icon = Shortcuts.download(iconUrl);
                runOnUiThread(() -> {
                    String err = Shortcuts.pin(this, ability, null, pkg, label, icon);
                    if (err != null) Toast.makeText(this, err, Toast.LENGTH_LONG).show();
                });
            });
            setIntent(new Intent(this, MainActivity.class));
            return false;
        }
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
        final String proxyAuth = proxyAuthHeader(base);
        io.execute(() -> {
            JSONObject ev = new JSONObject();
            try {
                List<String> paths = Uploader.uploadAll(getContentResolver(), base, token, proxyAuth, uris,
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
        // 统一走 edge-to-edge（targetSdk 35 在 Android 15 上强制）。
        w.setDecorFitsSystemWindows(false);
        // **键盘只有一条缩放路径 = applySettledInsets 的 padding（按 IME 高度给 root 留白）**：
        // 1) 系统侧 adjustNothing——不缩窗、不平移；原「动画期平移 WebView」正是整屏漂移的来源；
        // 2) 页面 meta resizes-content 在系统 WebView 里不生效（真机实测：拆掉 padding 后输入框
        //    不再上浮）——Chrome 靠 meta，我们靠 padding；
        // 3) Manifest 的 adjustResize 在 R+ 被这行运行时覆盖，只对 Android 8–10 保留。
        w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            applySettledInsets(insets);
            return WindowInsets.CONSUMED;
        });
    }

    /**
     * 静止时按系统栏 + 当前键盘高度设置 root padding——**这是本 App 唯一的 IME 缩放路径**：
     * 系统侧 adjustNothing（不缩窗不平移），WebView 的 meta resizes-content 在系统 WebView
     * 里不生效（真机实测：拆掉 padding 后输入框不再上浮），所以抬升只能由这里做。
     * 已不再做动画期平移（那才是「整个 Launcher 漂移」的来源）。
     */
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
     * 返回键：先收键盘（键盘开着就只收，不让网页收到 Escape），再问页面的返回链
     * （`window.__cockpitBack`：关浮层 / ability 内部层级 / 跨 ability 都由页面消化），
     * 到根上双击退出。页面桥没就绪时退回旧行为（关浮层 → WebView 历史 → 后台）。
     */
    void onBack() {
        if (imeVisible()) {
            hideIme();
            return;
        }
        if (webLogin != null) {
            webLogin.back();
            return;
        }
        web.evaluateJavascript(JS_BACK_QUERY, res -> {
            if ("1".equals(res)) return; // 页面消化了这次返回
            if ("0".equals(res)) { // 返回链根上：双击退出
                backOrExit();
                return;
            }
            web.evaluateJavascript(JS_DISMISS_OVERLAY, handled -> {
                if ("true".equals(handled)) return;
                if (web.canGoBack()) web.goBack();
                else moveTaskToBack(true);
            });
        });
    }

    /** 返回链根上的返回键：2s 内第二次按才退出，第一次只提示 */
    private long lastBackAt = 0;

    private void backOrExit() {
        long now = android.os.SystemClock.uptimeMillis();
        if (now - lastBackAt < 2000) {
            finish();
            return;
        }
        lastBackAt = now;
        Toast.makeText(this, R.string.back_again_to_exit, Toast.LENGTH_SHORT).show();
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
        web = new WebView(this) {
            /**
             * 保活开着时，App 切到后台 / 锁屏也让网页以为自己仍然可见。否则 Chromium 会在页面隐藏后
             * 暂停一切带视频轨的媒体（AIDJ 放 mp4 / mkv 时引擎的 <audio> 也算，几秒后就停了；
             * 纯音频不受影响），还会降低定时器 / 渲染进程的优先级。网页侧改由 onResume 的 resume 事件
             * 得知「回到前台」（见 web-shim.ts）。
             */
            @Override
            protected void onWindowVisibilityChanged(int visibility) {
                if (visibility != View.VISIBLE && prefs.getBoolean("keepAlive", true)) {
                    super.onWindowVisibilityChanged(View.VISIBLE);
                    return;
                }
                super.onWindowVisibilityChanged(visibility);
            }
        };
        applyRendererPriority();
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

    /**
     * 后台时 WebView 的渲染进程默认会被降为可回收 / 可冻结的优先级：页面里的流式会话停住、事件流断开。
     * 保活开着时保持「重要」，且不随界面不可见而放弃；关掉保活则恢复系统默认。
     */
    void applyRendererPriority() {
        if (prefs.getBoolean("keepAlive", true))
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        else web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_BOUND, true);
    }

    private class Client extends WebViewClient {
        /**
         * 非宿主 origin 的导航：
         * - 服务器重定向（{@code req.isRedirect()}）即使跳到别的 origin 也留在 WebView——forward_auth
         *   的 302 去登录门户只能这样才走得通；
         * - 代理流程中（{@link #proxyFlow}）页面脚本发起的导航也留着，覆盖门户登录成功后
         *   {@code location.replace} 回跳；
         * - 只有用户点击（既不是重定向、也不在流程中）的站外链接才交系统浏览器。
         *
         * 取舍：宿主是用户自己的服务器，信任它发起的重定向；真正的风险是「用户点了一个恶意页面上的
         * 链接」，而 WebView 里只可能出现宿主 / 连接页 / 上面两类跳转，够用。
         */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            String url = req.getUrl().toString();
            if (url.startsWith(CONNECT_PAGE)) return false;
            if (!hostOrigin.isEmpty() && hostOrigin.equals(originOf(url))) return false;
            if (req.isRedirect() || proxyFlow) return false;
            openExternal(url);
            return true;
        }

        /**
         * 代理层的 basic_auth 挑战（Caddy basic_auth / 别的反向代理）。宿主自己的 token 不走这里
         * （那是 401 + 页面自己处理），所以这个回调几乎只可能是代理。
         * 有存过的凭据就直接带上；否则弹原生对话框问一次，成功后存盘供下次自动用。
         * 密码绝不进日志。
         */
        @Override
        public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
            final String key = authKeyFor(host);
            if (ProxyCreds.has(prefs, key) && autoAuthTries < 2) {
                // 存过的凭据：直接带上，用户不用再输一遍。被拒的话 WebView 会再挑战一次，
                // autoAuthTries 到上限就改弹窗——否则一条错误凭据会让它无限重试下去。
                autoAuthTries++;
                handler.proceed(ProxyCreds.user(prefs, key), ProxyCreds.pass(prefs, key));
                return;
            }
            if (authShowing) { // 已经有一个对话框在问：后来的挑战直接取消，别叠
                handler.cancel();
                return;
            }
            authShowing = true;
            autoAuthTries = 0;
            pendingAuth = new String[]{host, realm == null ? "" : realm};
            showLoading(false);
            runOnUiThread(() -> askProxyAuth(handler));
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (!req.isForMainFrame()) return;
            String d = String.valueOf(err.getDescription());
            // 证书一类的问题说「证书」，别一律「连接断了」
            if (d.contains("ERR_BAD_SSL_CLIENT_AUTH_CERT"))
                showConnect(getString(R.string.err_client_cert) + "（" + d
                        + (certDiag.isEmpty() ? "" : " · " + certDiag) + "）");
            else if (d.contains("ERR_CERT") || d.contains("ERR_SSL"))
                showConnect(getString(R.string.err_tls) + "（" + d + "）");
            else showConnect(getString(R.string.err_disconnected) + "（" + d + "）");
        }

        /**
         * 主文档的 TLS 证书不被信任（自建 CA 没装 / 装错了 / 换了 CA）。默认行为是静默取消，
         * 用户只看到一张空白页。这里把证书详情摆出来让用户决定—— Chrome 也是「高级 → 仍要连接」
         * 这么干的；选「仍要连接」按 host 记住，后续请求直接 proceed，不再逐次问。
         *
         * <p>为什么需要它：Chromium（Chrome）自带证书校验器，和安卓平台的 TrustManager 不是一套；
         * 自建根 CA 的场景下 Chrome 认、WebView（走平台校验 + 本 App 的信任锚）不认是常事。
         * 这是连用户自己的服务器，信任由用户明确点一次头，不默认放行。</p>
         */
        @Override
        public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler, SslError error) {
            String u = error == null ? null : error.getUrl();
            boolean mainDoc = u != null && !hostOrigin.isEmpty() && hostOrigin.equals(originOf(u));
            if (!mainDoc) {
                // 子资源（字体 / 图片）的证书错：已放行过就跟主文档一起放，否则取消
                if (sslBypassed(hostOrigin)) handler.proceed();
                else handler.cancel();
                return;
            }
            String detail = sslErrorDetail(error);
            if (sslBypassed(hostOrigin)) {
                handler.proceed(); // 用户已经为这个 host 点过「仍要连接」
                return;
            }
            showLoading(false);
            new android.app.AlertDialog.Builder(MainActivity.this)
                    .setTitle(R.string.ssl_bypass_title)
                    .setMessage(getString(R.string.ssl_bypass_msg, hostOrigin, detail))
                    .setPositiveButton(R.string.ssl_bypass_ok, (d, w) -> {
                        // 按 host 记住：后续主文档 / 子资源的证书错都直接放行
                        prefs.edit().putString("ssl_bypass", hostOrigin).apply();
                        handler.proceed();
                    })
                    .setNegativeButton(R.string.ssl_bypass_cancel, (d, w) -> {
                        handler.cancel();
                        showConnect(getString(R.string.err_tls) + "（" + detail + "）");
                    })
                    .setOnCancelListener(d -> handler.cancel())
                    .show();
        }

        /** 这个 host 用户点过「仍要连接」吗（连接页换宿主时清掉） */
        private boolean sslBypassed(String origin) {
            return !origin.isEmpty() && origin.equals(prefs.getString("ssl_bypass", ""));
        }

        /** 证书错的原因 + 颁发给谁 / 谁颁发的，摆给用户看 */
        private static String sslErrorDetail(SslError error) {
            int code = error == null ? 0 : error.getPrimaryError();
            String reason;
            switch (code) {
                case SslError.SSL_UNTRUSTED:
                    reason = "证书链不受信任（根 CA 不在手机 / App 的信任列表里）";
                    break;
                case SslError.SSL_IDMISMATCH:
                    reason = "证书主机名与地址不匹配";
                    break;
                case SslError.SSL_EXPIRED:
                    reason = "证书已过期";
                    break;
                case SslError.SSL_NOTYETVALID:
                    reason = "证书尚未生效";
                    break;
                case SslError.SSL_DATE_INVALID:
                    reason = "证书日期无效";
                    break;
                default:
                    reason = "证书无效（错误码 " + code + "）";
            }
            String who = "";
            try {
                android.net.http.SslCertificate c = error == null ? null : error.getCertificate();
                if (c != null) {
                    java.security.cert.X509Certificate x = c.getX509Certificate();
                    if (x != null)
                        who = x.getSubjectX500Principal().getName() + " ← " + x.getIssuerX500Principal().getName();
                }
            } catch (Exception ignored) {
                /* 读不到证书详情就算了，原因已经够用 */
            }
            return who.isEmpty() ? reason : reason + "：" + who;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            if (url.startsWith(CONNECT_PAGE)) return;
            // 页面（重新）加载：等新页面的 shim 再调 ready 才发事件，期间显示原生转圈
            pageReady = false;
            // 旧页面的播放器没了：撤掉媒体卡片，新页面开始播放时会重新推
            if (media != null) media.clear();
            showLoading(true);
            // 离开了宿主 origin：代理流程中（门户登录），门户停留超时开始计时
            if (!hostOrigin.isEmpty() && !hostOrigin.equals(originOf(url))) {
                proxyFlow = true;
                timer.postDelayed(portalTimeout, PORTAL_TIMEOUT_MS);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            showLoading(false);
            timer.removeCallbacks(portalTimeout);
            if (url.startsWith(CONNECT_PAGE)) {
                applyBarColor(Color.rgb(0x12, 0x12, 0x12));
                return;
            }
            if (hostOrigin.isEmpty() || hostOrigin.equals(originOf(url))) {
                proxyFlow = false;
                autoAuthTries = 0; // 回到了宿主页面：上一轮代理挑战结束，重新计数
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

        /**
         * 服务器在 TLS 握手时索要客户端证书（mTLS）。不处理的默认行为是直接取消 → 握手失败
         * （{@code net::ERR_BAD_SSL_CLIENT_AUTH_CERT}），用户只看到错误页；Chrome 则会弹系统
         * KeyChain 选择框。这里和 Chrome 一样走 {@link android.security.KeyChain#choosePrivateKeyAlias}：
         * 用户挑一个已安装的客户端证书就 proceed，取消就 cancel（随后由 {@link #onReceivedError}
         * 报「服务器要求客户端证书」）。API 36 起这个回调在 WebViewClient 上（以前在 WebChromeClient）。
         */
        @Override
        public void onReceivedClientCertRequest(WebView view, ClientCertRequest request) {
            android.util.Log.i("Cockpit", "clientCertRequest host=" + request.getHost()
                    + " port=" + request.getPort()
                    + " keyTypes=" + java.util.Arrays.toString(request.getKeyTypes())
                    + " principals=" + (request.getPrincipals() == null ? 0 : request.getPrincipals().length));
            Toast.makeText(MainActivity.this, R.string.client_cert_picking, Toast.LENGTH_LONG).show();
            if (pendingCertRequest != null) pendingCertRequest.cancel(); // 只保留最新的一次
            pendingCertRequest = request;
            android.security.KeyChain.choosePrivateKeyAlias(
                    MainActivity.this,
                    alias -> {
                        ClientCertRequest req = pendingCertRequest;
                        pendingCertRequest = null;
                        android.util.Log.i("Cockpit", "clientCert alias=" + alias);
                        if (req == null) {
                            android.util.Log.w("Cockpit", "clientCert request stale, dropped");
                            return; // WebView 已经换了：这个请求作废
                        }
                        if (alias == null) {
                            runOnUiThread(req::cancel);
                            return;
                        }
                        // KeyChain.getPrivateKey / getCertificateChain 是阻塞 binder 调用：
                        // **主线程调会抛 IllegalStateException（"calling this from your main thread
                        // can lead to deadlock"）**，所以取钥放后台线程，拿到再回 UI 线程 proceed。
                        new Thread(() -> {
                            String diag;
                            PrivateKey key = null;
                            X509Certificate[] chain = null;
                            try {
                                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P)
                                    throw new Exception("Android 9 以下读不到证书链");
                                key = android.security.KeyChain.getPrivateKey(MainActivity.this, alias);
                                chain = android.security.KeyChain.getCertificateChain(
                                        MainActivity.this, alias);
                                if (key == null || chain == null || chain.length == 0)
                                    throw new Exception("取不到私钥或证书链（alias=" + alias + "）");
                                // 现场记录：选的哪个、密钥算法、链有几级、每级发给谁——服务端拒了
                                // 我们的证书时，凭这个能看出是链不全还是选错了证
                                StringBuilder sb = new StringBuilder();
                                for (int i = 0; i < chain.length; i++)
                                    sb.append(i == 0 ? "" : " → ")
                                            .append(chain[i].getSubjectX500Principal().getName());
                                diag = "已选 alias=" + alias + " keyAlg=" + key.getAlgorithm()
                                        + " chainLen=" + chain.length + " [" + sb + "]";
                            } catch (Exception e) {
                                diag = e.getClass().getSimpleName() + ": " + e.getMessage();
                            }
                            final PrivateKey fKey = key;
                            final X509Certificate[] fChain = chain;
                            final String fDiag = diag;
                            runOnUiThread(() -> {
                                if (fKey == null || fChain == null) {
                                    failClientCert(req, fDiag);
                                    return;
                                }
                                certDiag = fDiag;
                                android.util.Log.i("Cockpit", "clientCert " + fDiag);
                                try {
                                    req.proceed(fKey, fChain);
                                } catch (Exception e) {
                                    failClientCert(req, e.getClass().getSimpleName() + ": " + e.getMessage());
                                }
                            });
                        }, "cockpit-keychain").start();
                    },
                    request.getKeyTypes(),
                    request.getPrincipals(),
                    request.getHost(),
                    request.getPort(),
                    null);
        }

        /** 客户端证书这条路走不通了：日志 + Toast 说清卡在哪，别让用户对着通用错误猜 */
        private void failClientCert(ClientCertRequest req, String why) {
            certDiag = why;
            android.util.Log.w("Cockpit", "clientCert failed: " + why);
            try {
                req.cancel();
            } catch (Exception ignored) {
                /* 请求可能已经失效 */
            }
            Toast.makeText(MainActivity.this, getString(R.string.err_client_cert) + "（" + why + "）",
                    Toast.LENGTH_LONG).show();
        }
    }

    private class Chrome extends WebChromeClient {
        /** 网页 getUserMedia 的麦克风请求：只给宿主页面，先要系统的录音权限 */
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            boolean wantsMic = false;
            for (String r : request.getResources())
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsMic = true;
            String origin = originOf(request.getOrigin().toString());
            if (!wantsMic || hostOrigin.isEmpty() || !hostOrigin.equals(origin)) {
                request.deny();
                return;
            }
            String[] grant = new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE};
            if (micAsked && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                request.grant(grant);
                return;
            }
            if (pendingMic != null) pendingMic.deny();
            pendingMic = request;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingMic == request) pendingMic = null;
        }

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
        if (requestCode == REQ_DIR) {
            onPickedDir(resultCode, data);
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

    /** 连接页：portalTimeout 也要跟着一起撤（onDestroy 前不能再有人引用 WebView） */
    void showConnect(String error) {
        pendingError = error == null ? "" : error;
        hostOrigin = "";
        pageReady = false;
        proxyFlow = false;
        dismissAuthDialog();
        timer.removeCallbacks(portalTimeout);
        // 换宿主的凭证不留给下一个：证书「仍要连接」的授权按 host 存的，这里清掉
        if (!prefs.getString("ssl_bypass", "").isEmpty())
            prefs.edit().remove("ssl_bypass").apply();
        if (media != null) media.clear();
        probeSeq++; // 让还在探测中的回调作废（它属于上一次尝试）
        pendingConnect = null;
        showLoading(false);
        web.loadUrl(CONNECT_PAGE);
    }

    /**
     * 代理登录对话框（basic_auth）。用户名 / 密码 / 取消；标题带 host 与 realm（代理给的话）。
     * 登录成功 → {@link HttpAuthHandler#proceed} + 存盘（下次同一 host 自动带，不再问）；
     * 取消 → {@link HttpAuthHandler#cancel} + 回连接页并说明，别让用户对着一张坏掉的主界面发呆。
     */
    private void askProxyAuth(HttpAuthHandler handler) {
        final String host = pendingAuth == null ? "" : pendingAuth[0];
        final String realm = pendingAuth == null ? "" : pendingAuth[1];
        pendingAuth = null;
        if (host.isEmpty()) {
            authShowing = false;
            handler.cancel();
            return;
        }
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(16);
        box.setPadding(pad, pad, pad, 0);
        final EditText user = new EditText(this);
        user.setHint(R.string.proxy_auth_user);
        user.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        final EditText pass = new EditText(this);
        pass.setHint(R.string.proxy_auth_pass);
        pass.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        box.addView(user, lp);
        box.addView(pass, lp);
        String title = realm.isEmpty()
                ? getString(R.string.proxy_auth_title) + " · " + host
                : getString(R.string.proxy_auth_realm, host, realm);
        final android.app.AlertDialog dlg = new android.app.AlertDialog.Builder(this)
                .setTitle(title)
                .setView(box)
                .setPositiveButton(R.string.proxy_auth_ok, (d, w) -> {
                    String u = user.getText().toString().trim();
                    String p = pass.getText().toString();
                    if (u.isEmpty()) {
                        handler.cancel();
                        showConnect(getString(R.string.err_proxy_cancelled));
                        return;
                    }
                    ProxyCreds.save(prefs, authKeyFor(host), u, p);
                    autoAuthTries = 0; // 用户刚给的新凭据：重新给两次自动重试的机会
                    handler.proceed(u, p);
                })
                .setNegativeButton(R.string.proxy_auth_cancel, (d, w) -> {
                    handler.cancel();
                    showConnect(getString(R.string.err_proxy_cancelled));
                })
                .setOnCancelListener(d -> {
                    handler.cancel();
                    authShowing = false;
                })
                .create();
        dlg.setOnDismissListener(d -> {
            authShowing = false;
            if (authDialog == dlg) authDialog = null;
        });
        authDialog = dlg;
        dlg.show();
    }

    /**
     * 撤掉开着的代理认证对话框（页面要换了：回连接页 / 重新认证）。
     * 不碰 {@link HttpAuthHandler}——接下来的导航会把挂起的请求一起作废；
     * 由用户点按钮走的那两条路才负责 proceed / cancel。
     */
    private void dismissAuthDialog() {
        if (authDialog == null) return;
        android.app.AlertDialog d = authDialog;
        authDialog = null;
        d.dismiss();
    }

    /** 门户停留超时：登录门户 2 分钟没把用户送回宿主 origin，降级到连接页（别再干等） */
    private void onPortalTimeout() {
        if (!proxyFlow) return;
        showConnect(getString(R.string.err_proxy_retry));
    }

    /**
     * 会话过期后的重新认证（0.9.0，场景 B）：网页侧发现 401 / 被踢到登录门户时经原生桥调这里。
     *
     * <p><b>不再走 probe</b>：过期会话下 probe 只会拿到 401，那样会错误地回到连接页。直接重新加载
     * 宿主页面，把认证交还给代理层：
     * basic_auth → {@link Client#onReceivedHttpAuthRequest} 自动带上存过的凭据；
     * forward_auth → 302 去门户，留在 WebView 里登录后回跳，shim 全新初始化，一切恢复。</p>
     *
     * <p>代价：整页重载会丢当前 ability / 表单状态（{@link #onRenderProcessGone} 也是整页重建，
     * 先例如此）。可选优化见 docs/android-v5.md。</p>
     */
    void reauth() {
        if (hostOrigin.isEmpty()) return; // 还在连接页 / 已经掉了：没什么可重认证的
        long now = android.os.SystemClock.uptimeMillis();
        if (now - lastReauthAt < REAUTH_THROTTLE_MS) return; // 并发 401 只触发一次
        lastReauthAt = now;
        if (++reauthFails > REAUTH_MAX) {
            // 重认证没治好（多半是用户名/密码错了，或门户登录根本没成功）：停手，交给用户
            reauthFails = 0;
            showConnect(getString(R.string.err_proxy_retry));
            return;
        }
        probeSeq++;      // 作废在途探测（它们属于上一次连接）
        pendingConnect = null;
        pageReady = false;
        showLoading(true);
        dismissAuthDialog(); // 重新加载会重新挑战，别让旧对话框留在新页面上面
        Toast.makeText(this, R.string.reauth_running, Toast.LENGTH_SHORT).show();
        web.loadUrl(hostPageUrl());
        // 观察期：这段时间里没再触发 reauth 就说明这一次治好了（否则计数继续累加 → 降级）
        final int seq = ++reauthSeq;
        timer.postDelayed(() -> {
            if (seq == reauthSeq) reauthFails = 0;
        }, REAUTH_HEALTHY_MS);
    }

    /** 连接 / 重新认证都要用的宿主页面地址（token 走 query，与 connect() 一致） */
    private String hostPageUrl() {
        String base = trimSlash(prefs.getString("url", DEFAULT_URL));
        String token = prefs.getString("token", "");
        return base + (token.isEmpty() ? "" : "/?token=" + enc(token));
    }

    /** 连接页 / 原生探测要带的代理 Basic 头（该 host 存过凭据才有） */
    private String proxyAuthHeader(String hostOrUrl) {
        String key = ProxyCreds.keyOf(hostOrUrl);
        if (!ProxyCreds.has(prefs, key)) return "";
        String raw = ProxyCreds.user(prefs, key) + ":" + ProxyCreds.pass(prefs, key);
        return "Basic " + Base64.encodeToString(raw.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
    }

    /**
     * {@code onReceivedHttpAuthRequest} 给的是 host（可能不带端口）→ 存 / 查代理凭据用的 key。
     * 端口从当前宿主地址补（代理与宿主同机同端口是常规形态；真挂在别的端口上时用户可以在连接页
     * 手填一次，对话框里存的 key 与这里一致）。
     */
    private String authKeyFor(String host) {
        if (host == null || host.isEmpty()) return "";
        if (host.indexOf("://") >= 0) return ProxyCreds.keyOf(host);
        if (host.indexOf(':') > 0) return host; // 已经带了端口
        String base = trimSlash(prefs.getString("url", DEFAULT_URL));
        try {
            int port = new URL(base).getPort();
            return port > 0 ? host + ":" + port : host;
        } catch (Exception e) {
            return host;
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
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
        applyRendererPriority();
        new Thread(() -> {
            String err = probe(base, token);
            runOnUiThread(() -> {
                if (seq != probeSeq) return; // 用户换了目标 / 打开连接页 / 页面已销毁：过期结果丢弃
                pendingConnect = null;
                showLoading(false);
                if (err != null && !PROBE_TLS_CUT.equals(err)) {
                    showConnect(err);
                    return;
                }
                // PROBE_TLS_CUT：探针的 TLS 握手被对面掐断——不是证书问题，是服务端 / 中间盒只放行
                // 浏览器指纹的 TLS（Java 的 ClientHello 被 RST，实测 curl 带 Chrome UA 也一样被重置，
                // 只有真 Chrome 过得去）。WebView 是 Chromium、与浏览器同款 TLS 栈，照样加载，让页面
                // 自己说话；真失败了有 onReceivedError / onReceivedSslError 兜底。
                hostOrigin = originOf(base);
                pageReady = false;
                reauthFails = 0; // 新的一次连接：重新认证计数归零
                web.loadUrl(hostPageUrl()); // 真正的加载进度接着由 onPageStarted / onPageFinished 显示
            });
        }).start();
    }

    /**
     * 探一次 {@code /api/info}，返回 null = 通过，否则是给用户看的错误（见 {@link #showConnect}）。
     *
     * <p>0.9.0 起把「宿主自己的 token」和「反向代理的认证」分开：代理挂在前面时代理先说话，
     * 原来的实现会被代理的 302 跟到登录门户拿到 200，误判「宿主正常」，然后页面里所有 /api 调用
     * 才失败。所以：</p>
     * <ul>
     *   <li>{@code setInstanceFollowRedirects(false)}：3xx 自己判断；</li>
     *   <li>同 host 的 3xx 手动跟随（≤5 跳，防环）；</li>
     *   <li>跳到别的 host → 代理要求先登录，明确报错（绝不误报成功）；</li>
     *   <li>401 带 {@code www-authenticate} → 代理层认证失败（提示检查代理用户名/密码，
     *       不是 cockpit token）；该 host 存过凭据时先带 preemptive Basic；</li>
     *   <li>401 不带 {@code www-authenticate} → 保持原来的 err_token 语义。</li>
     * </ul>
     *
     * <p>连不上也要说清是为什么：TLS 证书 / DNS / 超时 / 拒绝连接分开报。以前是一律
     * {@code err_unreachable}（整段 Termux 提示）——公网 https 宿主的证书来自自建 CA 时
     * （App 默认不信任用户安装的 CA，见 {@code network_security_config.xml}），用户会看到
     * 「Is it running in Termux?」这种完全不相干的提示。Termux 文案只留给 loopback / 私网宿主。</p>
     */
    private String probe(String base, String token) {
        String auth = proxyAuthHeader(base); // 空 = 该 host 没存过代理凭据
        // 有代理凭据时 Basic 头占掉 Authorization，token 改走 query（宿主两种都认，见 server.ts authorized）
        String url = base + "/api/info" + (auth.isEmpty() || token.isEmpty() ? "" : "?token=" + enc(token));
        for (int hop = 0; hop < 5; hop++) {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(4000);
                c.setReadTimeout(4000);
                // 有代理凭据时 Basic 优先：代理才是第一道关，Bearer 留给宿主自己认
                if (!auth.isEmpty()) c.setRequestProperty("Authorization", auth);
                else if (!token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
                int code = c.getResponseCode();
                if (code / 100 == 2) return null;
                if (code == 401) {
                    String wa = c.getHeaderField("www-authenticate");
                    if (wa != null && !wa.isEmpty()) {
                        // 代理层（basic_auth）认证失败：不是 cockpit token 的事
                        return getString(R.string.err_proxy_auth);
                    }
                    return getString(R.string.err_token);
                }
                if (code / 100 == 3) {
                    String loc = c.getHeaderField("Location");
                    if (loc == null || loc.isEmpty()) return getString(R.string.err_http) + " " + code;
                    String next = resolve(url, loc);
                    if (next.isEmpty()) return getString(R.string.err_http) + " " + code;
                    String from = originOf(url), to = originOf(next);
                    if (!from.isEmpty() && from.equals(to)) {
                        url = next; // 同 host：跟着跳
                        continue;
                    }
                    // 跳到别的 host：代理的 forward_auth 门户。不能跟（那是用户的浏览器会话），
                    // 也绝不能因为「跟过去拿到 200」就误报宿主正常。
                    return getString(R.string.err_proxy_login, hostOf(next));
                }
                return getString(R.string.err_http) + " " + code;
            } catch (SSLException e) {
                // 证书真的不受信任 → 明确提示装根 CA（WebView 也一样过不去，别浪费时间加载）；
                // 只是握手被对面掐断 → 不是证书的事，放行让 WebView 去加载（见 PROBE_TLS_CUT）
                return isCertUntrusted(e) ? getString(R.string.err_tls) : PROBE_TLS_CUT;
            } catch (UnknownHostException e) {
                return getString(R.string.err_dns);
            } catch (SocketTimeoutException e) {
                return getString(R.string.err_timeout);
            } catch (ConnectException e) {
                return getString(R.string.err_connect);
            } catch (Exception e) {
                // 兜底：本机 Termux 宿主保留原来的提示，公网 / 远程宿主用中性文案
                return isLocalTarget(base)
                        ? getString(R.string.err_unreachable)
                        : getString(R.string.err_remote);
            } finally {
                if (c != null) c.disconnect();
            }
        }
        return getString(R.string.err_http) + " 310"; // 同 host 跳了 5 次还没完：当异常处理
    }

    /**
     * probe 遇到「TLS 握手被对面掐断」时返回它（{@link javax.net.ssl.SSLException} 但异常链里没有
     * 任何证书类信息）。这不是证书问题——实测有服务端 / 中间盒只放行浏览器指纹的 TLS：Java 的
     * ClientHello 直接被 RST，curl 带 Chrome UA 也被重置，只有真 Chrome 过得去。所以不拦截连接：
     * WebView 是 Chromium、与浏览器同款 TLS 栈，让它直接加载页面，真失败了再由
     * {@link Client#onReceivedError} / {@link Client#onReceivedSslError} 报错。
     */
    private static final String PROBE_TLS_CUT = "\u0000probe-tls-cut";

    /** 异常链里有没有「证书不受信任」一类的信息（PKIX / certification path / trust / not verified…） */
    private static boolean isCertUntrusted(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof java.security.cert.CertificateException) return true;
            String m = String.valueOf(t.getMessage()).toLowerCase(java.util.Locale.ROOT);
            String c = t.getClass().getSimpleName().toLowerCase(java.util.Locale.ROOT);
            if (m.contains("certificate") || m.contains("certification path") || m.contains("pkix")
                    || m.contains("not trusted") || m.contains("untrusted") || m.contains("not verified")
                    || c.contains("cert"))
                return true;
        }
        return false;
    }

    /**
     * loopback / 私网地址 = 典型的本机 Termux 宿主：连不上时给 Termux 专属提示；
     * 公网 / 远程宿主用中性文案（Termux 提示对它们没有意义）。
     */
    private static boolean isLocalTarget(String urlOrHost) {
        String host = ProxyCreds.keyOf(urlOrHost).toLowerCase(java.util.Locale.ROOT);
        if (host.isEmpty()) return false;
        int at = host.indexOf('@'); // keyOf 已去 userinfo，双保险
        if (at >= 0) host = host.substring(at + 1);
        int colon = host.indexOf(':');
        if (colon > 0) host = host.substring(0, colon); // 去端口（IPv6 字面量宿主不常见，误伤可接受）
        if (host.equals("localhost") || host.endsWith(".localhost") || host.equals("::1")) return true;
        if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")) return true;
        if (host.startsWith("172.")) {
            String[] p = host.split("\\.");
            if (p.length > 1) {
                try {
                    int second = Integer.parseInt(p[1]);
                    if (second >= 16 && second <= 31) return true;
                } catch (NumberFormatException ignored) {
                }
            }
        }
        return host.startsWith("fe80:") || host.endsWith(".local");
    }

    /** 相对 Location → 绝对 URL；解析不了返回空串 */
    private static String resolve(String baseUrl, String loc) {
        try {
            return new URL(new URL(baseUrl), loc).toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** URL 的 host（带非默认端口）；只用于给用户看 */
    private static String hostOf(String url) {
        try {
            URL u = new URL(url);
            return u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        } catch (Exception e) {
            return url;
        }
    }

    private boolean notifyAsked;

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == SpeechBridge.REQ_ASR || requestCode == REQ_MIC) micAsked = true;
        if (requestCode == SpeechBridge.REQ_ASR) {
            speech.onPermission(results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED);
            return;
        }
        if (requestCode != REQ_MIC || pendingMic == null) return;
        PermissionRequest req = pendingMic;
        pendingMic = null;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED)
            req.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        else req.deny();
    }

    /** Android 13+ 的通知权限：保活开启时、或第一次有媒体要显示时请求（每次启动最多问一次） */
    void ensureNotifyPermission() {
        if (notifyAsked) return;
        notifyAsked = true;
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
    }

    private void startKeepAlive() {
        ensureNotifyPermission();
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
        // 网页在后台也「可见」（见 createWebView），收不到 visibilitychange：告诉它回到前台了，
        // 由它检查事件流是否断过、找回等待中的命令结果
        if (pageReady) sendEvent("resume", "{}");
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
        timer.removeCallbacksAndMessages(null); // 门户超时 / 重认证观察期都撤掉
        media.release();
        speech.release();
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
                    o.put("pinShortcuts", Shortcuts.supported(this));
                    // 系统语音（0.8.0）：页面据此决定用原生 TTS / 识别（见 src/main/ui/speech.ts）
                    JSONObject sp = new JSONObject();
                    sp.put("tts", true);
                    sp.put("asr", SpeechBridge.asrAvailable(this));
                    o.put("speech", sp);
                    reply(id, true, o);
                    return;
                }
                case "shortcut.pin": {
                    // 固定桌面快捷方式（0.6.0）：{ability, target?} 或 {package}；label / icon（data URL）可选
                    final String ability = args.optString("ability", "");
                    final String pkg = args.optString("package", "");
                    final String label = args.optString("label", "");
                    final JSONObject target = args.optJSONObject("target");
                    final Bitmap icon = Shortcuts.fromDataUrl(args.optString("icon", ""));
                    runOnUiThread(() -> {
                        String err = Shortcuts.pin(this, ability, target == null ? null : target.toString(), pkg, label, icon);
                        if (err == null) reply(id, true, new JSONObject());
                        else reply(id, false, errorJson(err));
                    });
                    return;
                }
                case "webLogin":
                    // 网页登录页（0.6.0）：{url, doneHosts, cookieUrls, title} → {cookies:[{url,cookie}], cancelled}
                    runOnUiThread(() -> {
                        if (webLogin != null) {
                            reply(id, false, errorJson("busy"));
                            return;
                        }
                        String u = args.optString("url", "");
                        if (!u.startsWith("https://")) {
                            reply(id, false, errorJson("url must be https"));
                            return;
                        }
                        webLogin = new WebLogin(this, root, args, result -> {
                            webLogin = null;
                            reply(id, true, result);
                        });
                    });
                    return;
                case "settings.set": {
                    if (args.has("keepAlive")) {
                        boolean on = args.getBoolean("keepAlive");
                        prefs.edit().putBoolean("keepAlive", on).apply();
                        runOnUiThread(() -> {
                            if (on) startKeepAlive();
                            else stopService(new Intent(this, KeepAliveService.class));
                            applyRendererPriority();
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
                case "reauth": {
                    // 会话过期（0.9.0）：网页侧发现 401 / 被踢到登录门户时调，重新加载宿主页面，
                    // 由代理层重新挑战（见 reauth()）。不再走 probe——过期会话下它只会 401。
                    runOnUiThread(this::reauth);
                    reply(id, true, new JSONObject());
                    return;
                }
                case "proxy.creds": {
                    // 连接页的可选输入：存 / 清该 host 的代理用户名密码。密码只在成功认证后才落盘。
                    final String host = args.optString("host", "");
                    final String u = args.optString("user", "");
                    final String p = args.optString("pass", "");
                    if (!host.isEmpty()) {
                        if (u.isEmpty()) ProxyCreds.clear(prefs, ProxyCreds.keyOf(host));
                        else ProxyCreds.save(prefs, ProxyCreds.keyOf(host), u, p);
                    }
                    JSONObject o = new JSONObject();
                    o.put("ok", true);
                    reply(id, true, o);
                    return;
                }
                case "pickFiles":
                    runOnUiThread(() -> startPick(id, args.optBoolean("multiple", false)));
                    return;
                case "pickDirectory":
                    runOnUiThread(() -> startPickDir(id, args.optString("initial", "")));
                    return;
                case "media.update":
                    // 页面的 navigator.mediaSession 快照 → 系统媒体会话 + 通知（0.5.0）
                    runOnUiThread(() -> media.update(args));
                    reply(id, true, new JSONObject());
                    return;
                case "clipboard.get": {
                    // 读系统剪贴板文本（移动剪贴板历史用）。Android 10+ 仅前台应用可读，读不到给空串。
                    JSONObject o = new JSONObject();
                    o.put("text", clipboardText());
                    reply(id, true, o);
                    return;
                }
                case "clipboard.set": {
                    final String text = args.optString("text", "");
                    runOnUiThread(() -> {
                        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        cm.setPrimaryClip(ClipData.newPlainText("Cockpit", text));
                    });
                    reply(id, true, new JSONObject());
                    return;
                }
                case "tts.voices":
                    speech.voices(replier(id));
                    return;
                case "tts.speak":
                    speech.speak(args, replier(id));
                    return;
                case "tts.stop":
                    speech.stopTts();
                    reply(id, true, new JSONObject());
                    return;
                case "asr.start":
                    speech.startAsr(args, replier(id));
                    return;
                case "asr.stop":
                    speech.stopAsr();
                    reply(id, true, new JSONObject());
                    return;
                case "asr.cancel":
                    speech.cancelAsr();
                    reply(id, true, new JSONObject());
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

    /**
     * 目录选择：系统目录选择器（SAF）。宿主（Termux）是另一进程、按真实路径读盘，
     * 所以要把 SAF 树映射回文件系统路径（{@link #treeToPath}）——映射不了的
     * （网盘 / Downloads 之类）直接失败，页面退回手动输入。
     */
    private void startPickDir(String id, String initial) {
        if (pickCallId != null || dirCallId != null) {
            reply(id, false, errorJson("busy"));
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        Uri initialUri = pathToTreeUri(initial);
        if (initialUri != null) intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, initialUri);
        dirCallId = id;
        try {
            startActivityForResult(intent, REQ_DIR);
        } catch (ActivityNotFoundException e) {
            dirCallId = null;
            reply(id, false, errorJson("no directory picker"));
        }
    }

    /** 取消了就回空对象（页面当作「没选」）；拿到树但映射不出路径 = 明确失败 */
    private void onPickedDir(int resultCode, Intent data) {
        final String id = dirCallId;
        dirCallId = null;
        if (id == null) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            reply(id, true, new JSONObject());
            return;
        }
        String path = treeToPath(data.getData());
        if (path == null) {
            reply(id, false, errorJson("unsupported folder"));
            return;
        }
        try {
            reply(id, true, new JSONObject().put("path", path));
        } catch (JSONException ignored) {
        }
    }

    /**
     * SAF 的文档 / 树 URI → 文件系统路径。
     * 只认外部存储提供者的 {@code primary} 卷（手机内置存储）：宿主持有的是真实路径，
     * 必须给出同一条路径才算选对了。SD 卡 / Downloads / 网盘这些卷给不出确定路径，
     * 一律返回 null 让调用方明确报错——猜一条路只会让用户以为选好了。
     */
    private String treeToPath(Uri uri) {
        if (uri == null) return null;
        try {
            String docId;
            try {
                docId = DocumentsContract.getTreeDocumentId(uri);
            } catch (IllegalArgumentException notATree) {
                // 个别系统挑具体目录时给的是 /document/… 而不是 /tree/…
                docId = DocumentsContract.getDocumentId(uri);
            }
            if (docId == null || !docId.startsWith("primary:")) return null;
            File ext = Environment.getExternalStorageDirectory();
            if (ext == null) return null;
            final String root = ext.getAbsolutePath();
            final String rel = docId.substring("primary:".length());
            return rel.isEmpty() ? root : root + "/" + rel;
        } catch (Exception e) {
            return null;
        }
    }

    /** 反一下：宿主路径 → 系统选择器的初始目录（只在手机内置存储下有意义，别的返回 null） */
    private static Uri pathToTreeUri(String path) {
        if (path == null || path.isEmpty()) return null;
        try {
            File ext = Environment.getExternalStorageDirectory();
            if (ext == null) return null;
            final String root = ext.getAbsolutePath();
            if (!path.equals(root) && !path.startsWith(root + "/")) return null;
            final String rel = path.equals(root) ? "" : path.substring(root.length() + 1);
            return DocumentsContract.buildDocumentUri(
                    "com.android.externalstorage.documents", "primary:" + rel);
        } catch (Exception e) {
            return null;
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
        final String proxyAuth = proxyAuthHeader(base);
        io.execute(() -> {
            try {
                List<String> paths = Uploader.uploadAll(getContentResolver(), base, token, proxyAuth, uris,
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

    private SpeechBridge.Reply replier(String id) {
        return new SpeechBridge.Reply() {
            @Override
            public void ok(JSONObject data) {
                reply(id, true, data);
            }

            @Override
            public void fail(String error) {
                reply(id, false, errorJson(error));
            }
        };
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
                // 已保存的反向代理用户名（0.9.0，连接页显示「已保存」并给「清除」按钮）；
                // 密码不回给页面
                o.put("proxyUser", ProxyCreds.user(prefs, ProxyCreds.keyOf(prefs.getString("url", DEFAULT_URL))));
                if (prefill != null) o.put("prefill", prefill);
            } catch (JSONException ignored) {
            }
            pendingError = "";
            prefill = null;
            return o.toString();
        }

        /**
         * 连接页提交。{@code proxyUser} / {@code proxyPass} 是可选的反向代理凭据（0.9.0）：
         * 用户名非空 = 存 / 覆盖该 host 的凭据（之后 probe 与网页加载都自动带 Basic）；
         * 两者都空 = 不动已保存的（清除走连接页的「清除」按钮 → {@code proxy.creds}）。
         */
        @JavascriptInterface
        public void connect(String url, String token, boolean keepAlive, String proxyUser, String proxyPass) {
            prefs.edit()
                    .putString("url", trimSlash(url.trim()))
                    .putString("token", token.trim())
                    .putBoolean("keepAlive", keepAlive)
                    .apply();
            String host = trimSlash(url.trim());
            if (proxyUser != null && !proxyUser.trim().isEmpty())
                ProxyCreds.save(prefs, ProxyCreds.keyOf(host), proxyUser.trim(), proxyPass == null ? "" : proxyPass);
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
            return clipboardText();
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
        // file:// 交给别的应用会抛 FileUriExposedException（Android 7+）直接闪退；只放行网页 / 邮件等外部链接
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(java.util.Locale.ROOT);
        if (scheme.isEmpty() || scheme.equals("file") || scheme.equals("content") || scheme.equals("javascript")) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (RuntimeException ignored) {
            // ActivityNotFoundException / SecurityException 等：没法打开就算了，不能让 App 崩
        }
    }

    // ---------------------------------------------------------------- 小工具

    /** 读系统剪贴板文本；Android 10+ 仅前台应用可读，读不到 / 异常返回空串。 */
    private String clipboardText() {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            CharSequence t = clip.getItemAt(0).coerceToText(this);
            return t == null ? "" : t.toString();
        } catch (Exception e) {
            return "";
        }
    }

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
