import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["bundler/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
