import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureWidgetConnection } from "@repo/channel-widget/server";
import { createLogger, type WidgetMessages, type WidgetSession } from "@repo/core";
import { type DeploymentInfo, loadEnv } from "@repo/core/env";
import {
  attachments,
  businesses,
  contacts,
  conversationTurns,
  eq,
  messages,
  segments,
} from "@repo/db";
import { createTenantStorage, MemoryObjectStore } from "@repo/db/storage";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { createLocalJobRunner, type LocalJobRunner } from "@repo/jobs";
import { applySettingChanges } from "@repo/settings/server";
import { WIDGET_SCRIPT, WIDGET_SCRIPT_VERSION } from "@repo/widget-embed";

import { GET as getScript } from "@/app/api/widget/v1/widget.js/route";
import { buildServerPipeline, type ServerPipeline } from "@/server/pipeline";

import { clientIp, preflight } from "./http";
import {
  configHandler,
  listMessagesHandler,
  postMessageHandler,
  profileHandler,
  sessionHandler,
} from "./routes";

const local: DeploymentInfo = { environment: "local", commitSha: null, region: null };
const quiet = createLogger({ level: "error", sink: () => {} });
const SITE = "https://www.summit-roofing.test";
const API = "http://localhost:3000/api/widget/v1";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array<number>(200).fill(9)]);

let t: TestDatabase;
let runner: LocalJobRunner;
let server: ServerPipeline;
let store: MemoryObjectStore;
let key: string;
let businessId: string;

const get = () => server.widget;
const config = configHandler(get);
const session = sessionHandler(get);
const profile = profileHandler(get);
const list = listMessagesHandler(get);
const post = postMessageHandler(get);

