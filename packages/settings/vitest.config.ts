import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The database tests create their own database (see @repo/db/testing), which can take
    // a while on a cold machine.
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
