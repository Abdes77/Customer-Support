import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    // Unit tests only. Playwright specs live in apps/web/e2e and run with `pnpm e2e`.
    include: ["src/**/*.test.{ts,tsx}"],
    // Some tests use a real database (@repo/db/testing); creating one can take a while on
    // a cold machine.
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
