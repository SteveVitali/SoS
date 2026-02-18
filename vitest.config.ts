import { defineConfig } from "vitest/config";

// biome-ignore lint/style/noDefaultExport: vitest requires default export
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist", "dist-ui"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
