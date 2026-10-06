package io.github.linuxcockpit.client;

import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 网页登录页（0.6.0）：盖在主界面上的第二个 WebView，给 balance 这类「在网页里登录、再拿会话 cookie
 * 调接口」的平台用。桌面版用 Electron 的登录窗口；App 里宿主（Termux）没有浏览器，就由这里登录，
 * 登完把相关站点的 cookie（{@link CookieManager#getCookie} 含 HttpOnly）交回页面，页面再导入宿主。
 *
 * <p>参数：{@code {url, doneHosts:[…], cookieUrls:[…], title}}。离开过 doneHosts（去了登录页）再回到
 * doneHosts 且加载完 → 自动完成；也可以点「完成」。点 ✕ / 返回到底 → 取消（结果里 cookies 为空）。
 * 主线程使用。</p>
 */
final class WebLogin {
    interface Done {
        void done(JSONObject result);
    }

    private static final long AUTO_FINISH_DELAY_MS = 1500;

    private final MainActivity act;
    private final FrameLayout parent;
    private final LinearLayout panel;
    private final WebView view;
    private final Set<String> doneHosts = new LinkedHashSet<>();
    private final List<String> cookieUrls = new ArrayList<>();
    private final Done done;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean leftDoneHost;
    private boolean finished;

    @SuppressLint("SetJavaScriptEnabled")
    WebLogin(MainActivity act, FrameLayout parent, JSONObject args, Done done) {
        this.act = act;
        this.parent = parent;
        this.done = done;
        String url = args.optString("url", "");
        JSONArray hosts = args.optJSONArray("doneHosts");
        if (hosts != null) for (int i = 0; i < hosts.length(); i++) doneHosts.add(hosts.optString(i).toLowerCase());
        cookieUrls.add(url);
        JSONArray urls = args.optJSONArray("cookieUrls");
        if (urls != null) for (int i = 0; i < urls.length(); i++) cookieUrls.add(urls.optString(i));

        panel = new LinearLayout(act);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(Color.rgb(0x12, 0x12, 0x12));
        panel.setClickable(true); // 不让点击漏到下面的主界面

        LinearLayout bar = new LinearLayout(act);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int pad = dp(8);
        bar.setPadding(pad, pad / 2, pad, pad / 2);
        Button close = new Button(act);
        close.setText("✕");
        close.setOnClickListener(v -> finish(false));
        TextView title = new TextView(act);
        String t = args.optString("title", "");
        title.setText(t.isEmpty() ? "登录" : "登录 " + t);
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        title.setSingleLine(true);
        title.setPadding(pad, 0, pad, 0);
        Button ok = new Button(act);
        ok.setText("完成");
        ok.setOnClickListener(v -> finish(true));
        bar.addView(close, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        bar.addView(ok, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        panel.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        view = new WebView(act);
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setSupportMultipleWindows(false); // window.open 就在本页打开
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // 去掉 WebView 标记（"; wv"、"Version/4.0"）：部分登录页见到 WebView UA 直接拒绝
        s.setUserAgentString(s.getUserAgentString().replace("; wv", "").replaceAll("Version/\\d+(\\.\\d+)* ", ""));
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(view, true); // 统一登录（account.xiaomi.com 等）跨站回跳要用
        view.setWebViewClient(new Client());
        panel.addView(view, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        parent.addView(panel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        view.loadUrl(url);
    }

    /** 返回键：登录页里能后退就后退，否则取消 */
    void back() {
        if (view.canGoBack()) view.goBack();
        else finish(false);
    }

    void finish(boolean collect) {
        if (finished) return;
        finished = true;
        handler.removeCallbacksAndMessages(null);
        JSONObject result = new JSONObject();
        JSONArray cookies = new JSONArray();
        if (collect) {
            CookieManager cm = CookieManager.getInstance();
            cm.flush();
            for (String u : cookieUrls) {
                if (u == null || !u.startsWith("https://")) continue;
                String c = cm.getCookie(u);
                if (c == null || c.isEmpty()) continue;
                JSONObject o = new JSONObject();
                try {
                    o.put("url", u);
                    o.put("cookie", c);
                } catch (JSONException ignored) {
                }
                cookies.put(o);
            }
        }
        try {
            result.put("cookies", cookies);
            result.put("cancelled", !collect);
        } catch (JSONException ignored) {
        }
        parent.removeView(panel);
        view.stopLoading();
        view.destroy();
        done.done(result);
    }

    private boolean isDoneHost(String url) {
        String host = Uri.parse(url).getHost();
        return host != null && doneHosts.contains(host.toLowerCase());
    }

    private static boolean looksLikeLogin(String url) {
        String path = Uri.parse(url).getPath();
        return path != null && path.toLowerCase().contains("login");
    }

    private int dp(int v) {
        return Math.round(v * act.getResources().getDisplayMetrics().density);
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
            String scheme = req.getUrl().getScheme();
            // 只在登录页里走 http(s)；其它协议（拉起 App 的 intent:// 等）不跟
            return scheme == null || !(scheme.equals("http") || scheme.equals("https"));
        }

        @Override
        public void onPageStarted(WebView v, String url, Bitmap favicon) {
            handler.removeCallbacksAndMessages(null);
            if (!isDoneHost(url) || looksLikeLogin(url)) leftDoneHost = true;
        }

        @Override
        public void onPageFinished(WebView v, String url) {
            // 去过登录页、又回到了目标站点（且不是它自己的登录路由）：等页面把 cookie 写完再自动完成
            if (leftDoneHost && isDoneHost(url) && !looksLikeLogin(url))
                handler.postDelayed(() -> finish(true), AUTO_FINISH_DELAY_MS);
        }
    }
}
