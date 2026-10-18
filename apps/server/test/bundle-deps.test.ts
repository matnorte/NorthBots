import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as { name: string; dependencies?: Record<string, string> };

/**
 * The server bundle inlines @northbot/* workspace packages (they ship TypeScript). Their npm
 * dependencies are then imported from the server's own node_modules in production, so each one
 * must also be a server dependency — otherwise tsup inlines CommonJS code and boot fails.
 */
describe("server production bundle", () => {
  it("declares every npm dependency of the workspace packages it bundles", () => {
    const server = read("apps/server/package.json");
    const declared = new Set(Object.keys(server.dependencies ?? {}));
    const seen = new Set<string>();
    const missing: string[] = [];
    const visit = (pkg: string) => {
      if (seen.has(pkg)) return;
      seen.add(pkg);
      const manifest = read(`packages/${pkg.replace("@northbot/", "")}/package.json`);
      for (const dep of Object.keys(manifest.dependencies ?? {})) {
        if (dep.startsWith("@northbot/")) visit(dep);
        else if (!declared.has(dep)) missing.push(`${dep} (needed by ${pkg})`);
      }
    };
    for (const dep of declared) if (dep.startsWith("@northbot/")) visit(dep);
    expect(missing).toEqual([]);
  });
});
