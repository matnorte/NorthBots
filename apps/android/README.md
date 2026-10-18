# NorthBot for Android

An installable Android app (APK) for your own NorthBot server. It is a [Capacitor](https://capacitorjs.com)
shell: on first launch it asks for your server address (for example `https://bots.openclawchip.tech`),
then opens that server's web app full-screen. Every page works the same as in the browser, including
the Pixi office, chat, terminals and websockets, because the app loads the server's own origin.

## How it works

- **No server changes needed.** The app opens your server's origin directly, so the session cookie
  (`SameSite=Lax`), `/api` calls and websockets stay same-origin, just like a browser tab. `WEB_ORIGIN`,
  `COOKIE_SECURE` and CORS stay as they are. Since the app always runs the web build your server serves,
  updating the server updates the app's pages too; reinstall the APK only when this folder changes.
- **Setup screen** (`www/index.html`, bundled in the APK): asks for the address, checks
  `<address>/api/health`, saves it and reopens on it. To switch servers later, long-press the app
  icon and pick **Change server**, or use the button on the offline screen.
- **Offline screen**: if the server can't be reached (no network, server down, HTTPS certificate not
  issued yet), a native screen offers **Try again** and **Change server** instead of a blank page.
- **Back button**: NorthBot keeps pages in app state, not in the URL, so `apps/web/src/native.ts` keeps
  a short page history and the Android back button walks it. On the home page, back minimizes the app.
- **Safe areas**: Capacitor's SystemBars insets keep content clear of the status bar, gesture bar,
  notch and keyboard. The layout comes from the web app's responsive CSS.
- **Notifications**: about every 15 minutes (Android's minimum for background work), the app checks
  `GET /api/approvals?status=pending`, `GET /api/letters?status=needs_human` and
  `GET /api/notifications` with your session cookie, and shows a phone notification for anything new.
  Tapping one opens Approvals or Letters. The check after setup only learns what is already there,
  and nothing is shown while the app is open. No Google/Firebase push is used, so alerts can lag by
  up to ~15 minutes, and battery savers can delay them more.
  TODO for instant alerts: a server-side Web Push or FCM sender (the server has no push endpoint yet).
- **Downloads**: memory/schedule exports, chat files and the signed audit are saved to Downloads.
- **Passkeys**: Android WebView can't sign in with passkeys, so use email + password sign-in in the app.

## Build

You need Node 22+, pnpm, a JDK and the Android SDK. Android Studio ships both: install it from
https://developer.android.com/studio, open it once and let it install the SDK. The build script finds
Android Studio's JDK (`C:\Program Files\Android\Android Studio\jbr`) and the SDK
(`%LOCALAPPDATA%\Android\Sdk`) on its own; set `JAVA_HOME` / `ANDROID_HOME` if yours are elsewhere.

```bash
pnpm install
```

```bash
pnpm --filter @northbot/android apk:debug
```

The APK lands in `apps/android/dist/northbot-0.1.0-debug.apk`. The first build downloads Gradle and
Android libraries, which takes a few minutes.

Toolchain notes: the project uses Gradle 9.5 with Android Gradle Plugin 8.13, which runs on Android
Studio's bundled JDK 25. Gradle 9.6+ does not work with AGP 8.x. If Gradle reports a missing
`platforms;android-36`, open Android Studio → SDK Manager and install **Android 16 (API 36)**.

### Release build

A release APK must be signed with your own key. Never commit it: `*.jks`, `*.keystore` and
`keystore.properties` are git-ignored.

1. Create a key once (keep the file and passwords safe; every update must use the same key):

   ```bash
   keytool -genkeypair -v -keystore apps/android/northbot-release.jks -alias northbot -keyalg RSA -keysize 4096 -validity 10000
   ```

2. Copy `android/keystore.properties.example` to `android/keystore.properties` and fill in the
   passwords, or set `NORTHBOT_KEYSTORE_FILE`, `NORTHBOT_KEYSTORE_PASSWORD`, `NORTHBOT_KEY_ALIAS`,
   `NORTHBOT_KEY_PASSWORD` as environment variables.
3. Build:

   ```bash
   pnpm --filter @northbot/android apk:release
   ```

   The result is `apps/android/dist/northbot-0.1.0-release.apk`.

## Install on a phone

- **USB:** turn on Developer options → USB debugging on the phone, connect it, then:

  ```bash
  adb install -r apps/android/dist/northbot-0.1.0-debug.apk
  ```

  (`adb` is in `%LOCALAPPDATA%\Android\Sdk\platform-tools`.)
- **Without a cable:** copy the APK to the phone (Drive, Telegram, e-mail to yourself), open it and allow
  "Install unknown apps" for the app you opened it from.

The debug and release builds share the app id `com.northbot.app` but are signed with different keys, so
uninstall one before installing the other.

## Server checklist

- Use HTTPS (Caddy in `deploy/` does this). The app allows plain `http://` only for a server on your
  own network and warns about it on the setup screen.
- If the setup screen says "Secure connection failed", Caddy hasn't got its certificate yet: check that
  the domain's A record points at the server and ports 80/443 are open, then try again.
- Nothing else changes on the server: keep `WEB_ORIGIN=https://your-domain` and `COOKIE_SECURE=true`.

## Develop

- `www/index.html`: the setup screen. `android/app/src/main/java/com/northbot/app/`: the native code
  (`MainActivity` picks the server at launch, `NorthBotShellPlugin` is the JS bridge, `NotifyWorker`
  does the notification checks).
- `pnpm --filter @northbot/android sync` copies `www/` and `capacitor.config.json` into the Android project.
- `pnpm --filter @northbot/android open` opens the project in Android Studio for running on an emulator
  and debugging. In debug builds the WebView can be inspected from `chrome://inspect`.
- `pnpm --filter @northbot/android assets` redraws the icon and splash (`scripts/make-assets.mjs`).
