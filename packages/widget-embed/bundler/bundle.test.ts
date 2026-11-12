import { describe, expect, it } from "vitest";

import { WIDGET_SCRIPT, WIDGET_SCRIPT_SHA256, WIDGET_SCRIPT_VERSION } from "../src/index";
import { bundleWidget, GZIP_BUDGET_BYTES, RAW_BUDGET_BYTES } from "./bundle";

describe("the embed script", () => {
  it("is up to date with src/browser (run `pnpm --filter @repo/widget-embed build`)", async () => {
    const bundle = await bundleWidget();
    expect(WIDGET_SCRIPT_SHA256).toBe(bundle.sha256);
    expect(WIDGET_SCRIPT).toBe(bundle.code);
    expect(WIDGET_SCRIPT_VERSION).toBe(bundle.sha256.slice(0, 12));
  });

  it("stays small enough not to slow the host page", async () => {
    const bundle = await bundleWidget();
    console.log(`widget.js: ${bundle.rawBytes} bytes, ${bundle.gzipBytes} bytes gzipped`);
    expect(bundle.gzipBytes).toBeLessThanOrEqual(GZIP_BUDGET_BYTES);
    expect(bundle.rawBytes).toBeLessThanOrEqual(RAW_BUDGET_BYTES);
  });

  it("is self-contained and never writes server data as HTML", () => {
    // One IIFE: no imports, no module syntax, nothing global but its own flag.
    expect(WIDGET_SCRIPT).not.toMatch(/\bimport\s*[({"']|\brequire\(/);
    expect(WIDGET_SCRIPT).toMatch(/^"use strict";\(\(\)=>\{/);
    // innerHTML is used for the fixed icons only; eval and document.write never.
    expect(WIDGET_SCRIPT).not.toMatch(/\beval\(|document\.write|outerHTML|insertAdjacentHTML/);
    expect(WIDGET_SCRIPT.match(/\.innerHTML=/g)?.length ?? 0).toBe(1);
    // No Zod: the protocol types are erased at build time.
    expect(WIDGET_SCRIPT).not.toContain("ZodError");
    // Never sends cookies.
    expect(WIDGET_SCRIPT).toContain('credentials:"omit"');
  });
});
