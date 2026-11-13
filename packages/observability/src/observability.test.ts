import { describe, expect, it } from "vitest";

import { createLogger, ValidationError } from "@repo/core";

import { createMemoryRateLimiter } from "./limiter";
import { developmentSwitchCheck, emergencyReadinessCheck, summarize } from "./readiness";
import { installErrorReporting } from "./reporting";
import { MAX_SCRUB_INPUT, scrubPath, scrubText, scrubValue } from "./scrub";
import { createSentryClient, parseDsn, parseStack } from "./sentry";
import { createFakeSentryTransport } from "./testing";

const DSN = "https://abc123publickey@o4501.ingest.us.sentry.io/4507001";
const FIXED = () => new Date("2026-11-13T10:00:00.000Z");

describe("scrubText", () => {
  it("removes emails, phone numbers, tokens and URL queries from free text", () => {
    const text =
      "Send to jane.doe@example.com or call (303) 555-0142, +1 720-555-0199 or +447700900123; Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc; token=sk-ant-api03-AbCdEf123456; https://graph.facebook.com/v27.0/me?access_token=EAAB123secret&x=1";
    const out = scrubText(text);
    for (const leak of [
      "jane.doe",
      "555-0142",
      "720-555-0199",
      "447700900123",
      "eyJhbGci",
      "sk-ant",
      "EAAB123secret",
    ]) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain("[email]");
    expect(out).toContain("[phone]");
    expect(out).toContain("https://graph.facebook.com/v27.0/me?[query]");
  });

  it("keeps ids, dates, codes and event names readable", () => {
    const text =
      "turn 550e8400-e29b-41d4-a716-446655440000 failed at 2026-11-13T10:00:00.000Z with code 131047 in pipeline-send-message-failed";
    expect(scrubText(text)).toBe(text);
  });

  it("removes long opaque strings such as API keys and widget keys", () => {
    expect(scrubText("key hsrb_1a2b3c4d_Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8Ba7")).not.toContain(
      "Zx9Yw8",
    );
    expect(scrubText("wpk_a1b2c3d4e5f6g7h8i9j0k1l2")).toBe("[secret]");
  });

  it("cuts long text", () => {
    expect(scrubText("a".repeat(2000)).length).toBeLessThanOrEqual(501);
  });

  it("looks at a bounded part of the text, however long it is", () => {
    // Two megabytes of letters, as a customer could put into an error message. The email
    // pattern alone would take time quadratic in that length (minutes; the test would time
    // out): only the first MAX_SCRUB_INPUT characters are ever matched.
    const huge = `${"a".repeat(2_000_000)} jane@example.com`;
    const out = scrubText(huge);
    expect(out.length).toBeLessThanOrEqual(501);
    expect(out.endsWith("…")).toBe(true);
    // What is inside the bound is still scrubbed.
    const inside = scrubText(`${"word ".repeat(300)}jane@example.com ${"b".repeat(5000)}`);
    expect(inside).not.toContain("jane@example.com");
    expect(MAX_SCRUB_INPUT).toBeLessThanOrEqual(4000);
  });
});

describe("scrubValue and scrubPath", () => {
  it("redacts by field name, then scrubs every string", () => {
    const value = scrubValue({
      text: "My gas smells, I'm at 12 Elm St",
      phone: "+13035550142",
      note: ["write to bob@example.org"],
      inputTokens: 1200,
      nested: { refreshToken: "1//0gabc", detail: "Bearer abcdefghijklmnop" },
    }) as Record<string, unknown>;
    const json = JSON.stringify(value);
    expect(json).not.toContain("gas smells");
    expect(json).not.toContain("3035550142");
    expect(json).not.toContain("bob@example.org");
    expect(json).not.toContain("1//0gabc");
    expect(json).not.toContain("abcdefghijklmnop");
    expect(value["inputTokens"]).toBe(1200);
  });

  it("removes capabilities from paths and keeps the route's shape", () => {
    expect(
      scrubPath("/api/handoff/ack/3f1c9a8e-2b7d-4e6f-9a1b-2c3d4e5f6a7b.Xk9Lm2Np4Qr6St8Uv0Wx2Yz4"),
    ).toBe("/api/handoff/ack/[id]");
    expect(scrubPath("/api/webhooks/calendly/ck_8f7e6d5c4b3a2918?x=1")).toBe(
      "/api/webhooks/calendly/[id]",
    );
    expect(scrubPath("/inbox/550e8400-e29b-41d4-a716-446655440000")).toBe(
      "/inbox/550e8400-e29b-41d4-a716-446655440000",
    );
  });
});

