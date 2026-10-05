package io.github.linuxcockpit.client;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * 前台服务：只为让系统别在后台回收本进程（WebView 里的播放器、与宿主的 SSE 连接都在这个进程里）。
 * 本身不做任何事；应用退出时停止。正在放歌时前台通知就是 MediaBridge 的媒体卡片（同一个 id）。
 */
public class KeepAliveService extends Service {
    static final int NOTIFICATION_ID = 1;
    private static final String CHANNEL = "keepalive";
    static volatile boolean running;

    static Notification build(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(
                CHANNEL, ctx.getString(R.string.keepalive_channel), NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(ctx, 0,
                new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(ctx.getString(R.string.keepalive_title))
                .setContentText(ctx.getString(R.string.keepalive_text))
                .setContentIntent(open)
                .setOngoing(true)
                .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification media = MediaBridge.current;
        Notification n = media != null ? media : build(this);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NOTIFICATION_ID, n);
        running = true;
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
