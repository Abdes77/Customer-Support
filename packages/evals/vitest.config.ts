import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The sandbox creates its own database (see @repo/db/testing), which can take a while on
    // a cold machine, and a suite run plays dozens of conversations.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
