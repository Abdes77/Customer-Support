import { existsSync } from "node:fs";

import { defineConfig } from "@playwright/test";

import { APP_URL, SITE_PORT, SITE_URL } from "./e2e/support/config";

/**
 * `pnpm e2e`: browser tests against a production build of the app (`next build`, then `next
 * start`) on a fresh database (e2e/support/app-server.ts) and a sample business website on two
 * origins (e2e/support/sample-site.ts). Needs local PostgreSQL (`pnpm services:up`) and a
 * Chromium for Playwright (`pnpm exec playwright install chromium`, or set
 * PLAYWRIGHT_CHROMIUM_PATH). Port 3100 must be free. The build replaces `apps/web/.next` (not
 * `.next/dev`, so a running `pnpm dev` is unaffected); do not run another `next build` of this
 * app at the same time.
 */
const chromium =
  process.env["PLAYWRIGHT_CHROMIUM_PATH"] ??
  // Build machines that ship a Chromium for an older Playwright.
  (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: SITE_URL,
    trace: "off",
    browserName: "chromium",
    ...(chromium === undefined ? {} : { launchOptions: { executablePath: chromium } }),
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      },
    },
  ],
  webServer: [
    {
      command: "pnpm exec tsx e2e/support/app-server.ts",
      // Ready when the sign-in page renders (proxy, page and database), not just the process.
      url: `${APP_URL}/sign-in`,
      // SIGTERM lets the script drop its database (the default is SIGKILL).
      gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
      // `next build` (about 30 to 60 s here, longer on a cold CI machine), then the database.
      timeout: 480_000,
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "pnpm exec tsx e2e/support/sample-site.ts",
      url: `http://127.0.0.1:${SITE_PORT}/health`,
      timeout: 30_000,
      reuseExistingServer: false,
    },
  ],
});
