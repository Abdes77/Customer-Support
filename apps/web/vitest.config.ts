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
  },
});
