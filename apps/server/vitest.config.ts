import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // Tests share one Postgres; run files one at a time to keep state predictable.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
