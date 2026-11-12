import { describe, expect, it } from "vitest";

import { jwtExpiry } from "./connectors/common";
import { redactVendorText, vendorMessage } from "./http";
import { applyFieldMapping, isMappingSource, toE164 } from "./mapping";
import { findPostalCode, payloadFingerprint, splitName, textToHtml } from "./payload";
import { sampleLeadPayload } from "./testing";
import { secretHint, signWebhookBody, verifyWebhookSignature } from "./webhook/sign";
import { retryDelayMs } from "./server/deliver";

const OPTIONS = { leadSource: "AI assistant", tags: ["ai-assistant"] };

describe("field mapping", () => {
  it("copies exactly the mapped fields, with transforms", () => {
    const { fields, ignored } = applyFieldMapping(
      sampleLeadPayload(),
      [
        { source: "contact.email", target: "email" },
        { source: "contact.phone", target: "phone", transform: "phone_e164" },
        { source: "lead.score", target: "score", transform: "number" },
        { source: "lead.fields.timeline", target: "timeline" },
        { source: "lead.createdAt", target: "first_seen", transform: "date" },
        { source: "sync.leadSource", target: "source" },
        { source: "sync.tags", target: "tags" },
        { source: "lead.fields.missing", target: "never" },
      ],
      OPTIONS,
    );
    expect(fields).toEqual({
      email: "pat.lee@example.com",
      phone: "+15125550199",
      score: 82,
      timeline: "this_week",
      first_seen: "2026-11-12",
      source: "AI assistant",
      tags: "ai-assistant",
    });
    expect(ignored).toEqual([]);
  });

  it("ignores sources outside the catalogue, so a mapping cannot reach anything else", () => {
    const { fields, ignored } = applyFieldMapping(
      sampleLeadPayload(),
      [
        { source: "constructor", target: "a" },
        { source: "lead.__proto__", target: "b" },
        { source: "contact", target: "c" },
        { source: "credentials.accessToken", target: "d" },
        { source: "lead.fields.__proto__.x", target: "e" },
      ],
      OPTIONS,
    );
    expect(fields).toEqual({});
    expect(ignored).toHaveLength(5);
    expect(isMappingSource("lead.fields.system.emergency")).toBe(true);
    expect(isMappingSource("lead.fields.")).toBe(false);
  });

  it("leaves out empty values and keeps the first entry of a target", () => {
    const { fields } = applyFieldMapping(
      sampleLeadPayload({ email: null }),
      [
        { source: "contact.email", target: "email" },
        { source: "contact.name", target: "name" },
        { source: "contact.firstName", target: "name" },
      ],
      OPTIONS,
    );
    expect(fields).toEqual({ name: 'Pat "Bobby" Lee' });
  });

  it("normalizes US phone numbers and refuses what is not one", () => {
    expect(toE164("(512) 555-0199")).toBe("+15125550199");
    expect(toE164("1-512-555-0199")).toBe("+15125550199");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(toE164("555-0199")).toBeNull();
  });
});

describe("payload helpers", () => {
  it("splits names and finds ZIP codes", () => {
    expect(splitName("Mary Ann  Smith")).toEqual({ firstName: "Mary Ann", lastName: "Smith" });
    expect(splitName("Cher")).toEqual({ firstName: "Cher", lastName: null });
    expect(splitName(null)).toEqual({ firstName: null, lastName: null });
    expect(findPostalCode("1200 Elm St, Austin, TX 78704-1234")).toBe("78704");
    expect(findPostalCode(null, "near 55408")).toBe("55408");
    expect(findPostalCode("Unit 123456")).toBeNull();
  });

  it("escapes customer text for rich-text notes", () => {
    expect(textToHtml('<script>alert("x")</script>\nok & done')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>ok &amp; done",
    );
  });

  it("fingerprints by content, not by key order", () => {
    expect(payloadFingerprint({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      payloadFingerprint({ b: [1, { d: 3, c: 2 }], a: 1 }),
    );
    expect(payloadFingerprint({ a: 1 })).not.toBe(payloadFingerprint({ a: 2 }));
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_test_secret_0123456789abcdef";
  const now = new Date("2026-11-12T15:00:00Z");

  it("verifies its own signature over the raw body", () => {
    const body = '{"type":"lead.qualified"}';
    const header = signWebhookBody(secret, body, now);
    expect(header).toMatch(/^t=1794495600,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, header, body, now)).toEqual({
      ok: true,
      timestamp: 1794495600,
    });
  });

  it("refuses a changed body, another secret, a replay after five minutes and junk", () => {
    const body = '{"type":"lead.qualified"}';
    const header = signWebhookBody(secret, body, now);
    expect(verifyWebhookSignature(secret, header, `${body} `, now)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(verifyWebhookSignature(`${secret}x`, header, body, now)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    const later = new Date(now.getTime() + 301_000);
    expect(verifyWebhookSignature(secret, header, body, later)).toEqual({
      ok: false,
      reason: "expired",
    });
    // The timestamp is signed: moving it forward breaks the signature.
    const moved = header.replace(/^t=\d+/, `t=${Math.floor(later.getTime() / 1000)}`);
    expect(verifyWebhookSignature(secret, moved, body, later)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(verifyWebhookSignature(secret, null, body, now)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyWebhookSignature(secret, "v1=abc", body, now)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("shows only the end of a secret", () => {
    expect(secretHint(secret)).toBe("whsec_…cdef");
  });
});

describe("retry delays", () => {
  it("backs off and honours a longer Retry-After", () => {
    expect([1, 2, 3, 4, 5, 6].map((attempt) => retryDelayMs(attempt, null) / 60_000)).toEqual([
      1, 5, 15, 60, 240, 240,
    ]);
    expect(retryDelayMs(1, 600)).toBe(600_000);
    expect(retryDelayMs(3, 10)).toBe(15 * 60_000);
  });
});

describe("vendor error text", () => {
  it("keeps the explanation and drops the customer's data and tokens", () => {
    expect(
      vendorMessage({
        message:
          'Property values were not valid: [{"isValid":false,"message":"Email address pat.lee@example.com is invalid","name":"email"}]',
      }),
    ).toBe('Property values were not valid: [{"…":false,"…":"…","…":"…"}]');
    expect(redactVendorText("Phone (512) 555-0199 is not a mobile number")).toBe(
      "Phone [number] is not a mobile number",
    );
    expect(redactVendorText("Token eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop expired")).toBe(
      "Token [redacted] expired",
    );
    // HubSpot's duplicate answer keeps the id it names (the connector reads it).
    expect(vendorMessage({ message: "Contact already exists. Existing ID: 51234567890" })).toBe(
      "Contact already exists. Existing ID: 51234567890",
    );
  });
});

describe("token expiry", () => {
  it("reads the exp claim of a JWT access token, and nothing else", () => {
    const claims = Buffer.from(JSON.stringify({ exp: 1_800_000_000 })).toString("base64url");
    expect(jwtExpiry(`e30.${claims}.sig`)).toBe(1_800_000_000_000);
    expect(jwtExpiry("opaque-token")).toBeNull();
    expect(jwtExpiry("a.b.c")).toBeNull();
  });
});
