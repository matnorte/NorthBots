package com.northbot.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.CapConfig;
import com.getcapacitor.PluginHandle;
import org.json.JSONObject;

/**
 * The NorthBot app is a window onto your own NorthBot server. Before a server is chosen it shows the
 * bundled setup screen (www/index.html); after that it opens the server itself, so the session
 * cookie, /api calls and the office websocket all stay same-origin, exactly like in a browser.
 */
public class MainActivity extends BridgeActivity {

    static final String EXTRA_SETUP = "com.northbot.app.SETUP";
    static final String EXTRA_VIEW = "com.northbot.app.VIEW";

    /** True while the app is on screen; the notification worker stays quiet then. */
    static volatile boolean visible = false;

    private String server;
    private View offlineView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NorthBotShellPlugin.class);
        Intent intent = getIntent();
        boolean setup = wantsSetup(intent);
        server = setup ? null : ServerStore.getServer(this);
        String view = intent.getStringExtra(EXTRA_VIEW);
        if (view != null) NorthBotShellPlugin.setPendingView(view);
        config = buildConfig(server);
        // The setup screen is a fresh start; never restore a previous page into it.
        super.onCreate(server == null ? null : savedInstanceState);
        if (bridge == null || server == null) return;

        bridge.setWebViewClient(new ShellWebViewClient(bridge));
        bridge.getWebView().setDownloadListener(this::download);
        NotifyWorker.schedule(this);
        askForNotifications();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Capacitor also calls this with the launch intent, so only restart when not on setup already.
        if (wantsSetup(intent)) {
            if (server != null) restart(this, true);
            return;
        }
        String view = intent.getStringExtra(EXTRA_VIEW);
        NorthBotShellPlugin shell = shell();
        if (view != null && shell != null) shell.deliverView(view);
    }

    @Override
    public void onResume() {
        super.onResume();
        visible = true;
    }

    @Override
    public void onPause() {
        super.onPause();
        visible = false;
        CookieManager.getInstance().flush();
    }

    /** Reopens the app from scratch: on the saved server, or on the setup screen. */
    static void restart(Activity activity, boolean setup) {
        Intent i = new Intent(activity, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        if (setup) i.putExtra(EXTRA_SETUP, true);
        activity.startActivity(i);
        activity.finish();
    }

    /** The launcher shortcut sends the extra as the text "true"; code sends a real boolean. */
    private static boolean wantsSetup(Intent intent) {
        Bundle extras = intent.getExtras();
        Object value = extras == null ? null : extras.get(EXTRA_SETUP);
        return Boolean.TRUE.equals(value) || "true".equals(value);
    }

    private NorthBotShellPlugin shell() {
        if (bridge == null) return null;
        PluginHandle handle = bridge.getPlugin("NorthBotShell");
        return handle == null ? null : (NorthBotShellPlugin) handle.getInstance();
    }

    /** capacitor.config.json plus the chosen server, decided at launch instead of at build time. */
    private CapConfig buildConfig(String serverUrl) {
        try {
            JSONObject json = new JSONObject(NorthBotShellPlugin.readAll(getAssets().open("capacitor.config.json")));
            JSONObject android = json.optJSONObject("android");
            if (android == null) android = new JSONObject();
            android.put("webContentsDebuggingEnabled", (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
            json.put("android", android);
            if (serverUrl != null) {
                JSONObject s = json.optJSONObject("server");
                if (s == null) s = new JSONObject();
                s.put("url", serverUrl);
                json.put("server", s);
            }
            return new CapConfig(getAssets(), json);
        } catch (Exception e) {
            return CapConfig.loadDefault(this);
        }
    }

    private void askForNotifications() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, 7);
    }

    // ---- Downloads (memory export, chat files, audit logs) -------------------------------------

    private void download(String url, String userAgent, String contentDisposition, String mimeType, long length) {
        if (url.startsWith("blob:") || url.startsWith("data:")) {
            // Made in the page; ask the page for the bytes and save them natively.
            String js =
                "(async()=>{try{const b=await (await fetch(" + JSONObject.quote(url) + ")).blob();" +
                "const r=new FileReader();r.onload=()=>window.Capacitor.nativePromise('NorthBotShell','saveFile'," +
                "{data:String(r.result).split(',')[1]||'',mime:b.type||" + JSONObject.quote(mimeType == null ? "" : mimeType) + "});" +
                "r.readAsDataURL(b);}catch(e){console.error(e)}})()";
            bridge.getWebView().evaluateJavascript(js, null);
            return;
        }
        try {
            String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) req.addRequestHeader("Cookie", cookie);
            req.addRequestHeader("User-Agent", userAgent);
            req.setMimeType(mimeType);
            req.setTitle(name);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            if (Build.VERSION.SDK_INT >= 29) req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            else req.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name);
            ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(req);
            Toast.makeText(this, getString(R.string.download_started, name), Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show();
        }
    }

    // ---- Offline screen -----------------------------------------------------------------------

    void showOffline(String reason) {
        runOnUiThread(() -> {
            if (offlineView != null) return;
            offlineView = buildOfflineView(reason);
            addContentView(offlineView, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        });
    }

    private void hideOffline() {
        if (offlineView == null) return;
        ((ViewGroup) offlineView.getParent()).removeView(offlineView);
        offlineView = null;
    }

    private View buildOfflineView(String reason) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.parseColor("#101114"));
        int pad = dp(28);
        box.setPadding(pad, pad, pad, pad);
        box.setClickable(true);

        TextView title = text(getString(R.string.offline_title), 22, "#FFFFFF");
        TextView where = text(server, 15, "#A9B1C6");
        TextView why = text(reason == null ? "" : reason, 13, "#7C849B");
        Button retry = new Button(this);
        retry.setText(R.string.offline_retry);
        retry.setOnClickListener(v -> {
            hideOffline();
            bridge.getWebView().loadUrl(server);
        });
        Button change = new Button(this);
        change.setText(R.string.offline_change_server);
        change.setOnClickListener(v -> restart(this, true));

        box.addView(title);
        box.addView(where);
        box.addView(why);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(220), ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(16);
        box.addView(retry, lp);
        box.addView(change, new LinearLayout.LayoutParams(lp));
        return box;
    }

    private TextView text(String s, int sp, String color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(Color.parseColor(color));
        t.setGravity(Gravity.CENTER);
        t.setPadding(0, dp(6), 0, dp(6));
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** Capacitor's client, plus: show the offline screen when the server page itself cannot load. */
    private class ShellWebViewClient extends BridgeWebViewClient {

        ShellWebViewClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) showOffline(String.valueOf(error.getDescription()));
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            super.onReceivedHttpError(view, request, response);
            if (request.isForMainFrame() && response.getStatusCode() >= 500) showOffline("HTTP " + response.getStatusCode());
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            // Never accept a bad certificate; explain instead of showing a blank page.
            handler.cancel();
            if (error.getUrl() != null && error.getUrl().startsWith(server)) showOffline(getString(R.string.offline_certificate));
        }
    }
}
