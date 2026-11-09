package io.github.linuxcockpit.client;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 把手机上的文件（content:// URI，来自系统文件选择器或别的应用的「分享」）原生流式上传到宿主的
 * `POST /api/upload?name=`，返回宿主上的路径——和网页里「从此设备选择」走的是同一个接口，
 * 只是不经过 WebView 的 JS 内存。在后台线程里调用。
 */
final class Uploader {
    interface Progress {
        /** index 从 1 开始；pct 0–100，大小未知时为 -1 */
        void on(int index, int total, int pct, String name);
    }

    private Uploader() {
    }

    static List<String> uploadAll(ContentResolver cr, String base, String token, String proxyAuth,
                                  List<Uri> uris, Progress progress) throws Exception {
        List<String> paths = new ArrayList<>();
        for (int i = 0; i < uris.size(); i++) {
            paths.add(uploadOne(cr, base, token, proxyAuth, uris.get(i), i + 1, uris.size(), progress));
        }
        return paths;
    }

    /**
     * 与 {@code probe} 同一套取舍：宿主挂在反向代理后面时代理先说话，所以有代理凭据就带 Basic，
     * 否则才带宿主的 Bearer token。401 报错时把 www-authenticate 带上，好让页面区分
     * 「代理层认证失败」和「token 不对」。
     */
    private static String uploadOne(ContentResolver cr, String base, String token, String proxyAuth, Uri uri,
                                    int index, int total, Progress progress) throws Exception {
        String name = "file";
        long size = -1;
        try (Cursor c = cr.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE},
                null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int si = c.getColumnIndex(OpenableColumns.SIZE);
                if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni);
                if (si >= 0 && !c.isNull(si)) size = c.getLong(si);
            }
        } catch (Exception ignored) {
            // 有的提供方不支持查询：用缺省名
        }
        String q = URLEncoder.encode(name, StandardCharsets.UTF_8.name());
        // 与 probe 同一套取舍：Basic 头占掉 Authorization 时 token 走 query（宿主两种都认）
        String tk = (!proxyAuth.isEmpty() && !token.isEmpty())
                ? "&token=" + URLEncoder.encode(token, StandardCharsets.UTF_8.name()) : "";
        HttpURLConnection conn = (HttpURLConnection) new URL(base + "/api/upload?name=" + q + tk).openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(120000);
        conn.setRequestProperty("Content-Type", "application/octet-stream");
        if (!proxyAuth.isEmpty()) conn.setRequestProperty("Authorization", proxyAuth);
        else if (!token.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + token);
        if (size >= 0) conn.setFixedLengthStreamingMode(size);
        else conn.setChunkedStreamingMode(64 * 1024);
        progress.on(index, total, size > 0 ? 0 : -1, name);
        try (InputStream in = cr.openInputStream(uri); OutputStream out = conn.getOutputStream()) {
            if (in == null) throw new Exception("cannot open " + name);
            byte[] buf = new byte[64 * 1024];
            long sent = 0;
            int lastPct = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                sent += n;
                if (size > 0) {
                    int pct = (int) Math.min(100, sent * 100 / size);
                    if (pct != lastPct) {
                        lastPct = pct;
                        progress.on(index, total, pct, name);
                    }
                }
            }
        }
        int code = conn.getResponseCode();
        InputStream body = code / 100 == 2 ? conn.getInputStream() : conn.getErrorStream();
        String text = body == null ? "" : new String(readAll(body), StandardCharsets.UTF_8);
        conn.disconnect();
        if (code / 100 != 2) {
            String wa = conn.getHeaderField("www-authenticate");
            if (code == 401 && wa != null && !wa.isEmpty())
                throw new Exception("upload " + name + " failed: proxy authentication required");
            throw new Exception("upload " + name + " failed: HTTP " + code);
        }
        String path = new JSONObject(text).optString("path", "");
        if (path.isEmpty()) throw new Exception("upload " + name + " failed: no path");
        return path;
    }

    private static byte[] readAll(InputStream in) throws Exception {
        try (InputStream s = in) {
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = s.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toByteArray();
        }
    }
}
