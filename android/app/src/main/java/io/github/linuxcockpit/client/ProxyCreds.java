package io.github.linuxcockpit.client;

import android.content.SharedPreferences;

import org.json.JSONObject;

/**
 * 反向代理（宿主挂在 Caddy 之类后面时的 basic_auth / forward_auth）的用户名 / 密码，按 host:port 存。
 *
 * <p>与 cockpit token 一样是**应用私有明文存储**（SharedPreferences，没有 EncryptedSharedPreferences，
 * 因为那要 AndroidX / Play 服务，而本项目保持零依赖）：这台手机上能 root / 备份的人本来就能看到 token。
 * 密码只在成功认证后才落盘，任何日志都不打印它。</p>
 *
 * <p>覆盖：同一 host 再存一次即替换；清除见 {@link #clear}。</p>
 */
final class ProxyCreds {
    /** 一个 JSON blob 存所有 host，避免每个 host 一对 key */
    private static final String KEY = "proxy_creds";

    private ProxyCreds() {
    }

    /**
     * host:port 形态的 key。入参可以是完整 URL（{@code http://127.0.0.1:47810}）或裸 host
     * （{@code onReceivedHttpAuthRequest} 给的就是裸 host，可能不带端口——MainActivity 用
     * {@code authKeyFor} 补端口后再进来）。解析不了返回空串（调用方都按「没有凭据」处理）。
     */
    static String keyOf(String urlOrHost) {
        if (urlOrHost == null) return "";
        String s = urlOrHost.trim();
        int i = s.indexOf("://");
        if (i < 0) return s.isEmpty() ? "" : s; // 已经是 host[:port]
        String rest = s.substring(i + 3);
        int slash = rest.indexOf('/');
        String host = slash < 0 ? rest : rest.substring(0, slash);
        int at = host.indexOf('@');
        if (at >= 0) host = host.substring(at + 1); // 去掉 URL 里可能带的 userinfo
        return host.isEmpty() ? "" : host;
    }

    static String user(SharedPreferences prefs, String key) {
        return read(prefs, key).optString("user", "");
    }

    static String pass(SharedPreferences prefs, String key) {
        return read(prefs, key).optString("pass", "");
    }

    static boolean has(SharedPreferences prefs, String key) {
        return !key.isEmpty() && !user(prefs, key).isEmpty();
    }

    /** 存 / 覆盖一条；用户名为空表示清除（避免留下半条） */
    static void save(SharedPreferences prefs, String key, String user, String pass) {
        if (key.isEmpty()) return;
        JSONObject all = all(prefs);
        if (user.isEmpty()) all.remove(key);
        else {
            try {
                JSONObject o = new JSONObject();
                o.put("user", user);
                o.put("pass", pass);
                all.put(key, o);
            } catch (org.json.JSONException ignored) {
                return;
            }
        }
        prefs.edit().putString(KEY, all.toString()).apply();
    }

    static void clear(SharedPreferences prefs, String key) {
        if (key.isEmpty()) return;
        JSONObject all = all(prefs);
        if (!all.has(key)) return;
        all.remove(key);
        prefs.edit().putString(KEY, all.toString()).apply();
    }

    private static JSONObject all(SharedPreferences prefs) {
        String raw = prefs.getString(KEY, "");
        if (raw.isEmpty()) return new JSONObject();
        try {
            return new JSONObject(raw);
        } catch (org.json.JSONException e) {
            return new JSONObject(); // 坏数据：丢掉重来，别让连接页卡死
        }
    }

    private static JSONObject read(SharedPreferences prefs, String key) {
        if (key.isEmpty()) return new JSONObject();
        JSONObject o = all(prefs).optJSONObject(key);
        return o == null ? new JSONObject() : o;
    }
}
