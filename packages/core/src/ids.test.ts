import { describe, expect, it } from "vitest";

import { BusinessId, type ConversationId, IsoDateTime, newTraceId, TraceId } from "./ids";

describe("branded ids", () => {
  it("parses UUIDs and rejects anything else", () => {
    const value = "9a1c3e5f-2b4d-4f6a-8c0e-1d3f5a7b9c03";
    expect(BusinessId.parse(value)).toBe(value);
    expect(BusinessId.safeParse("acme-roofing").success).toBe(false);
    expect(BusinessId.safeParse("").success).toBe(false);
    expect(BusinessId.safeParse(42).success).toBe(false);
  });

  it("generates trace ids that pass their own schema", () => {
    const first = newTraceId();
    const second = newTraceId();
    expect(TraceId.safeParse(first).success).toBe(true);
    expect(first).not.toBe(second);
  });

  it("keeps different id types apart at compile time", () => {
    const businessId = BusinessId.parse("9a1c3e5f-2b4d-4f6a-8c0e-1d3f5a7b9c03");

    // These lines are the test: `tsc` fails on an unused @ts-expect-error, so if the brands
    // are ever lost (ids become plain strings again) `pnpm typecheck` goes red.
    // @ts-expect-error a plain string is not a BusinessId
    const fromString: BusinessId = "9a1c3e5f-2b4d-4f6a-8c0e-1d3f5a7b9c03";
    // @ts-expect-error a BusinessId is not a ConversationId
    const crossed: ConversationId = businessId;

    const asString: string = businessId;
    expect([fromString, crossed, asString]).toHaveLength(3);
  });
});

describe("IsoDateTime", () => {
  it("requires a full timestamp with an offset", () => {
    expect(IsoDateTime.safeParse("2026-11-11T18:30:00.000Z").success).toBe(true);
    expect(IsoDateTime.safeParse("2026-11-11T12:30:00-06:00").success).toBe(true);
    expect(IsoDateTime.safeParse("2026-11-11T18:30:00").success).toBe(false);
    expect(IsoDateTime.safeParse("2026-11-11").success).toBe(false);
    expect(IsoDateTime.safeParse("yesterday").success).toBe(false);
  });
});
