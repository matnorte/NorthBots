package com.northbot.app;

import android.util.Base64;
import android.webkit.MimeTypeMap;
import android.widget.Toast;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import org.json.JSONObject;

/**
 * What the pages can ask the app for. The setup screen (www/index.html) uses getServer/setServer;
 * the NorthBot web app (apps/web/src/native.ts) uses takeLaunchView and listens for "openView".
 */
@CapacitorPlugin(name = "NorthBotShell")
public class NorthBotShellPlugin extends Plugin {

    /** A view a notification asked to open before the page was ready to hear it. */
    private static String pendingView;

    static void setPendingView(String view) {
        pendingView = view;
    }

    /** Tells a loaded page to open a view, or keeps it for the page to take once it loads. */
    void deliverView(String view) {
        if (!hasListeners("openView")) {
            pendingView = view;
            return;
        }
        JSObject data = new JSObject();
        data.put("view", view);
        notifyListeners("openView", data);
    }

    @PluginMethod
    public void getServer(PluginCall call) {
        JSObject out = new JSObject();
        out.put("url", ServerStore.getServer(getContext()));
        call.resolve(out);
    }

    /** Checks {url}/api/health, saves the origin and reopens the app on it. force skips the check. */
    @PluginMethod
    public void setServer(PluginCall call) {
        String url = ServerStore.normalize(call.getString("url"));
        boolean force = Boolean.TRUE.equals(call.getBoolean("force", false));
        if (url == null) {
            call.reject("That does not look like a web address.", "bad_url");
            return;
        }
        new Thread(() -> {
            if (!force) {
                String problem = checkHealth(url);
                if (problem != null) {
                    call.reject(problem, "unreachable");
                    return;
                }
            }
            ServerStore.setServer(getContext(), url);
            JSObject out = new JSObject();
            out.put("url", url);
            call.resolve(out);
            getActivity().runOnUiThread(() -> MainActivity.restart(getActivity(), false));
        }).start();
    }

    @PluginMethod
    public void changeServer(PluginCall call) {
        call.resolve();
        getActivity().runOnUiThread(() -> MainActivity.restart(getActivity(), true));
    }

    /** Leaves the setup screen without changing anything (only offered when a server is saved). */
    @PluginMethod
    public void openServer(PluginCall call) {
        if (ServerStore.getServer(getContext()) == null) {
            call.reject("No server yet.", "no_server");
            return;
        }
        call.resolve();
        getActivity().runOnUiThread(() -> MainActivity.restart(getActivity(), false));
    }

    /** Saves a file the page built itself (a blob: download) into Downloads. */
    @PluginMethod
    public void saveFile(PluginCall call) {
        String data = call.getString("data", "");
        String mime = call.getString("mime", "application/octet-stream");
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
            String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
            String name = "northbot-" + stamp + (ext == null ? "" : "." + ext);
            Downloads.save(getContext(), name, mime, bytes);
            getActivity().runOnUiThread(() ->
                Toast.makeText(getContext(), getContext().getString(R.string.download_saved, name), Toast.LENGTH_SHORT).show()
            );
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not save the file.", "save_failed", e);
        }
    }

    @PluginMethod
    public void takeLaunchView(PluginCall call) {
        JSObject out = new JSObject();
        out.put("view", pendingView);
        pendingView = null;
        call.resolve(out);
    }

    /** Returns null when the address answers like a NorthBot server, or a short reason when not. */
    static String checkHealth(String origin) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(origin + "/api/health").openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setInstanceFollowRedirects(true);
            int code = conn.getResponseCode();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String body = in == null ? "" : readAll(in);
            if (code != 200 && code != 503) return "The server answered with HTTP " + code + ".";
            JSONObject json = new JSONObject(body);
            if (!json.has("status") || !json.has("version")) return "That address is not a NorthBot server.";
            return null;
        } catch (javax.net.ssl.SSLException e) {
            return "Secure connection failed (" + e.getMessage() + "). Is the HTTPS certificate ready?";
        } catch (org.json.JSONException e) {
            return "That address is not a NorthBot server.";
        } catch (Exception e) {
            return "Could not reach the server (" + e.getClass().getSimpleName() + ").";
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    static String readAll(InputStream in) throws java.io.IOException {
        try (InputStream s = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = s.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
