import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
