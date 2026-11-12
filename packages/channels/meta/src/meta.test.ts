import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { WebhookRequest } from "@repo/core";

import { classifyGraphError, regainAccessSeconds } from "./errors";
import {
  assertMetaMediaUrl,
  cleanMimeType,
  createGraphClient,
  type FetchLike,
  GraphApiError,
} from "./graph";
import { downloadMedia, uploadMedia } from "./media";
import { exchangeCode } from "./oauth";
import { metaSignature, safeEqual, verifyMetaSignature, verifyMetaWebhook } from "./signature";

const SECRETS = { appSecret: "app-secret-for-tests", verifyToken: "verify-token-123" };

function post(rawBody: string, signature?: string): WebhookRequest {
  return {
    method: "POST",
    url: "https://app.example.com/api/webhooks/whatsapp",
    headers: signature === undefined ? {} : { "x-hub-signature-256": signature },
    query: {},
    rawBody,
  };
}

function get(query: Record<string, string>): WebhookRequest {
  return { method: "GET", url: "https://app.example.com/x", headers: {}, query, rawBody: "" };
}

describe("webhook verification", () => {
  const body = '{"object":"whatsapp_business_account","entry":[{"id":"1","changes":[]}]}';

  it("accepts the signature Meta computes over the raw body", () => {
    const signature = metaSignature(SECRETS.appSecret, body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyMetaWebhook(post(body, signature), SECRETS)).toEqual({ outcome: "verified" });
    // The case of the hex digits does not matter.
    expect(verifyMetaWebhook(post(body, signature.toUpperCase()), SECRETS).outcome).toBe(
      "verified",
    );
    expect(verifyMetaSignature(SECRETS.appSecret, body, ` ${signature} `)).toBe(true);
  });

  it("rejects a missing, malformed, foreign or tampered signature", () => {
    const good = metaSignature(SECRETS.appSecret, body);
    expect(verifyMetaWebhook(post(body), SECRETS)).toEqual({
      outcome: "rejected",
      reason: "bad_signature",
    });
    expect(verifyMetaWebhook(post(body, "sha1=abc"), SECRETS).outcome).toBe("rejected");
    expect(
      verifyMetaWebhook(post(body, metaSignature("other-secret", body)), SECRETS).outcome,
    ).toBe("rejected");
    // One changed byte in the body, the same signature.
    expect(verifyMetaWebhook(post(body.replace('"1"', '"2"'), good), SECRETS).outcome).toBe(
      "rejected",
    );
    // Re-serialized JSON is not the raw body.
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyMetaWebhook(post(pretty, good), SECRETS).outcome).toBe("rejected");
    // Without a configured secret nothing verifies.
    expect(verifyMetaSignature("", body, metaSignature("", body))).toBe(false);
  });

  it("signs unicode exactly as received", () => {
    const unicode = '{"text":"Caf\\u00e9 été 😀"}';
    expect(
      verifyMetaSignature(SECRETS.appSecret, unicode, metaSignature(SECRETS.appSecret, unicode)),
    ).toBe(true);
  });

  it("answers the subscription handshake only with the right verify token", () => {
    expect(
      verifyMetaWebhook(
        get({
          "hub.mode": "subscribe",
          "hub.verify_token": SECRETS.verifyToken,
          "hub.challenge": "1158201444",
        }),
        SECRETS,
      ),
    ).toEqual({ outcome: "challenge", status: 200, contentType: "text/plain", body: "1158201444" });
    expect(
      verifyMetaWebhook(
        get({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" }),
        SECRETS,
      ).outcome,
    ).toBe("rejected");
    expect(verifyMetaWebhook(get({}), SECRETS).outcome).toBe("rejected");
    expect(
      verifyMetaWebhook(
        get({
          "hub.mode": "subscribe",
          "hub.verify_token": SECRETS.verifyToken,
          "hub.challenge": "<script>alert(1)</script>",
        }),
        SECRETS,
      ).outcome,
    ).toBe("rejected");
  });

  it("compares strings in constant time without leaking the length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("error classification", () => {
  it("maps Meta's codes to retry, window and auth decisions", () => {
    expect(classifyGraphError({ code: 131047, httpStatus: 400 })).toMatchObject({
      windowClosed: true,
      retryable: false,
    });
    expect(classifyGraphError({ code: 130429, httpStatus: 400 })).toMatchObject({
      retryable: true,
      rateLimited: true,
      retryAfterSeconds: 5,
    });
    expect(classifyGraphError({ code: 131056, httpStatus: 400 })).toMatchObject({
      retryable: true,
      retryAfterSeconds: 30,
    });
    expect(classifyGraphError({ code: 190, httpStatus: 401 })).toMatchObject({
      authFailed: true,
      retryable: false,
    });
    expect(classifyGraphError({ code: 131026, httpStatus: 400 }).retryable).toBe(false);
    expect(classifyGraphError({ code: 131000, httpStatus: 500 }).retryable).toBe(true);
    expect(classifyGraphError({ code: null, httpStatus: null }).retryable).toBe(true);
    expect(classifyGraphError({ code: null, httpStatus: 503 }).retryable).toBe(true);
    expect(classifyGraphError({ code: 100, httpStatus: 400 }).retryable).toBe(false);
    expect(classifyGraphError({ code: null, httpStatus: 429 })).toMatchObject({
      retryable: true,
      retryAfterSeconds: 60,
    });
  });

  it("waits as long as the usage header says", () => {
    const header = JSON.stringify({
      "1234": [{ type: "whatsapp", call_count: 100, estimated_time_to_regain_access: 7 }],
    });
    expect(regainAccessSeconds(header)).toBe(420);
    expect(classifyGraphError({ code: 80007, httpStatus: 400, usageHeader: header })).toMatchObject(
      { retryAfterSeconds: 420 },
    );
    expect(regainAccessSeconds("not json")).toBeNull();
    expect(
      regainAccessSeconds(JSON.stringify({ a: [{ estimated_time_to_regain_access: 0 }] })),
    ).toBeNull();
  });
});

/** A fetch that answers from a list of handlers and records the requests. */
function fakeFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): FetchLike & { calls: { url: URL; init: RequestInit }[] } {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as FetchLike & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe("Graph client", () => {
  it("sends the token in the header and the version in the path", async () => {
    const fetch = fakeFetch(() => Response.json({ success: true }));
    const graph = createGraphClient({ fetch, version: "v27.0" });
    await graph.request({ method: "POST", path: "/123/messages", token: "tok", json: { a: 1 } });
    const call = fetch.calls[0]!;
    expect(call.url.toString()).toBe("https://graph.facebook.com/v27.0/123/messages");
    expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer tok");
    expect(call.init.body).toBe('{"a":1}');
    expect(call.url.search).not.toContain("tok");
  });

  it("turns a Graph error into a classified GraphApiError without the token", async () => {
    const fetch = fakeFetch(() =>
      Response.json(
        {
          error: {
            message: "(#131047) Re-engagement message",
            type: "OAuthException",
            code: 131047,
            error_data: {
              messaging_product: "whatsapp",
              details: "Message failed to send because more than 24 hours have passed",
            },
            fbtrace_id: "Az8or2yhqkZfEZ-_4Qn_Bam",
          },
        },
        { status: 400 },
      ),
    );
    const graph = createGraphClient({ fetch });
    const error = await graph
      .request({ method: "POST", path: "/1/messages", token: "secret-token" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphApiError);
    const graphError = error as GraphApiError;
    expect(graphError.graphCode).toBe(131047);
    expect(graphError.slug).toBe("meta_131047");
    expect(graphError.classification.windowClosed).toBe(true);
    expect(graphError.retryable).toBe(false);
    expect(graphError.fbtraceId).toBe("Az8or2yhqkZfEZ-_4Qn_Bam");
    expect(graphError.message).toContain("24 hours");
    expect(
      JSON.stringify({ message: graphError.message, details: graphError.details }),
    ).not.toContain("secret-token");
  });

  it("never retries a request Meta accepted but answered unexpectedly", async () => {
    const graph = createGraphClient({
      fetch: async () => Response.json({ messaging_product: "whatsapp" }, { status: 200 }),
    });
    const error = await graph
      .request(
        { method: "POST", path: "/1/messages", token: "t", json: {} },
        z.object({ messages: z.array(z.object({ id: z.string() })) }),
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphApiError);
    expect((error as GraphApiError).classification.retryable).toBe(false);
  });

  it("treats a network failure as retryable", async () => {
    const graph = createGraphClient({
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    const error = (await graph
      .request({ method: "GET", path: "/1" })
      .catch((caught: unknown) => caught)) as GraphApiError;
    expect(error.graphCode).toBeNull();
    expect(error.retryable).toBe(true);
    expect(error.slug).toBe("meta_network");
  });

  it("refuses paths that could escape the API and odd versions", async () => {
    const graph = createGraphClient({ fetch: fakeFetch(() => Response.json({})) });
    await expect(graph.request({ method: "GET", path: "/../me" })).rejects.toThrow();
    await expect(graph.request({ method: "GET", path: "/1?x=1" })).rejects.toThrow();
    expect(() => createGraphClient({ version: "27" })).toThrow();
  });
});

describe("media", () => {
  it("only sends the token to Meta's hosts over https", () => {
    expect(
      assertMetaMediaUrl("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1")
        .hostname,
    ).toBe("lookaside.fbsbx.com");
    expect(() => assertMetaMediaUrl("http://lookaside.fbsbx.com/x")).toThrow();
    expect(() => assertMetaMediaUrl("https://evil.example.com/x")).toThrow();
    expect(() => assertMetaMediaUrl("https://fbsbx.com.evil.example/x")).toThrow();
    expect(() => assertMetaMediaUrl("https://user:pw@lookaside.fbsbx.com/x")).toThrow();
    expect(() => assertMetaMediaUrl("not a url")).toThrow();
  });

  it("keeps only a plain media type", () => {
    expect(cleanMimeType("audio/ogg; codecs=opus")).toBe("audio/ogg");
    expect(cleanMimeType("Image/JPEG")).toBe("image/jpeg");
    expect(
      cleanMimeType("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    for (const junk of [null, "", "text", "text/html\r\nx-evil: 1", "a/b/c", " /x"]) {
      expect(cleanMimeType(junk)).toBe("application/octet-stream");
    }
  });

  it("looks the media id up, then downloads with the token", async () => {
    const fetch = fakeFetch((url) => {
      if (url.hostname === "graph.facebook.com") {
        return Response.json({
          messaging_product: "whatsapp",
          url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=987",
          mime_type: "image/jpeg",
          sha256: "abc",
          file_size: 4,
          id: "987",
        });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "application/octet-stream" },
      });
    });
    const graph = createGraphClient({ fetch });
    const media = await downloadMedia(graph, {
      mediaId: "987",
      token: "tok",
      maxBytes: 100,
      phoneNumberId: "106540352242922",
    });
    expect(media.mimeType).toBe("image/jpeg");
    expect([...media.bytes]).toEqual([1, 2, 3, 4]);
    expect(fetch.calls[0]!.url.searchParams.get("phone_number_id")).toBe("106540352242922");
    expect(new Headers(fetch.calls[1]!.init.headers).get("authorization")).toBe("Bearer tok");
  });

  it("follows a redirect within Meta's hosts but never to another host", async () => {
    const redirecting = fakeFetch((url) => {
      if (url.hostname === "lookaside.fbsbx.com") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://scontent.whatsapp.net/v/file.jpg" },
        });
      }
      return new Response(new Uint8Array([9]), { headers: { "content-type": "image/png" } });
    });
    const file = await createGraphClient({ fetch: redirecting }).download(
      "https://lookaside.fbsbx.com/x",
      "tok",
      { maxBytes: 10 },
    );
    expect(file.mimeType).toBe("image/png");

    const escaping = fakeFetch(
      () =>
        new Response(null, { status: 302, headers: { location: "https://attacker.example/x" } }),
    );
    await expect(
      createGraphClient({ fetch: escaping }).download("https://lookaside.fbsbx.com/x", "tok", {
        maxBytes: 10,
      }),
    ).rejects.toThrow(/Meta's hosts/);
    expect(escaping.calls).toHaveLength(1);
  });

  it("refuses files over the limit, declared or streamed", async () => {
    const declared = fakeFetch(() =>
      Response.json({
        url: "https://lookaside.fbsbx.com/x",
        mime_type: "audio/ogg",
        file_size: 999,
      }),
    );
    await expect(
      downloadMedia(createGraphClient({ fetch: declared }), {
        mediaId: "1",
        token: "t",
        maxBytes: 10,
      }),
    ).rejects.toThrow(/too large/);
    const streamed = fakeFetch(() => new Response(new Uint8Array(50)));
    await expect(
      createGraphClient({ fetch: streamed }).download("https://lookaside.fbsbx.com/x", "t", {
        maxBytes: 10,
      }),
    ).rejects.toThrow(/too large/);
    await expect(
      downloadMedia(createGraphClient({ fetch: declared }), {
        mediaId: "../x",
        token: "t",
        maxBytes: 10,
      }),
    ).rejects.toThrow(/media id/);
  });

  it("uploads media as multipart and returns the id", async () => {
    const fetch = fakeFetch(() => Response.json({ id: "1037543291543636" }));
    const id = await uploadMedia(createGraphClient({ fetch }), {
      phoneNumberId: "106540352242922",
      token: "tok",
      bytes: new Uint8Array([1, 2]),
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
    });
    expect(id).toBe("1037543291543636");
    const form = fetch.calls[0]!.init.body as FormData;
    expect(form.get("messaging_product")).toBe("whatsapp");
    expect(form.get("type")).toBe("image/jpeg");
    expect((form.get("file") as File).name).toBe("photo.jpg");
    expect(fetch.calls[0]!.url.pathname).toBe("/v27.0/106540352242922/media");
  });
});

describe("code exchange", () => {
  it("exchanges the Embedded Signup code for a business token", async () => {
    const fetch = fakeFetch(() => Response.json({ access_token: "EAAB...", token_type: "bearer" }));
    const token = await exchangeCode(createGraphClient({ fetch }), {
      appId: "app",
      appSecret: "shh",
      code: "code-1",
    });
    expect(token).toEqual({ accessToken: "EAAB...", expiresInSeconds: null });
    const url = fetch.calls[0]!.url;
    expect(url.pathname).toBe("/v27.0/oauth/access_token");
    expect(url.searchParams.get("client_id")).toBe("app");
    expect(url.searchParams.get("code")).toBe("code-1");
  });

  it("surfaces an expired code as a non-retryable error", async () => {
    const fetch = fakeFetch(() =>
      Response.json(
        {
          error: {
            message: "This authorization code has expired.",
            code: 100,
            type: "OAuthException",
          },
        },
        { status: 400 },
      ),
    );
    const error = (await exchangeCode(createGraphClient({ fetch }), {
      appId: "a",
      appSecret: "s",
      code: "c",
    }).catch((caught: unknown) => caught)) as GraphApiError;
    expect(error.graphCode).toBe(100);
    expect(error.retryable).toBe(false);
  });
});
