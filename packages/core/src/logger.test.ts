import { describe, expect, it } from "vitest";

import { ExternalServiceError } from "./errors";
import { addLogListener, createLogger, type LogRecord, redact, REDACTED } from "./logger";

function capture(level: "debug" | "info" | "warn" | "error" = "debug") {
  const records: LogRecord[] = [];
  const logger = createLogger({
    level,
    sink: (record) => records.push(record),
    now: () => new Date("2026-11-11T12:00:00.000Z"),
  });
  return { logger, records };
}

describe("createLogger", () => {
  it("writes structured records with level, time and message", () => {
    const { logger, records } = capture();
    logger.info("message stored", { conversationId: "c1", count: 2 });
    expect(records).toEqual([
      {
        level: "info",
        time: "2026-11-11T12:00:00.000Z",
        msg: "message stored",
        conversationId: "c1",
        count: 2,
      },
    ]);
  });

  it("drops records below the configured level", () => {
    const { logger, records } = capture("warn");
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(records.map((record) => record.msg)).toEqual(["c", "d"]);
  });

  it("adds child bindings to every record and lets call fields win", () => {
    const { logger, records } = capture();
    const child = logger.child({ traceId: "t1", businessId: "b1" });
    child.info("one");
    child.info("two", { businessId: "b2" });
    expect(records[0]).toMatchObject({ traceId: "t1", businessId: "b1" });
    expect(records[1]).toMatchObject({ traceId: "t1", businessId: "b2" });
  });

  it("cannot have level, time or msg overwritten by fields", () => {
    const { logger, records } = capture();
    logger.info("real", { level: "error", msg: "fake", time: "never" });
    expect(records[0]).toMatchObject({
      level: "info",
      msg: "real",
      time: "2026-11-11T12:00:00.000Z",
    });
  });
});

describe("redact", () => {
  it("replaces secrets at any depth", () => {
    const safe = redact({
      headers: { Authorization: "Bearer abc", "x-hub-signature-256": "sha256=1" },
      connection: { accessToken: "EAAB", refresh_token: "r", smtpPassword: "p", apiKey: "k" },
      list: [{ client_secret: "s" }],
    });
    expect(safe).toEqual({
      headers: { Authorization: REDACTED, "x-hub-signature-256": REDACTED },
      connection: {
        accessToken: REDACTED,
        refresh_token: REDACTED,
        smtpPassword: REDACTED,
        apiKey: REDACTED,
      },
      list: [{ client_secret: REDACTED }],
    });
  });

  it("replaces customer content and contact details", () => {
    const safe = redact({
      messageId: "m1",
      text: "my roof is leaking at 12 Elm St",
      sender: { phone: "+15555550123", email: "pat@example.com", displayName: "Pat" },
      rawBody: "{...}",
    });
    expect(safe).toEqual({
      messageId: "m1",
      text: REDACTED,
      sender: { phone: REDACTED, email: REDACTED, displayName: REDACTED },
      rawBody: REDACTED,
    });
  });

  it("matches field names in any case style and hides connection strings", () => {
    const safe = redact({
      first_name: "Pat",
      "display-name": "Pat",
      raw_body: "{...}",
      databaseUrl: "postgresql://user:pw@db.example.com/app",
      ALERT_SMTP_URL: "smtps://user:pw@smtp.example.com:465",
      serviceRoleKey: "eyJ...",
      INNGEST_SIGNING_KEY: "signkey-prod-...",
      idempotencyKey: "m1",
      eventId: "e1",
    });
    expect(safe).toEqual({
      first_name: REDACTED,
      "display-name": REDACTED,
      raw_body: REDACTED,
      databaseUrl: REDACTED,
      ALERT_SMTP_URL: REDACTED,
      serviceRoleKey: REDACTED,
      INNGEST_SIGNING_KEY: REDACTED,
      idempotencyKey: "m1",
      eventId: "e1",
    });
  });

  it("keeps ids, counts and null values readable", () => {
    const input = { businessId: "b1", attempts: 3, ok: true, token: null, at: new Date(0) };
    expect(redact(input)).toEqual({
      businessId: "b1",
      attempts: 3,
      ok: true,
      token: null,
      at: "1970-01-01T00:00:00.000Z",
    });
  });

  it("keeps token counts and boolean flags readable while hiding token values", () => {
    const safe = redact({
      usage: { inputTokens: 1200, outputTokens: 80, cacheReadInputTokens: 900 },
      hasSecret: true,
      token: "abc",
      tokens: ["abc", "def"],
      secret: { value: "nested" },
      phone: 15555550123,
    });
    expect(safe).toEqual({
      usage: { inputTokens: 1200, outputTokens: 80, cacheReadInputTokens: 900 },
      hasSecret: true,
      token: REDACTED,
      tokens: REDACTED,
      secret: REDACTED,
      phone: REDACTED,
    });
  });

  it("does not mistake a shared object for a circular one", () => {
    const shared = { id: "b1" };
    expect(redact({ first: shared, second: shared, list: [shared, shared] })).toEqual({
      first: { id: "b1" },
      second: { id: "b1" },
      list: [{ id: "b1" }, { id: "b1" }],
    });
  });

  it("serializes errors with their code and cause but without secrets in details", () => {
    const error = new ExternalServiceError("Graph API failed", {
      provider: "meta",
      status: 503,
      details: { accessToken: "EAAB", endpoint: "/messages" },
      cause: new Error("socket hang up"),
    });
    const safe = redact({ err: error }) as { err: Record<string, unknown> };
    expect(safe.err).toMatchObject({
      name: "ExternalServiceError",
      message: "Graph API failed",
      code: "external_service_failed",
      retryable: true,
      provider: "meta",
      status: 503,
      details: { accessToken: REDACTED, endpoint: "/messages" },
      cause: { name: "Error", message: "socket hang up" },
    });
  });

  it("survives circular references and very deep objects", () => {
    const circular: Record<string, unknown> = { id: 1 };
    circular["self"] = circular;
    expect(redact(circular)).toEqual({ id: 1, self: "[circular]" });

    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).toContain("[truncated]");
  });
});

describe("log listeners", () => {
  it("see every record after redaction, and a failing listener changes nothing", () => {
    const seen: LogRecord[] = [];
    const sink: LogRecord[] = [];
    const remove = addLogListener((record) => seen.push(record));
    const removeBroken = addLogListener(() => {
      throw new Error("reporting is down");
    });
    try {
      const log = createLogger({ sink: (record) => sink.push(record), level: "debug" });
      log.error("turn.failed", { email: "jane@example.com", apiKey: "sk-123", count: 2 });
    } finally {
      remove();
      removeBroken();
    }
    expect(sink).toHaveLength(1);
    expect(seen).toEqual(sink);
    expect(seen[0]).toMatchObject({ level: "error", email: "[redacted]", apiKey: "[redacted]" });
    // Removed listeners hear nothing more.
    createLogger({ sink: () => undefined }).error("later");
    expect(seen).toHaveLength(1);
  });
});
