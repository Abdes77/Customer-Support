import { addLogListener, type LogRecord } from "@repo/core";

import type { CaptureContext, SentryClient } from "./sentry";

/**
 * Error reporting (C17): every `error` record any logger writes becomes a Sentry event, so
 * the existing call sites (`turn.failed`, `send.failed`, `emergency.chain_exhausted`,
 * `sweeper.business_failed`, a route's unexpected error...) report without changes. The
 * record arrives already redacted by field name; the client scrubs free text on top.
 */

/** Record fields that become indexed tags (ids and classifications only). */
const TAG_FIELDS = [
  "traceId",
  "agencyId",
  "businessId",
  "conversationId",
  "messageId",
  "turnId",
  "component",
  "channel",
  "route",
  "functionId",
  "runId",
  "purpose",
  "reason",
] as const;

/** Fields that are never sent, even redacted (bulky or useless in an event). */
const DROPPED_FIELDS = new Set(["level", "time", "msg", "error", "stack"]);

export function contextOf(record: LogRecord): CaptureContext {
  const tags: Record<string, string | number | boolean | null> = { event: record.msg };
  for (const field of TAG_FIELDS) {
    const value = record[field];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      tags[field] = value;
    }
  }
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (DROPPED_FIELDS.has(key) || (TAG_FIELDS as readonly string[]).includes(key)) continue;
    extra[key] = value;
  }
  const traceId = typeof record["traceId"] === "string" ? record["traceId"] : null;
  return {
    level: record.level === "error" ? "error" : "warning",
    tags,
    extra,
    traceId,
    fingerprint: [record.msg, typeof tags["component"] === "string" ? tags["component"] : ""],
  };
}

/** Sends one log record to Sentry: its `error` field as the exception, else the message. */
export function reportRecord(client: SentryClient, record: LogRecord): string | null {
  const context = contextOf(record);
  const error = record["error"];
  if (error !== undefined && error !== null && typeof error === "object") {
    return client.captureException(error, context);
  }
  return client.captureMessage(record.msg, context);
}

/**
 * Reports every record at or above `minLevel` (default `error`) through `client`. Returns the
 * function that stops it. Installing twice replaces nothing: call the returned function first.
 */
export function installErrorReporting(
  client: SentryClient,
  options: { readonly minLevel?: "warn" | "error" } = {},
): () => void {
  const minLevel = options.minLevel ?? "error";
  return addLogListener((record) => {
    if (record.level === "error" || (minLevel === "warn" && record.level === "warn")) {
      reportRecord(client, record);
    }
  });
}