describe("Sentry client", () => {
  it("parses DSNs and refuses what is not one", () => {
    expect(parseDsn(DSN)).toMatchObject({
      publicKey: "abc123publickey",
      projectId: "4507001",
      envelopeUrl: "https://o4501.ingest.us.sentry.io/api/4507001/envelope/",
    });
    expect(parseDsn("https://key@sentry.example.com/prefix/42")?.envelopeUrl).toBe(
      "https://sentry.example.com/prefix/api/42/envelope/",
    );
    expect(parseDsn("not a dsn")).toBeNull();
    expect(parseDsn("https://sentry.example.com/42")).toBeNull();
    expect(createSentryClient({ dsn: "nope", transport: async () => undefined })).toBeNull();
  });

  it("sends a scrubbed envelope with the exception, the tags and the trace", async () => {
    const fake = createFakeSentryTransport();
    const client = createSentryClient({
      dsn: DSN,
      transport: fake.transport,
      environment: "production",
      release: "abc123",
      now: FIXED,
      randomId: () => "0123456789abcdef0123456789abcdef",
    })!;
    const error = new ValidationError("Customer jane@example.com wrote +1 303 555 0142", {
      cause: new Error("inner token=abcdef123456"),
    });
    const id = client.captureException(error, {
      tags: { businessId: "b1", event: "turn.failed" },
      extra: { body: "I smell gas", attempts: 3 },
      traceId: "550e8400-e29b-41d4-a716-446655440000",
    });
    await client.flush();
    expect(id).toBe("0123456789abcdef0123456789abcdef");
    expect(fake.envelopes).toHaveLength(1);
    const [envelope] = fake.envelopes;
    expect(envelope!.request.url).toBe("https://o4501.ingest.us.sentry.io/api/4507001/envelope/");
    expect(envelope!.request.headers["x-sentry-auth"]).toContain("sentry_key=abc123publickey");
    expect(envelope!.itemHeader).toEqual({ type: "event" });
    expect(envelope!.event).toMatchObject({
      level: "error",
      environment: "production",
      release: "abc123",
      tags: { businessId: "b1", event: "turn.failed" },
      extra: { body: "[redacted]", attempts: 3 },
      contexts: { trace: { trace_id: "550e8400e29b41d4a716446655440000" } },
    });
    const raw = fake.raw();
    expect(raw).not.toContain("jane@example.com");
    expect(raw).not.toContain("555 0142");
    expect(raw).not.toContain("abcdef123456");
    expect(raw).not.toContain("I smell gas");
    const values = (envelope!.event["exception"] as { values: { type: string }[] }).values;
    expect(values.map((value) => value.type)).toEqual(["Error", "ValidationError"]);
  });

  it("caps events per minute and survives a failing transport", async () => {
    let now = FIXED();
    const fake = createFakeSentryTransport({ fail: true });
    const client = createSentryClient({
      dsn: DSN,
      transport: fake.transport,
      maxEventsPerMinute: 2,
      now: () => now,
    })!;
    expect(client.captureMessage("one")).not.toBeNull();
    expect(client.captureMessage("two")).not.toBeNull();
    expect(client.captureMessage("three")).toBeNull();
    await client.flush();
    expect(client.stats()).toEqual({ sent: 0, dropped: 1, failed: 2 });
    now = new Date(now.getTime() + 60_000);
    expect(client.captureMessage("four")).not.toBeNull();
  });

  it("never takes a line of the error's message for a stack frame, and scrubs the fingerprint", async () => {
    const fake = createFakeSentryTransport();
    const client = createSentryClient({ dsn: DSN, transport: fake.transport, now: FIXED })!;
    // A message over several lines, one of which reads like a frame; V8 puts the message at
    // the top of the stack.
    const error = new Error(
      "Could not store the note:\n    at 303-555-0142 (jane@example.com:1:2)\n    at Jane Roe (12 Elm St:3:4)",
    );
    client.captureException(error, {
      fingerprint: ["turn.failed for jane@example.com", "pipeline"],
    });
    await client.flush();
    const event = fake.envelopes[0]!.event;
    const frames = (
      event["exception"] as {
        values: { stacktrace?: { frames: { function?: string; filename: string }[] } }[];
      }
    ).values[0]!.stacktrace!.frames;
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(`${frame.function ?? ""} ${frame.filename}`).not.toMatch(/Jane Roe|Elm St|555-0142/);
    }
    const raw = fake.raw();
    for (const leak of ["jane@example.com", "303-555-0142", "Jane Roe", "12 Elm St"]) {
      // The message itself is scrubbed of the address and the number; the name and the
      // street are free text no pattern knows, and they must not be repeated as frames.
      const times = raw.split(leak).length - 1;
      expect(times, leak).toBeLessThanOrEqual(leak === "Jane Roe" || leak === "12 Elm St" ? 1 : 0);
    }
    expect(event["fingerprint"]).toEqual(["turn.failed for [email]", "pipeline"]);
  });

  it("reads V8 stack frames, oldest call first", () => {
    const frames = parseStack(
      "Error: x\n    at inner (/app/packages/a.ts:10:5)\n    at outer (/app/node_modules/b.js:2:1)\n    at node:internal/x:1:1",
    );
    expect(frames.map((frame) => frame.function ?? frame.filename)).toEqual([
      "node:internal/x",
      "outer",
      "inner",
    ]);
    expect(frames.at(-1)?.in_app).toBe(true);
    expect(frames[1]?.in_app).toBe(false);
  });
});

