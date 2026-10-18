#!/usr/bin/env node
// Prepare the versioned wiki for GitHub's separate wiki repository; never publish.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const repo = args.includes("--repo") ? option("--repo") : "";
const output = args.includes("--output") ? option("--output") : "";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !output || output.startsWith("--")) {
  throw new Error("Usage: node scripts/prepare-wiki.mjs --repo owner/repo --output directory");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "docs", "wiki");
const target = resolve(output);
const sourceRelative = relative(source, target);
if (
  sourceRelative === "" ||
  (!isAbsolute(sourceRelative) && sourceRelative !== ".." && !sourceRelative.startsWith(`..${sep}`))
) {
  throw new Error("Output must be outside docs/wiki so the versioned source stays intact.");
}
const repoUrl = `https://github.com/${repo}`;
const pages = (await readdir(source)).filter((name) => name.endsWith(".md"));
await mkdir(target, { recursive: true });
for (const name of pages) {
  const text = await readFile(join(source, name), "utf8");
  const rewritten = text.replace(/(!?\[[^\]]*\]\()([^\s)]+)(\))/g, (full, before, href, after) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return full;
    const [path, anchor] = href.split("#", 2);
    if (!path) return full;
    const local = resolve(source, decodeURIComponent(path));
    const pagePath = relative(source, local);
    if (pages.includes(pagePath))
      return `${before}${repoUrl}/wiki/${encodeURIComponent(pagePath.slice(0, -3))}${anchor ? `#${anchor}` : ""}${after}`;
    const repoPath = relative(root, local);
    if (repoPath.startsWith("..") || isAbsolute(repoPath))
      throw new Error(`Link leaves repository: ${href}`);
    const type =
      before.startsWith("!") || [".png", ".webp", ".jpg", ".svg"].includes(extname(local))
        ? "raw"
        : "blob";
    const url = repoPath.split(/[\\/]/).map(encodeURIComponent).join("/");
    return `${before}${repoUrl}/${type}/main/${url}${anchor ? `#${anchor}` : ""}${after}`;
  });
  await writeFile(join(target, name), rewritten, "utf8");
}
console.log(`Prepared ${pages.length} wiki files for ${repo} in ${target}`);
