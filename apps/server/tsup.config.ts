import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // Workspace packages ship TypeScript source, so they are bundled in.
  noExternal: [/^@northbot\//],
});
