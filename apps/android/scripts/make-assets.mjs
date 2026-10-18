// Draws the NorthBot icon and splash sources into assets/, then lets @capacitor/assets cut every
// Android size from them. Run with `pnpm --filter @northbot/android assets` after changing the art.
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(require_resolve("@capacitor/assets/package.json"));
const sharp = require("sharp");

function require_resolve(id) {
  return createRequire(join(root, "package.json")).resolve(id);
}

// Same tile as the web app's .brand-mark: pastel gradient, dark spark.
const gradient = `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#ead2cc"/><stop offset="0.6" stop-color="#c4b2fc"/><stop offset="1" stop-color="#a8d8d5"/>
</linearGradient>`;
const spark = (cx, cy, r) => {
  const p = (x, y) => `${cx + ((x - 12) / 9) * r},${cy + ((y - 12) / 9) * r}`;
  return `<path fill="#282135" d="M${p(12, 3)} L${p(14.5, 9.5)} L${p(21, 12)} L${p(14.5, 14.5)} L${p(12, 21)} L${p(9.5, 14.5)} L${p(3, 12)} L${p(9.5, 9.5)} Z"/>`;
};
const svg = (size, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs>${gradient}</defs>${body}</svg>`;

const files = {
  "icon-background.png": svg(1024, `<rect width="1024" height="1024" fill="url(#g)"/>`),
  // Adaptive icons crop to the middle ~66%, so the spark stays well inside it.
  "icon-foreground.png": svg(1024, spark(512, 512, 250)),
  "icon-only.png": svg(1024, `<rect width="1024" height="1024" rx="230" fill="url(#g)"/>${spark(512, 512, 330)}`),
  "splash.png": svg(2732, `<rect width="2732" height="2732" fill="#101114"/><rect x="1166" y="1166" width="400" height="400" rx="110" fill="url(#g)"/>${spark(1366, 1366, 130)}`),
};
files["splash-dark.png"] = files["splash.png"];

mkdirSync(join(root, "assets"), { recursive: true });
for (const [name, source] of Object.entries(files)) {
  await sharp(Buffer.from(source)).png().toFile(join(root, "assets", name));
  console.log("drew assets/" + name);
}
execSync("npx capacitor-assets generate --android --iconBackgroundColor #c4b2fc --splashBackgroundColor #101114 --splashBackgroundColorDark #101114", {
  cwd: root,
  stdio: "inherit",
});
