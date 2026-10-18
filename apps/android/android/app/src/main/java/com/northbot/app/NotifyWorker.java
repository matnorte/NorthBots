package com.northbot.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Checks the server every ~15 minutes (Android's minimum for background work) for pending approvals,
 * letters that need a human and unread agent notes, and shows a phone notification for new ones.
 * It signs in with the app's own session cookie, so it stops quietly when you are logged out.
 * No push service is involved: nothing leaves your phone except requests to your own server.
 */
public class NotifyWorker extends Worker {

    private static final String WORK_NAME = "northbot-poll";
    static final String CHANNEL_APPROVALS = "approvals";
    static final String CHANNEL_UPDATES = "updates";

    public NotifyWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void schedule(Context context) {
        createChannels(context);
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(NotifyWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req);
    }

    private static final class Item {

        final String id;
        final String channel;
        final String title;
        final String text;
        final String view;

        Item(String id, String channel, String title, String text, String view) {
            this.id = id;
            this.channel = channel;
            this.title = title;
            this.text = text;
            this.view = view;
        }
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        String server = ServerStore.getServer(ctx);
        if (server == null) return Result.success();
        String cookie = cookieFor(server);
        if (cookie == null || cookie.isEmpty()) return Result.success();

        List<Item> items = new ArrayList<>();
        try {
            JSONObject approvals = get(server + "/api/approvals?status=pending", cookie);
            if (approvals == null) return Result.success(); // logged out
            JSONArray list = approvals.optJSONArray("approvals");
            for (int i = 0; list != null && i < list.length(); i++) {
                JSONObject a = list.getJSONObject(i);
                String who = a.isNull("agentName") ? ctx.getString(R.string.notify_someone) : a.optString("agentName");
                items.add(
                    new Item(
                        "a:" + a.getString("id"),
                        CHANNEL_APPROVALS,
                        ctx.getString(R.string.notify_approval_title, who),
                        a.optString("summary"),
                        "approvals"
                    )
                );
            }
            JSONObject letters = get(server + "/api/letters?status=needs_human", cookie);
            JSONArray ls = letters == null ? null : letters.optJSONArray("letters");
            for (int i = 0; ls != null && i < ls.length(); i++) {
                JSONObject l = ls.getJSONObject(i);
                items.add(
                    new Item(
                        "l:" + l.getString("id"),
                        CHANNEL_UPDATES,
                        ctx.getString(R.string.notify_letter_title, l.optString("subject")),
                        l.optString("body"),
                        "letters"
                    )
                );
            }
            JSONObject notes = get(server + "/api/notifications", cookie);
            JSONArray ns = notes == null ? null : notes.optJSONArray("notifications");
            for (int i = 0; ns != null && i < ns.length(); i++) {
                JSONObject n = ns.getJSONObject(i);
                if (n.optBoolean("read")) continue;
                items.add(new Item("n:" + n.getString("id"), CHANNEL_UPDATES, ctx.getString(R.string.app_name), n.optString("body"), null));
            }
        } catch (Exception e) {
            return Result.retry();
        }

        Set<String> seen = ServerStore.seenIds(ctx);
        // The first check after setup only learns what is already there, so nobody gets a flood.
        boolean announce = ServerStore.isSeeded(ctx) && !MainActivity.visible;
        List<String> ids = new ArrayList<>();
        for (Item item : items) {
            ids.add(item.id);
            if (announce && !seen.contains(item.id)) show(ctx, item);
        }
        ServerStore.rememberIds(ctx, ids, seen);
        return Result.success();
    }

    /** CookieManager belongs to the WebView; read it on the main thread to be safe. */
    private static String cookieFor(String url) {
        AtomicReference<String> out = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                out.set(CookieManager.getInstance().getCookie(url));
            } catch (Exception ignored) {
                // No WebView available: nothing to sign in with.
            } finally {
                done.countDown();
            }
        });
        try {
            done.await(10, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return out.get();
    }

    /** GET as the signed-in person. Returns null on 401 (logged out); throws on other failures. */
    private static JSONObject get(String url, String cookie) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setRequestProperty("Cookie", cookie);
            conn.setRequestProperty("Accept", "application/json");
            int code = conn.getResponseCode();
            if (code == 401) return null;
            if (code != 200) throw new Exception("HTTP " + code);
            return new JSONObject(NorthBotShellPlugin.readAll(conn.getInputStream()));
        } finally {
            conn.disconnect();
        }
    }

    private static void show(Context ctx, Item item) {
        if (
            Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return;
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (item.view != null) open.putExtra(MainActivity.EXTRA_VIEW, item.view);
        PendingIntent pi = PendingIntent.getActivity(
            ctx,
            item.id.hashCode(),
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        String text = item.text.length() > 280 ? item.text.substring(0, 280) + "…" : item.text;
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, item.channel)
            .setSmallIcon(R.drawable.ic_stat_northbot)
            .setColor(0xFF6C8CFF)
            .setContentTitle(item.title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setPriority(CHANNEL_APPROVALS.equals(item.channel) ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT);
        try {
            NotificationManagerCompat.from(ctx).notify(item.id.hashCode(), b.build());
        } catch (SecurityException ignored) {
            // Permission was withdrawn between the check and the post.
        }
    }

    private static void createChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(
            new NotificationChannel(CHANNEL_APPROVALS, ctx.getString(R.string.channel_approvals), NotificationManager.IMPORTANCE_HIGH)
        );
        nm.createNotificationChannel(
            new NotificationChannel(CHANNEL_UPDATES, ctx.getString(R.string.channel_updates), NotificationManager.IMPORTANCE_DEFAULT)
        );
    }
}
