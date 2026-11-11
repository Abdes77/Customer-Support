import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Database tests: creating a test database or building the template can take a while
    // on a cold machine.
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
