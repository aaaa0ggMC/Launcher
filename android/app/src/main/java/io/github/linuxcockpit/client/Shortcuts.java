package io.github.linuxcockpit.client;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;

/**
 * 桌面快捷方式（固定到桌面，系统会弹确认框）：
 * <ul>
 *   <li><b>Cockpit 页面</b>：点了打开本 App 并跳到某个能力（{@code linuxcockpit://open?ability=…}）；</li>
 *   <li><b>其它应用</b>：点了启动那个应用，名字 / 图标可以自定义——这是「给现有应用换名字 / 图标」
 *       唯一可行的做法：别的应用自己的桌面图标改不了，只能另放一个快捷方式。</li>
 * </ul>
 * 同一目标 + 同一名字复用同一个 id：再固定一次就是更新（改图标 / 改名立刻生效）。
 */
final class Shortcuts {
    private static final int MAX_ICON_BYTES = 2 * 1024 * 1024;

    private Shortcuts() {
    }

    static boolean supported(Context ctx) {
        ShortcutManager sm = ctx.getSystemService(ShortcutManager.class);
        return sm != null && sm.isRequestPinShortcutSupported();
    }

    /** 跳到 Cockpit 某个能力页的 intent（快捷方式 / 外部深链接共用） */
    static Intent pageIntent(Context ctx, String ability, String target) {
        Uri.Builder b = new Uri.Builder().scheme("linuxcockpit").authority("open")
                .appendQueryParameter("ability", ability);
        if (target != null && !target.isEmpty()) b.appendQueryParameter("target", target);
        return new Intent(Intent.ACTION_VIEW, b.build()).setClass(ctx, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    /**
     * 请求固定一个快捷方式。ability 与 pkg 二选一；label 为空时用应用名 / 能力 id；icon 为空时用默认图标。
     * 返回 null 表示已发出请求（系统弹确认框），否则是错误信息。主线程调用。
     */
    static String pin(Context ctx, String ability, String target, String pkg, String label, Bitmap icon) {
        ShortcutManager sm = ctx.getSystemService(ShortcutManager.class);
        if (sm == null || !sm.isRequestPinShortcutSupported()) return "launcher does not support pinned shortcuts";
        PackageManager pm = ctx.getPackageManager();
        Intent intent;
        String id;
        Icon ic;
        if (pkg != null && !pkg.isEmpty()) {
            intent = pm.getLaunchIntentForPackage(pkg);
            if (intent == null) return "app not found or has no launcher entry: " + pkg;
            if (label == null || label.isEmpty()) label = appLabel(pm, pkg);
            Bitmap bmp = icon != null ? icon : appIcon(pm, pkg);
            ic = bmp != null ? Icon.createWithBitmap(bmp) : Icon.createWithResource(ctx, R.mipmap.ic_launcher);
            id = "app:" + pkg + ":" + label;
        } else if (ability != null && !ability.isEmpty()) {
            intent = pageIntent(ctx, ability, target);
            if (label == null || label.isEmpty()) label = ability;
            ic = icon != null ? Icon.createWithBitmap(icon) : Icon.createWithResource(ctx, R.mipmap.ic_launcher);
            id = "page:" + ability + ":" + label;
        } else {
            return "need a package or an ability";
        }
        ShortcutInfo info = new ShortcutInfo.Builder(ctx, id)
                .setShortLabel(label)
                .setLongLabel(label)
                .setIcon(ic)
                .setIntent(intent)
                .build();
        try {
            boolean pinnedAlready = false;
            for (ShortcutInfo s : sm.getPinnedShortcuts()) if (s.getId().equals(id)) pinnedAlready = true;
            if (pinnedAlready) {
                sm.updateShortcuts(Collections.singletonList(info));
                return null;
            }
            return sm.requestPinShortcut(info, null) ? null : "launcher refused the request";
        } catch (Exception e) {
            return String.valueOf(e.getMessage());
        }
    }

    private static String appLabel(PackageManager pm, String pkg) {
        try {
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            return String.valueOf(pm.getApplicationLabel(ai));
        } catch (PackageManager.NameNotFoundException e) {
            return pkg;
        }
    }

    private static Bitmap appIcon(PackageManager pm, String pkg) {
        try {
            return toBitmap(pm.getApplicationIcon(pkg));
        } catch (Exception e) {
            return null;
        }
    }

    private static Bitmap toBitmap(Drawable d) {
        if (d instanceof BitmapDrawable && ((BitmapDrawable) d).getBitmap() != null)
            return ((BitmapDrawable) d).getBitmap();
        int w = Math.max(1, Math.min(d.getIntrinsicWidth() > 0 ? d.getIntrinsicWidth() : 192, 512));
        int h = Math.max(1, Math.min(d.getIntrinsicHeight() > 0 ? d.getIntrinsicHeight() : 192, 512));
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        d.setBounds(0, 0, w, h);
        d.draw(c);
        return bmp;
    }

    /** data URL（页面传来的）→ Bitmap；解析不了返回 null */
    static Bitmap fromDataUrl(String dataUrl) {
        if (dataUrl == null || dataUrl.isEmpty()) return null;
        try {
            int comma = dataUrl.indexOf(',');
            byte[] bytes = Base64.decode(comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl, Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (Exception e) {
            return null;
        }
    }

    /** http(s) 图标下载（≤2MB）；在后台线程调用；失败返回 null（退回默认图标） */
    static Bitmap download(String url) {
        if (url == null || !url.matches("(?i)^https?://.+")) return null;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (out.size() > MAX_ICON_BYTES) return null;
                }
                byte[] bytes = out.toByteArray();
                return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