describe("installErrorReporting", () => {
  it("reports error records written by any logger, scrubbed, and stops when removed", async () => {
    const fake = createFakeSentryTransport();
    const client = createSentryClient({ dsn: DSN, transport: fake.transport, now: FIXED })!;
    const stop = installErrorReporting(client);
    const log = createLogger({ sink: () => undefined }).child({
      traceId: "550e8400-e29b-41d4-a716-446655440000",
      businessId: "7d0c3f2e-1b2a-4c5d-8e9f-0a1b2c3d4e5f",
      component: "pipeline",
    });
    try {
      log.info("turn.done");
      log.warn("turn.slow");
      log.error("turn.failed", {
        error: new Error("Could not reach 303-555-0142"),
        text: "my furnace is out",
        email: "a@b.co",
      });
    } finally {
      stop();
    }
    log.error("after.stop");
    await client.flush();
    expect(fake.envelopes).toHaveLength(1);
    const event = fake.envelopes[0]!.event;
    expect(event["tags"]).toMatchObject({
      event: "turn.failed",
      component: "pipeline",
      businessId: "7d0c3f2e-1b2a-4c5d-8e9f-0a1b2c3d4e5f",
    });
    expect(event["contexts"]).toEqual({
      trace: { trace_id: "550e8400e29b41d4a716446655440000", span_id: "550e8400e29b41d4" },
    });
    const raw = fake.raw();
    expect(raw).not.toContain("303-555-0142");
    expect(raw).not.toContain("furnace");
    expect(raw).not.toContain("a@b.co");
  });
});

describe("createMemoryRateLimiter", () => {
  it("counts per key in fixed windows and says when to come back", () => {
    let now = 1_000_000;
    const limiter = createMemoryRateLimiter({ limit: 2, windowMs: 60_000, now: () => now });
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(true);
    const third = limiter.hit("a");
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
    expect(limiter.hit("b").allowed).toBe(true);
    now += 60_000;
    expect(limiter.hit("a").allowed).toBe(true);
  });

  it("keeps a bounded number of keys", () => {
    const limiter = createMemoryRateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxKeys: 100,
      now: () => 0,
    });
    for (let index = 0; index < 1000; index += 1) limiter.hit(`ip-${index}`);
    expect(limiter.size()).toBeLessThanOrEqual(100);
  });
});

describe("readiness rules", () => {
  const none = {
    developmentMode: false,
    inProcessJobs: false,
    offlineModel: false,
    localSignIn: false,
    localStorage: false,
    processTestChannelSecret: false,
    processWidgetSecret: false,
    inngestDev: false,
  };

  it("fails a production build reachable by others with a development-only switch on", () => {
    for (const key of Object.keys(none) as (keyof typeof none)[]) {
      const check = developmentSwitchCheck({
        productionBuild: true,
        loopback: false,
        switches: { ...none, [key]: true },
      });
      expect(check.status, key).toBe("fail");
    }
    expect(
      developmentSwitchCheck({ productionBuild: true, loopback: false, switches: none }).status,
    ).toBe("ok");
  });

  it("accepts the switches on a developer machine and on a loopback production build", () => {
    const all = Object.fromEntries(Object.keys(none).map((key) => [key, true])) as typeof none;
    expect(
      developmentSwitchCheck({ productionBuild: true, loopback: true, switches: all }).status,
    ).toBe("ok");
    expect(
      developmentSwitchCheck({ productionBuild: false, loopback: false, switches: all }).status,
    ).toBe("ok");
  });

  it("warns, by business id, when emergencies reach nobody, and summarizes", () => {
    const warn = emergencyReadinessCheck({ checked: 3, notReady: ["b-1", "b-2"] });
    expect(warn.status).toBe("warn");
    expect(warn.detail).toContain("b-1, b-2");
    expect(summarize([warn]).status).toBe("ready");
    expect(
      summarize([warn, { name: "database", status: "fail", detail: "unreachable" }]).status,
    ).toBe("not_ready");
  });
});
