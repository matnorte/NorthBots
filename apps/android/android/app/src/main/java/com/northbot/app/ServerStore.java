package com.northbot.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** The few things the shell remembers: which NorthBot server to open and what it already notified. */
final class ServerStore {

    private static final String PREFS = "northbot_shell";
    private static final String KEY_SERVER = "server_url";
    private static final String KEY_SEEN = "seen_ids";
    private static final String KEY_SEEDED = "seen_seeded";
    private static final int MAX_SEEN = 500;

    private ServerStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The saved server origin, e.g. "https://bots.example.com", or null before setup. */
    static String getServer(Context context) {
        return prefs(context).getString(KEY_SERVER, null);
    }

    static void setServer(Context context, String url) {
        // A new server means new ids: start the notification history over.
        prefs(context).edit().putString(KEY_SERVER, url).remove(KEY_SEEN).remove(KEY_SEEDED).apply();
    }

    /**
     * Turns what a person typed ("bots.example.com", "https://bots.example.com/app/") into an origin.
     * Returns null when it is not a usable http(s) address.
     */
    static String normalize(String input) {
        if (input == null) return null;
        String s = input.trim();
        if (s.isEmpty()) return null;
        if (!s.matches("(?i)^https?://.*")) s = "https://" + s;
        Uri uri = Uri.parse(s);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        String host = uri.getHost();
        if (!(scheme.equals("https") || scheme.equals("http")) || host == null || host.isEmpty()) return null;
        String origin = scheme + "://" + host.toLowerCase();
        if (uri.getPort() != -1) origin += ":" + uri.getPort();
        return origin;
    }

    static boolean isSeeded(Context context) {
        return prefs(context).getBoolean(KEY_SEEDED, false);
    }

    static Set<String> seenIds(Context context) {
        String raw = prefs(context).getString(KEY_SEEN, "");
        Set<String> out = new HashSet<>();
        for (String id : raw.split(",")) if (!id.isEmpty()) out.add(id);
        return out;
    }

    /** Remembers ids in order (oldest first), keeping only the newest few hundred. */
    static void rememberIds(Context context, List<String> current, Set<String> previous) {
        List<String> merged = new ArrayList<>();
        String raw = prefs(context).getString(KEY_SEEN, "");
        for (String id : raw.split(",")) if (!id.isEmpty()) merged.add(id);
        for (String id : current) if (!previous.contains(id) && !merged.contains(id)) merged.add(id);
        while (merged.size() > MAX_SEEN) merged.remove(0);
        prefs(context).edit().putString(KEY_SEEN, String.join(",", merged)).putBoolean(KEY_SEEDED, true).apply();
    }
}
