package io.github.linuxcockpit.client;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.SystemClock;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 系统媒体控制：网页（WebView）里的 navigator.mediaSession 不会交给系统，这里由页面经
 * {@code media.update} 把元数据 / 播放状态 / 可用动作发过来（见 src/headless/native-media.ts），
 * 原生建一个 MediaSession + MediaStyle 通知 → 通知栏媒体卡片、锁屏控制、厂商的灵动岛类胶囊、
 * 蓝牙耳机按键都能用。系统按钮回到页面是事件 {@code media-action}。
 *
 * 通知与保活前台服务共用同一个 id：有媒体时把保活通知换成媒体卡片（不会多出一条），
 * 停止播放后换回保活通知；保活关着时就是一条普通通知。
 */
final class MediaBridge {
    static final String CHANNEL = "media";
    private static final String ACTION = "io.github.linuxcockpit.client.MEDIA_ACTION";

    /** 当前媒体通知；KeepAliveService 启动时优先用它（null = 没有正在播放的媒体） */
    static volatile Notification current;

    private final MainActivity act;
    private final NotificationManager nm;
    private final MediaSession session;
    private Bitmap art;
    private boolean registered;

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) {
            String a = i.getStringExtra("action");
            if (a != null) send(a, -1);
        }
    };

    MediaBridge(MainActivity act) {
        this.act = act;
        nm = act.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(
                CHANNEL, act.getString(R.string.media_channel), NotificationManager.IMPORTANCE_LOW));
        session = new MediaSession(act, "cockpit");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { send("play", -1); }
            @Override public void onPause() { send("pause", -1); }
            @Override public void onStop() { send("stop", -1); }
            @Override public void onSkipToNext() { send("nexttrack", -1); }
            @Override public void onSkipToPrevious() { send("previoustrack", -1); }
            @Override public void onSeekTo(long pos) { send("seekto", pos); }
        });
        session.setSessionActivity(PendingIntent.getActivity(act, 0,
                new Intent(act, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE));
        IntentFilter f = new IntentFilter(ACTION);
        if (Build.VERSION.SDK_INT >= 33) act.registerReceiver(receiver, f, Context.RECEIVER_NOT_EXPORTED);
        else act.registerReceiver(receiver, f);
        registered = true;
    }

    private void send(String action, long posMs) {
        try {
            JSONObject o = new JSONObject();
            o.put("action", action);
            if (posMs >= 0) o.put("position", posMs / 1000.0);
            act.emit("media-action", o);
        } catch (Exception ignored) {
        }
    }

    /** 页面推来的快照；在主线程调用 */
    void update(JSONObject a) {
        String state = a.optString("state", "none");
        if ("none".equals(state)) {
            clear();
            return;
        }
        if (a.has("artwork")) art = decode(a.optString("artwork", ""));

        boolean playing = "playing".equals(state);
        double duration = a.optDouble("duration", 0);
        double position = a.optDouble("position", 0);
        double rate = a.optDouble("rate", 1);
        String title = a.optString("title", "");
        String artist = a.optString("artist", "");
        String album = a.optString("album", "");

        MediaMetadata.Builder mb = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, album);
        if (duration > 0) mb.putLong(MediaMetadata.METADATA_KEY_DURATION, (long) (duration * 1000));
        if (art != null) mb.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
        session.setMetadata(mb.build());

        JSONArray acts = a.optJSONArray("actions");
        boolean prev = has(acts, "previoustrack"), next = has(acts, "nexttrack");
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE;
        if (prev) actions |= PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        if (next) actions |= PlaybackState.ACTION_SKIP_TO_NEXT;
        if (has(acts, "stop")) actions |= PlaybackState.ACTION_STOP;
        if (has(acts, "seekto") && duration > 0) actions |= PlaybackState.ACTION_SEEK_TO;
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(actions)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        (long) (position * 1000), playing ? (float) rate : 0f, SystemClock.elapsedRealtime())
                .build());
        session.setActive(true);

        Notification.Builder nb = new Notification.Builder(act, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(title.isEmpty() ? act.getString(R.string.app_name) : title)
                .setContentText(artist.isEmpty() ? album : artist)
                .setLargeIcon(art)
                .setContentIntent(session.getController().getSessionActivity())
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setOngoing(playing);
        int idx = 0;
        int[] compact = new int[3];
        int n = 0;
        if (prev) {
            nb.addAction(action(android.R.drawable.ic_media_previous, R.string.media_prev, "previoustrack", 1));
            compact[n++] = idx++;
        }
        nb.addAction(playing
                ? action(android.R.drawable.ic_media_pause, R.string.media_pause, "pause", 2)
                : action(android.R.drawable.ic_media_play, R.string.media_play, "play", 3));
        compact[n++] = idx++;
        if (next) {
            nb.addAction(action(android.R.drawable.ic_media_next, R.string.media_next, "nexttrack", 4));
            compact[n++] = idx;
        }
        int[] shown = new int[n];
        System.arraycopy(compact, 0, shown, 0, n);
        nb.setStyle(new Notification.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(shown));
        Notification notif = nb.build();
        current = notif;
        try {
            nm.notify(KeepAliveService.NOTIFICATION_ID, notif);
        } catch (SecurityException ignored) {
            // 没有通知权限：MediaSession 仍然生效（锁屏 / 耳机按键）
        }
    }

    private Notification.Action action(int icon, int label, String name, int req) {
        Intent i = new Intent(ACTION).setPackage(act.getPackageName()).putExtra("action", name);
        PendingIntent pi = PendingIntent.getBroadcast(act, req, i,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Action.Builder(Icon.createWithResource(act, icon), act.getString(label), pi).build();
    }

    private static boolean has(JSONArray a, String name) {
        if (a == null) return false;
        for (int i = 0; i < a.length(); i++) if (name.equals(a.optString(i))) return true;
        return false;
    }

    private static Bitmap decode(String dataUrl) {
        if (dataUrl == null || dataUrl.isEmpty()) return null;
        try {
            int comma = dataUrl.indexOf(',');
            byte[] bytes = Base64.decode(comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl, Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (Exception e) {
            return null;
        }
    }

    /** 没有媒体了：会话下线，通知换回保活通知（保活没开就撤掉） */
    void clear() {
        if (current == null && !session.isActive()) return;
        current = null;
        session.setActive(false);
        if (KeepAliveService.running) nm.notify(KeepAliveService.NOTIFICATION_ID, KeepAliveService.build(act));
        else nm.cancel(KeepAliveService.NOTIFICATION_ID);
    }

    void release() {
        clear();
        session.release();
        if (registered) {
            try {
                act.unregisterReceiver(receiver);
            } catch (Exception ignored) {
            }
            registered = false;
        }
    }
}