function req(
  path: string,
  init: {
    method?: string;
    origin?: string | null;
    token?: string;
    json?: unknown;
    body?: BodyInit;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers: Record<string, string> = { ...init.headers };
  const origin = init.origin === undefined ? SITE : init.origin;
  if (origin !== null) headers["origin"] = origin;
  if (init.token !== undefined) headers["authorization"] = `Bearer ${init.token}`;
  let body = init.body;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  return new Request(`${API}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: body ?? null,
  });
}

beforeAll(async () => {
  t = await createTestDatabase();
  store = new MemoryObjectStore("attachments");
  runner = createLocalJobRunner({ logger: quiet, debouncePeriodMs: 50, retryDelayMs: () => 10 });
  server = buildServerPipeline({
    db: t.db,
    env: loadEnv({}),
    deployment: local,
    logger: quiet,
    runner,
    testChannelSecret: "web-test-channel-secret-0123456789abcdef",
    widgetSecret: "web-widget-secret-0123456789-0123456789-abcdef",
    storage: (tenant) => createTenantStorage(store, tenant),
  });
  const { id: agencyId } = await t.db.platform.createAgency({ name: "Agency", slug: "agency" });
  const [segment] = await t.admin
    .insert(segments)
    .values({ agencyId, slug: "roofing", name: "Roofing" })
    .returning({ id: segments.id });
  const [business] = await t.admin
    .insert(businesses)
    .values({
      agencyId,
      segmentId: segment!.id,
      name: "Summit Roofing",
      slug: "summit-roofing",
      status: "active",
    })
    .returning({ id: businesses.id });
  businessId = business!.id;
  await t.db.forBusiness(business!.id).run(async (ctx) => {
    key = (await ensureWidgetConnection(ctx, { actor: { type: "system", label: "test" } }))
      .publicKey;
    await applySettingChanges(ctx, {
      target: { scope: "business", agencyId, businessId: business!.id },
      changes: [
        { key: "channels.widget.allowed_origins", value: [SITE] },
        { key: "channels.widget.pre_chat_fields", value: ["name", "phone", "email"] },
        { key: "conversation.reply_wait_seconds.widget", value: 0 },
        { key: "hours.after_hours_mode", value: "normal" },
      ],
      actor: { type: "system", label: "web tests" },
    });
  });
});

afterAll(async () => {
  runner?.stop();
  await runner?.idle();
  await t?.dispose();
});

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("/api/widget/v1", () => {
  it("serves the script with caching headers", async () => {
    const response = getScript(new Request(`${API}/widget.js`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("etag")).toBe(`"${WIDGET_SCRIPT_VERSION}"`);
    expect(await response.text()).toBe(WIDGET_SCRIPT);
    const cached = getScript(
      new Request(`${API}/widget.js`, {
        headers: { "if-none-match": `"${WIDGET_SCRIPT_VERSION}"` },
      }),
    );
    expect(cached.status).toBe(304);
  });

  it("answers allowed sites with CORS headers and refuses every other origin", async () => {
    const allowed = await config(req(`/config?key=${key}`));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();
    expect(await json(allowed)).toMatchObject({ businessName: "Summit Roofing" });

    for (const origin of ["https://evil.test", "http://www.summit-roofing.test", null]) {
      const refused = await config(req(`/config?key=${key}`, { origin }));
      expect(refused.status).toBe(403);
      // Without CORS headers the browser does not let the page read anything.
      expect(refused.headers.get("access-control-allow-origin")).toBeNull();
      const sessionRefused = await session(
        req("/session", { method: "POST", origin, json: { key, token: null } }),
      );
      expect(sessionRefused.status).toBe(403);
      expect(sessionRefused.headers.get("access-control-allow-origin")).toBeNull();
    }

    const pre = preflight(req("/session", { method: "OPTIONS", origin: "https://evil.test" }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("takes the visitor's address from the hop the platform added, not one a client chose", () => {
    const at = (headers: Record<string, string>) =>
      clientIp(new Request(`${API}/session`, { headers }));
    expect(at({ "x-forwarded-for": "198.51.100.9" })).toBe("198.51.100.9");
    // A client that sends its own x-forwarded-for cannot pick the address that is counted.
    expect(at({ "x-forwarded-for": "1.2.3.4, 198.51.100.9" })).toBe("198.51.100.9");
    expect(at({ "x-real-ip": "198.51.100.10" })).toBe("198.51.100.10");
    expect(at({ "x-forwarded-for": " ", "x-real-ip": "198.51.100.10" })).toBe("198.51.100.10");
    expect(at({})).toBeNull();
  });

  it("refuses oversized and malformed bodies", async () => {
    const big = await session(
      req("/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, token: "x".repeat(20_000) }),
      }),
    );
    expect(big.status).toBe(413);
    const broken = await session(
      req("/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(broken.status).toBe(400);
    const declared = await post(
      req("/messages", {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=x",
          "content-length": String(30 * 1024 * 1024),
        },
        body: "--x--",
      }),
    );
    expect(declared.status).toBe(413);
  });

  it("round-trips a visitor's conversation with a photo through the pipeline and the engine", async () => {
    const started = await json<WidgetSession>(
      await session(req("/session", { method: "POST", json: { key, token: null } })),
    );
    expect(started.needsProfile).toEqual(["name", "phone", "email"]);
    const token = started.token;

    const early = await post(
      req("/messages", { method: "POST", token, json: { id: "client-0001", text: "Hello" } }),
    );
    expect(early.status).toBe(409);
    // The script can read why: CORS headers on every answer to an allowed site.
    expect(early.headers.get("access-control-allow-origin")).toBe(SITE);

    const saved = await profile(
      req("/profile", {
        method: "POST",
        token,
        json: { name: "Pat Lee", phone: "303-555-0142", email: "pat@example.com" },
      }),
    );
    expect(await json(saved)).toEqual({ needsProfile: [] });

    const sent = await post(
      req("/messages", {
        method: "POST",
        token,
        json: { id: "client-0002", text: "My roof is leaking near the chimney" },
      }),
    );
    expect(sent.status).toBe(200);
    // The same message again (a retried request) is stored once.
    const again = await post(
      req("/messages", {
        method: "POST",
        token,
        json: { id: "client-0002", text: "My roof is leaking near the chimney" },
      }),
    );
    expect(await json(again)).toEqual({ accepted: true, duplicate: true });
    await runner.idle();

    const first = await json<WidgetMessages>(await list(req("/messages", { token })));
    expect(first.messages.map((message) => message.from)).toEqual(["visitor", "bot"]);
    expect(first.messages[0]).toMatchObject({
      clientId: "client-0002",
      text: "My roof is leaking near the chimney",
    });
    expect(first.typing).toBe(false);
    // The contact got the pre-chat details; the bot did not ask for them again.
    const [contact] = await t.admin
      .select()
      .from(contacts)
      .where(eq(contacts.businessId, businessId as never));
    expect(contact).toMatchObject({
      displayName: "Pat Lee",
      phone: "+13035550142",
      email: "pat@example.com",
    });
    expect(first.messages[1]!.text).not.toMatch(/your name|phone number|email/i);

    const form = new FormData();
    form.append("id", "client-0003");
    form.append("photo", new Blob([JPEG], { type: "image/jpeg" }), "chimney.jpg");
    const photo = await post(req("/messages", { method: "POST", token, body: form }));
    expect(photo.status).toBe(200);
    await runner.idle();

    const second = await json<WidgetMessages>(
      await list(req(`/messages?after=${encodeURIComponent(first.cursor)}`, { token })),
    );
    expect(second.messages.map((message) => message.from)).toEqual(["visitor", "bot"]);
    const [photoMessage] = second.messages;
    expect(photoMessage!.photos).toHaveLength(1);
    expect(photoMessage!.photos[0]!.url).toMatch(/^memory:\/\/attachments\/.+\/uploads\//);

    const rows = await t.admin
      .select()
      .from(messages)
      .where(eq(messages.businessId, businessId as never))
      .orderBy(messages.sequence);
    expect(rows.map((row) => [row.direction, row.author, row.status, row.kind])).toEqual([
      ["inbound", "customer", "received", "text"],
      ["outbound", "bot", "sent", "text"],
      ["inbound", "customer", "received", "media"],
      ["outbound", "bot", "sent", "text"],
    ]);
    const [stored] = await t.admin
      .select()
      .from(attachments)
      .where(eq(attachments.messageId, rows[2]!.id));
    expect(stored).toMatchObject({ status: "stored", kind: "image", mimeType: "image/jpeg" });
    // The engine looked at the photo (photo analysis is on by default).
    const turns = await t.admin
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.conversationId, rows[0]!.conversationId))
      .orderBy(conversationTurns.ordinal);
    const actions = (turns[1]?.actions ?? []) as { action: { type: string } }[];
    expect(actions.map((entry) => entry.action.type)).toContain("analyze_photos");
    expect(stored?.analysis).toBeTruthy();

    // A session from another site, or none, cannot read this conversation.
    expect((await list(req("/messages", { token, origin: "https://evil.test" }))).status).toBe(403);
    expect((await list(req("/messages"))).status).toBe(401);
  });
});
