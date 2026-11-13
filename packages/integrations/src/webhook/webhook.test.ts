import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLogger, type IntegrationConnectionId, type BusinessId } from "@repo/core";

import { createSafePoster, type PostTransport, UnsafeTargetError } from "../net/safe-post";
import { isPublicAddress } from "../net/address";
import { sampleLeadPayload, startWebhookReceiver, type WebhookReceiver } from "../testing";
import { createWebhookConnector, type WebhookConfig, type WebhookCredentials } from "./connector";
import type { ConnectorContext } from "@repo/core";

const quiet = createLogger({ level: "error", sink: () => {} });
const NOW = new Date("2026-11-12T15:00:00Z");
const SECRET = "whsec_receiver_test_secret_0123456789";
const PUBLIC = { address: "93.184.216.34", family: 4 as const };

describe("the guarded poster: what it refuses before connecting", () => {
  const opened: string[] = [];
  const transport: PostTransport = async ({ url }) => {
    opened.push(url.toString());
    return { status: 200, headers: {} };
  };
  const poster = createSafePoster({
    resolve: async (host) =>
      host === "inside.example.com"
        ? [{ address: "10.0.0.5", family: 4 }]
        : host === "mixed.example.com"
          ? [PUBLIC, { address: "127.0.0.1", family: 4 }]
          : host === "metadata.example.com"
            ? [{ address: "::ffff:169.254.169.254", family: 6 }]
            : [PUBLIC],
    transport,
  });

  it.each([
    ["http://hooks.example.com/x", "scheme"],
    ["ftp://hooks.example.com/x", "scheme"],
    ["https://user:pass@hooks.example.com/x", "credentials"],
    ["https://hooks.example.com:8443/x", "port"],
    ["https://localhost/x", "host"],
    ["https://printer.local/x", "host"],
    ["https://intranet/x", "host"],
    ["https://127.0.0.1/x", "address"],
    ["https://169.254.169.254/latest/meta-data", "address"],
    ["https://[::1]/x", "address"],
    ["https://10.1.2.3/x", "address"],
    ["https://inside.example.com/x", "address"],
    ["https://mixed.example.com/x", "address"],
    ["https://metadata.example.com/x", "address"],
    ["not a url", "invalid_url"],
  ])("refuses %s (%s)", async (url, reason) => {
    const attempt = poster.post({ url, headers: {}, body: "{}" });
    await expect(attempt).rejects.toBeInstanceOf(UnsafeTargetError);
    await expect(attempt).rejects.toMatchObject({ reason });
  });

  it("opened no connection for any of them, and connects to the checked address otherwise", async () => {
    expect(opened).toEqual([]);
    const answer = await poster.post({
      url: "https://hooks.zapier.com/hooks/catch/1/abc/",
      headers: {},
      body: "{}",
    });
    expect(answer.status).toBe(200);
    expect(opened).toEqual(["https://hooks.zapier.com/hooks/catch/1/abc/"]);
  });

  it("answers a fetch with the status only, and refuses anything but POST", async () => {
    const response = await poster.fetch("https://hook.us1.make.com/abc", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(200);
    await expect(poster.fetch("https://hook.us1.make.com/abc")).rejects.toBeInstanceOf(
      UnsafeTargetError,
    );
  });
});

describe("the webhook connector against a local receiver", () => {
  let receiver: WebhookReceiver;
  const connector = createWebhookConnector();
  // The receiver is on the loopback interface over plain HTTP: only a test widens the rules.
  let poster: ReturnType<typeof createSafePoster>;

  beforeAll(async () => {
    receiver = await startWebhookReceiver({ secret: SECRET, now: () => NOW });
    poster = createSafePoster({
      isAllowedAddress: (address) => address === "127.0.0.1" || isPublicAddress(address),
      extraPorts: [receiver.port],
      allowHttp: true,
    });
  });
  afterAll(async () => {
    await receiver.close();
  });

  function context(url = receiver.url): ConnectorContext<WebhookCredentials, WebhookConfig> {
    return {
      connectionId: "55555555-5555-4555-8555-555555555555" as IntegrationConnectionId,
      businessId: "33333333-3333-4333-8333-333333333333" as BusinessId,
      credentials: { signingSecret: SECRET },
      config: { name: "Zapier", url, scope: "business" },
      fieldMapping: [],
      options: {
        leadSource: "AI assistant",
        tags: [],
        includeReport: true,
        includeTranscript: false,
        duplicates: "update_existing",
      },
      fetch: poster.fetch as unknown as typeof fetch,
      logger: quiet,
      now: () => NOW,
    };
  }

  it("delivers a signed lead the receiver can verify, with customer text as JSON data", async () => {
    const result = await connector.pushLead(context(), sampleLeadPayload(), {
      idempotencyKey: "delivery-1",
    });
    expect(result).toEqual({ ok: true, value: { externalId: "delivery-1", externalUrl: null } });
    const got = receiver.received.at(-1)!;
    expect(got.signature).toEqual({ ok: true, timestamp: 1794495600 });
    expect(got.headers["x-hsrb-event"]).toBe("lead.qualified");
    expect(got.headers["idempotency-key"]).toBe("delivery-1");
    expect(got.headers["content-type"]).toBe("application/json");
    const body = got.json as Record<string, Record<string, unknown>>;
    expect(body["lead"]!["fields"]).toEqual(sampleLeadPayload().lead.fields);
    expect(body["contact"]!["name"]).toBe('Pat "Bobby" Lee');
    expect(body["type"]).toBe("lead.qualified");
    // No transcript unless the settings ask; never a credential.
    expect(got.body).not.toContain("transcript");
    expect(got.body).not.toContain(SECRET);
  });

  it("reports a receiver's errors: retryable 5xx and 429, final 4xx, redirects not followed", async () => {
    receiver.answerWith(503, 429, 400, 302);
    const ctx = context();
    const first = await connector.pushLead(ctx, sampleLeadPayload(), { idempotencyKey: "d-2" });
    expect(first).toMatchObject({ ok: false, error: { code: "unavailable", retryable: true } });
    const second = await connector.pushLead(ctx, sampleLeadPayload(), { idempotencyKey: "d-2" });
    expect(second).toMatchObject({ ok: false, error: { code: "rate_limited", retryable: true } });
    const third = await connector.pushLead(ctx, sampleLeadPayload(), { idempotencyKey: "d-2" });
    expect(third).toMatchObject({ ok: false, error: { code: "validation", retryable: false } });
    const fourth = await connector.pushLead(ctx, sampleLeadPayload(), { idempotencyKey: "d-2" });
    expect(fourth).toMatchObject({ ok: false, error: { code: "validation", retryable: false } });
    expect(fourth.ok ? "" : fourth.error.message).toContain("redirect");
  });

  it("refuses a private address as a final error, without sending", async () => {
    const strict = createSafePoster();
    const before = receiver.received.length;
    const result = await connector.pushLead(
      { ...context(), fetch: strict.fetch as unknown as typeof fetch },
      sampleLeadPayload(),
      { idempotencyKey: "d-3" },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "validation", retryable: false } });
    expect(receiver.received.length).toBe(before);
  });

  it("sends a signed ping as the connection test", async () => {
    const result = await connector.testConnection(context());
    expect(result).toEqual({ ok: true, value: { accountLabel: "Zapier" } });
    const got = receiver.received.at(-1)!;
    expect(got.headers["x-hsrb-event"]).toBe("ping");
    expect(got.signature?.ok).toBe(true);
  });
});
