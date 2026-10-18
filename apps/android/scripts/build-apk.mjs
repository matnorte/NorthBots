// Builds the NorthBot APK: node scripts/build-apk.mjs debug|release
// Finds a JDK (JAVA_HOME, else Android Studio's bundled one) and the Android SDK (ANDROID_HOME,
// else the default per-user location), syncs Capacitor, runs Gradle and copies the APK to dist/.
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const type = process.argv[2] === "release" ? "release" : "debug";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const androidDir = join(root, "android");
const win = platform() === "win32";

function firstExisting(paths) {
  return paths.find((p) => p && existsSync(p));
}

const javaHome = firstExisting([
  process.env.JAVA_HOME,
  win && "C:/Program Files/Android/Android Studio/jbr",
  !win && "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
  !win && "/opt/android-studio/jbr",
]);
if (!javaHome) {
  console.error("No JDK found. Install Android Studio (it bundles one) or a JDK 21+, then set JAVA_HOME.");
  process.exit(1);
}
const sdk = firstExisting([
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  win && process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Android", "Sdk"),
  !win && join(homedir(), "Library", "Android", "sdk"),
  !win && join(homedir(), "Android", "Sdk"),
]);
if (!sdk) {
  console.error("No Android SDK found. Open Android Studio once (it installs the SDK) or set ANDROID_HOME.");
  process.exit(1);
}
const localProps = join(androidDir, "local.properties");
if (!existsSync(localProps)) writeFileSync(localProps, `sdk.dir=${sdk.replaceAll("\\", "/")}\n`);

if (type === "release") {
  const hasProps = existsSync(join(androidDir, "keystore.properties"));
  if (!hasProps && !process.env.NORTHBOT_KEYSTORE_FILE) {
    console.error(
      "Release builds need a signing key. Copy android/keystore.properties.example to android/keystore.properties\n" +
        "and fill it in (or set NORTHBOT_KEYSTORE_* variables). See README.md.",
    );
    process.exit(1);
  }
}

const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk };
console.log(`JDK: ${javaHome}\nSDK: ${sdk}`);
execSync("npx cap sync android", { cwd: root, stdio: "inherit", env });
const gradlew = join(androidDir, win ? "gradlew.bat" : "gradlew");
const task = type === "release" ? "assembleRelease" : "assembleDebug";
execSync(`"${gradlew}" ${task} --console=plain`, { cwd: androidDir, stdio: "inherit", env });

const version = /versionName "([^"]+)"/.exec(readFileSync(join(androidDir, "app", "build.gradle"), "utf8"))?.[1] ?? "0";
const built = join(androidDir, "app", "build", "outputs", "apk", type, `app-${type}.apk`);
mkdirSync(join(root, "dist"), { recursive: true });
const out = join(root, "dist", `northbot-${version}-${type}.apk`);
copyFileSync(built, out);
console.log(`\nAPK ready: ${out}`);
