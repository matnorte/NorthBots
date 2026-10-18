import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // Workspace packages ship TypeScript source, so they are bundled in. Their npm deps
  // (provider SDKs etc.) must also be listed in this package.json so `pnpm deploy` ships them.
  noExternal: [/^@northbot\//],
});
