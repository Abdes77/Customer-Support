import { generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createLogger, type ParsedWebhook, type UserId } from "@repo/core";
import {
  and,
  type BusinessTenant,
  businesses,
  channelConnections,
  channelConnectionSecrets,
  eq,
  segments,
  usageCounters,
} from "@repo/db";
import { createTenantStorage, MemoryObjectStore } from "@repo/db/storage";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import type { AnyJobEvent } from "@repo/jobs";

import { EmailConnectionConfig, OAuthCredentials, readState } from "../config";
import { createGmailClient } from "../providers/gmail";
import { createGraphMailClient } from "../providers/microsoft";
import { createFakeGmail, type FakeGmail } from "../testing/fake-gmail";
import { createFakeGraph, type FakeGraph } from "../testing/fake-graph";
import { CUSTOMER, newsletter, outOfOffice, rawEmail } from "../testing/fixtures";
import { type LocalMailServer, startLocalMailServer } from "../testing/mail-server";
import { createEmailConnectionService } from "./connections";
import type { EmailServerDeps } from "./deps";
import { googleKeySource, type JsonWebKeySet, verifyGoogleOidcToken } from "./oidc";
import { createEmailSendThrottle } from "./pipeline-parts";
import {
  createGmailPushHandler,
  createGraphNotificationHandler,
  MAX_UNMATCHED_NOTIFICATIONS,
} from "./push";
import { saveState, syncBatch } from "./sync";
import { createAccessTokens } from "./tokens";
import { ensurePush, graphClientState } from "./watch";

const quiet = createLogger({ level: "error", sink: () => {} });
const STATE_KEY = new Uint8Array(32).fill(7);
const PUSH_ACCOUNT = "gmail-push@acme-project.iam.gserviceaccount.com";
const AUDIENCE = "https://app.example.com/api/webhooks/email/gmail";
const CLIENT_STATE_SECRET = "graph-client-state-secret-for-tests";

let t: TestDatabase;
let mail: LocalMailServer;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: "jwk" }),
  kid: "test-key-1",
  alg: "RS256",
  use: "sig",
};
const jwks: JsonWebKeySet = { keys: [jwk] };

beforeAll(async () => {
  t = await createTestDatabase();
  mail = await startLocalMailServer();
});

afterAll(async () => {
  await mail?.stop();
  await t?.dispose();
});

async function newBusiness(): Promise<BusinessTenant> {
  const suffix = randomUUID().slice(0, 8);
  const { id: agencyId } = await t.db.platform.createAgency({
    name: `Agency ${suffix}`,
    slug: `agency-${suffix}`,
  });
  const [segment] = await t.admin
    .insert(segments)
    .values({ agencyId, slug: "roofing", name: "Roofing" })
    .returning({ id: segments.id });
  const [business] = await t.admin
    .insert(businesses)
    .values({
      agencyId,
      segmentId: segment!.id,
      name: "Acme Roofing",
      slug: `acme-${suffix}`,
      status: "active",
    })
    .returning({ id: businesses.id });
  return { agencyId, businessId: business!.id };
}

interface Harness {
  readonly deps: EmailServerDeps;
  readonly ingested: ParsedWebhook[];
  readonly events: AnyJobEvent[];
}

function harness(
  fake: { fetch: (input: string, init?: RequestInit) => Promise<Response> },
  overrides: Partial<EmailServerDeps> = {},
): Harness {
  const ingested: ParsedWebhook[] = [];
  const events: AnyJobEvent[] = [];
  const store = new MemoryObjectStore();
  const deps: EmailServerDeps = {
    db: t.db,
    logger: quiet,
    gmail: createGmailClient(fake.fetch),
    graph: createGraphMailClient(fake.fetch),
    fetch: fake.fetch,
    google: {
      app: { clientId: "google-client", clientSecret: "google-secret" },
      pubsubTopic: "projects/acme/topics/gmail",
      pushServiceAccount: PUSH_ACCOUNT,
      pushAudience: AUDIENCE,
    },
    microsoft: {
      app: { clientId: "ms-client", clientSecret: "ms-secret", tenant: "common" },
      clientStateSecret: CLIENT_STATE_SECRET,
    },
    appUrl: "https://app.example.com",
    oauthStateKey: STATE_KEY,
    ingest: async (parsed) => {
      ingested.push(parsed);
      return {};
    },
    events: { send: async (list) => void events.push(...list) },
    storage: (tenant) => createTenantStorage(store, tenant),
    mailPolicy: mail.policy,
    googleKeys: async () => jwks,
    ...overrides,
  };
  return { deps, ingested, events };
}

async function staffUser(): Promise<UserId> {
  const user = await t.db.localAuth.upsertUser({
    email: `staff-${randomUUID().slice(0, 8)}@agency.test`,
    fullName: "Staff",
  });
  return user.id;
}

async function connectGmail(h: Harness, tenant: BusinessTenant, userId?: UserId) {
  const service = createEmailConnectionService(h.deps);
  userId ??= await staffUser();
  const started = service.startOAuth(tenant, userId, "gmail", { returnTo: "/admin/channels" });
  const url = new URL(started.authorizationUrl);
  const state = service.readState(url.searchParams.get("state")!, started.cookie.value);
  return service.completeOAuth(state, "good-code");
}

function pushToken(claims: Record<string, unknown>, kid = "test-key-1"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), keys.privateKey).toString(
    "base64url",
  );
  return `${header}.${body}.${signature}`;
}

const goodClaims = () => ({
  iss: "https://accounts.google.com",
  aud: AUDIENCE,
  email: PUSH_ACCOUNT,
  email_verified: true,
  iat: Math.floor(Date.now() / 1000) - 10,
  exp: Math.floor(Date.now() / 1000) + 3000,
});

function pubsubBody(address: string, messageId = `${Date.now()}`) {
  return JSON.stringify({
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress: address, historyId: 1234 })).toString(
        "base64",
      ),
      messageId,
    },
    subscription: "projects/acme/subscriptions/gmail-push",
  });
}

describe("connecting Gmail (OAuth with PKCE and a signed, cookie-bound state)", () => {
  let gmail: FakeGmail;
  let h: Harness;
  beforeAll(() => {
    gmail = createFakeGmail({ address: `office-${randomUUID().slice(0, 6)}@acme-roofing.com` });
    h = harness(gmail);
  });

  it("asks for read and send scopes, offline access and a PKCE challenge", async () => {
    const tenant = await newBusiness();
    const started = createEmailConnectionService(h.deps).startOAuth(
      tenant,
      randomUUID() as UserId,
      "gmail",
      { returnTo: "/x" },
    );
    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/api/oauth/email/google/callback",
    );
    // The verifier is only in the cookie, never in the URL.
    expect(started.authorizationUrl).not.toContain(started.cookie.value.split(".")[1]!);
  });

  it("stores the connection with the token encrypted and starts the watch", async () => {
    const tenant = await newBusiness();
    const finished = await connectGmail(h, tenant);
    expect(finished.connection).toMatchObject({
      provider: "gmail",
      address: gmail.address,
      status: "active",
      delivery: "push",
    });
    expect(gmail.watch).toEqual({
      topicName: "projects/acme/topics/gmail",
      labelIds: ["INBOX", "SENT"],
    });
    const [secret] = await t.admin
      .select()
      .from(channelConnectionSecrets)
      .where(eq(channelConnectionSecrets.connectionId, finished.connection.connectionId));
    expect(secret?.ciphertext).not.toContain("gmail-access-1");
    expect(JSON.stringify(finished)).not.toContain("gmail-access-1");
    expect(JSON.stringify(finished)).not.toContain("gmail-refresh-1");
  });

  it("refuses a state that was tampered with, expired or comes without its cookie", async () => {
    const tenant = await newBusiness();
    const service = createEmailConnectionService(h.deps);
    const started = service.startOAuth(tenant, randomUUID() as UserId, "gmail", { returnTo: "/x" });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    expect(() => service.readState(state, null)).toThrow(/could not be verified/);
    expect(() => service.readState(state, `${"a".repeat(32)}.${"b".repeat(64)}`)).toThrow(
      /could not be verified/,
    );
    const [body, mac] = state.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body!, "base64url").toString()),
        b: randomUUID(),
      }),
    ).toString("base64url");
    expect(() => service.readState(`${forged}.${mac}`, started.cookie.value)).toThrow(
      /could not be verified/,
    );
    const later = createEmailConnectionService({
      ...h.deps,
      clock: () => new Date(Date.now() + 11 * 60_000),
    });
    expect(() => later.readState(state, started.cookie.value)).toThrow(/could not be verified/);
  });

  it("refuses a mailbox another business has, before storing anything", async () => {
    const shared = createFakeGmail({
      address: `shared-${randomUUID().slice(0, 6)}@acme-roofing.com`,
    });
    const sh = harness(shared);
    await connectGmail(sh, await newBusiness());
    await expect(connectGmail(sh, await newBusiness())).rejects.toThrow(/another business/);
  });

  it("refreshes an expired token once, under the secret's lock, when two jobs need it", async () => {
    gmail = createFakeGmail({ address: `lock-${randomUUID().slice(0, 6)}@acme-roofing.com` });
    h = harness(gmail);
    const tenant = await newBusiness();
    const finished = await connectGmail(h, tenant);
    const id = finished.connection.connectionId;
    await t.db
      .forBusiness(tenant.businessId)
      .run((ctx) =>
        t.db.secrets.channel.update(
          ctx,
          id,
          (current) => ({ ...(current as object), expiresAt: "2000-01-01T00:00:00.000Z" }),
          OAuthCredentials,
        ),
      );
    const before = gmail.refreshes;
    const tokens = createAccessTokens(h.deps);
    const scope = t.db.forBusiness(tenant.businessId);
    const [a, b] = await Promise.all([
      scope.run((ctx) => tokens.inScope(ctx, id, "gmail")),
      scope.run((ctx) => tokens.inScope(ctx, id, "gmail")),
    ]);
    expect(a).toBe(b);
    expect(gmail.refreshes - before).toBe(1);
  });

  it("marks the connection for reconnecting when Google refuses the refresh", async () => {
    const revoked = createFakeGmail({
      address: `revoked-${randomUUID().slice(0, 6)}@acme-roofing.com`,
    });
    const rh = harness(revoked);
    const tenant = await newBusiness();
    const finished = await connectGmail(rh, tenant);
    const id = finished.connection.connectionId;
    await t.db
      .forBusiness(tenant.businessId)
      .run((ctx) =>
        t.db.secrets.channel.update(
          ctx,
          id,
          (current) => ({ ...(current as object), expiresAt: "2000-01-01T00:00:00.000Z" }),
          OAuthCredentials,
        ),
      );
    revoked.revoked = true;
    const result = await syncBatch(rh.deps, createAccessTokens(rh.deps), {
      ...tenant,
      connectionId: id,
    });
    expect(result.stopped).toBe("auth_failed");
    const [row] = await t.admin
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.id, id));
    expect(row?.status).toBe("error");
    expect(row?.lastError).toMatch(/connect it again/);
  });
});

describe("Gmail sync from the history cursor", () => {
  it("reads new INBOX and SENT messages once, skips our own sends, and moves the cursor", async () => {
    const gmail = createFakeGmail({ address: `sync-${randomUUID().slice(0, 6)}@acme-roofing.com` });
    const h = harness(gmail);
    const tenant = await newBusiness();
    const { connection } = await connectGmail(h, tenant);
    const target = { ...tenant, connectionId: connection.connectionId };
    const tokens = createAccessTokens(h.deps);
    gmail.deliver(rawEmail({ to: gmail.address, messageId: "<c1@example.com>" }));
    gmail.deliver(newsletter());
    const first = await syncBatch(h.deps, tokens, target);
    expect(first.outcomes).toEqual({ ingested: 1, automatic: 1 });
    expect(h.ingested).toHaveLength(1);
    const message = h.ingested[0]!.messages[0]!;
    expect(message).toMatchObject({
      channel: "email",
      externalAccountId: gmail.address,
      externalMessageId: "<c1@example.com>",
      sender: { externalId: CUSTOMER },
      metadata: { provider: "gmail" },
    });
    expect(message.externalThreadId).toMatch(/^gmail:/);
    // Nothing new: nothing ingested again.
    const second = await syncBatch(h.deps, tokens, target);
    expect(second.fetched).toBe(0);
    expect(h.ingested).toHaveLength(1);
  });

  it("reads what arrived since the last sync when the history id has expired", async () => {
    const gmail = createFakeGmail({
      address: `reset-${randomUUID().slice(0, 6)}@acme-roofing.com`,
    });
    const h = harness(gmail);
    const tenant = await newBusiness();
    const { connection } = await connectGmail(h, tenant);
    const target = { ...tenant, connectionId: connection.connectionId };
    gmail.deliver(rawEmail({ to: gmail.address, messageId: "<late@example.com>" }));
    gmail.expireHistory();
    const result = await syncBatch(h.deps, createAccessTokens(h.deps), target);
    expect(result.outcomes.ingested).toBe(1);
    const [row] = await t.admin
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.id, connection.connectionId));
    expect(readState(row?.state).gmail?.historyId).toBe(gmail.historyId());
  });
});

describe("Microsoft 365: OAuth, subscription and delta sync", () => {
  let graph: FakeGraph;
  let h: Harness;
  beforeEach(() => {
    graph = createFakeGraph({ address: `ms-${randomUUID().slice(0, 6)}@acme-roofing.com` });
    h = harness(graph);
  });

  async function connect(tenant: BusinessTenant) {
    const service = createEmailConnectionService(h.deps);
    const started = service.startOAuth(tenant, await staffUser(), "microsoft", { returnTo: "/x" });
    const url = new URL(started.authorizationUrl);
    expect(url.searchParams.get("scope")).toBe("offline_access User.Read Mail.Read Mail.Send");
    return service.completeOAuth(
      service.readState(url.searchParams.get("state")!, started.cookie.value),
      "code",
    );
  }

  it("creates a subscription with a per-connection client state and reads the inbox through delta pages", async () => {
    const tenant = await newBusiness();
    const { connection } = await connect(tenant);
    expect(connection).toMatchObject({
      provider: "microsoft",
      address: graph.address,
      delivery: "push",
    });
    const [subscriptionId, subscription] = [...graph.subscriptions.entries()].at(-1)!;
    expect(subscription).toMatchObject({
      resource: "me/messages",
      notificationUrl: "https://app.example.com/api/webhooks/email/microsoft",
      clientState: graphClientState(CLIENT_STATE_SECRET, connection.connectionId),
    });
    const ref = await t.db.directory.findChannelConnectionBySubscription("email", subscriptionId);
    expect(ref?.connectionId).toBe(connection.connectionId);

    const target = { ...tenant, connectionId: connection.connectionId };
    for (let index = 0; index < 5; index += 1) {
      await graph.deliver(
        rawEmail({
          to: graph.address,
          messageId: `<g${index}-${connection.connectionId}@example.com>`,
        }),
        { conversationId: `conv-${index}` },
      );
    }
    const result = await syncBatch(h.deps, createAccessTokens(h.deps), target);
    expect(result.outcomes.ingested).toBe(5);
    expect(
      h.ingested
        .flatMap((item) => item.messages)
        .filter((m) => m.externalAccountId === graph.address)
        .map((m) => m.externalThreadId),
    ).toEqual(["conv-0", "conv-1", "conv-2", "conv-3", "conv-4"].map((id) => `graph:${id}`));
    // An expired delta token: read again from the last sync, without doubles reaching storage.
    graph.expireDeltaTokens = true;
    await graph.deliver(
      rawEmail({ to: graph.address, messageId: `<after-${connection.connectionId}@example.com>` }),
    );
    const again = await syncBatch(h.deps, createAccessTokens(h.deps), target);
    expect(again.outcomes.ingested).toBeGreaterThanOrEqual(1);
  });

  it("answers the validation handshake, accepts a valid notification and refuses a forged one", async () => {
    const tenant = await newBusiness();
    const { connection } = await connect(tenant);
    const subscriptionId = [...graph.subscriptions.keys()].at(-1)!;
    const handler = createGraphNotificationHandler(h.deps);
    expect(
      await handler({
        headers: {},
        query: { validationToken: "Validation: Token <123>" },
        rawBody: "",
      }),
    ).toEqual({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: "Validation: Token <123>",
    });
    // Only a bounded, printable token is echoed.
    for (const bad of ["", "line\r\nSet-Cookie: x=1", "x".repeat(5000), "\u0000"]) {
      expect(
        (await handler({ headers: {}, query: { validationToken: bad }, rawBody: "" })).status,
      ).toBe(400);
    }
    const notification = (clientState: string, id = subscriptionId) =>
      JSON.stringify({
        value: [
          {
            subscriptionId: id,
            clientState,
            changeType: "created",
            resource: "Users/u/Messages/m",
          },
        ],
      });
    const before = h.events.length;
    expect(
      (
        await handler({
          headers: {},
          query: {},
          rawBody: notification(graphClientState(CLIENT_STATE_SECRET, connection.connectionId)),
        })
      ).status,
    ).toBe(202);
    expect(h.events.slice(before)).toEqual([
      expect.objectContaining({
        name: "email.sync_requested",
        data: expect.objectContaining({ connectionId: connection.connectionId, reason: "push" }),
      }),
    ]);
    // Another connection's client state or a guessed one: refused; an unknown subscription
    // (a disconnected inbox) is acknowledged; none of them makes a sync.
    const otherGraph = createFakeGraph({
      address: `ms-other-${randomUUID().slice(0, 6)}@acme-roofing.com`,
    });
    const otherService = createEmailConnectionService(harness(otherGraph).deps);
    const otherStart = otherService.startOAuth(
      await newBusiness(),
      await staffUser(),
      "microsoft",
      { returnTo: "/x" },
    );
    const other = await otherService.completeOAuth(
      otherService.readState(
        new URL(otherStart.authorizationUrl).searchParams.get("state")!,
        otherStart.cookie.value,
      ),
      "code",
    );
    expect(
      (
        await handler({
          headers: {},
          query: {},
          rawBody: notification(
            graphClientState(CLIENT_STATE_SECRET, other.connection.connectionId),
          ),
        })
      ).status,
    ).toBe(401);
    expect((await handler({ headers: {}, query: {}, rawBody: notification("guess") })).status).toBe(
      401,
    );
    expect(
      (
        await handler({
          headers: {},
          query: {},
          rawBody: notification("x", "unknown-subscription"),
        })
      ).status,
    ).toBe(202);
    expect(h.events.length).toBe(before + 1);
    // A lifecycle notification renews the subscription through a sync.
    const lifecycle = JSON.stringify({
      value: [
        {
          subscriptionId,
          clientState: graphClientState(CLIENT_STATE_SECRET, connection.connectionId),
          lifecycleEvent: "reauthorizationRequired",
        },
      ],
    });
    await handler({ headers: {}, query: {}, rawBody: lifecycle });
    expect(h.events.at(-1)?.data).toMatchObject({ reason: "lifecycle" });
  });
});

describe("Graph notifications from strangers (audit)", () => {
  it("looks up a bounded number of subscriptions for a body nothing vouches for", async () => {
    // Anyone can post to the notification route. Each subscription id is looked up in the
    // database before the client state can prove anything: a body of a thousand made-up ids
    // must not cost a thousand queries.
    let lookups = 0;
    const h = harness(
      createFakeGraph({ address: `ms-${randomUUID().slice(0, 6)}@acme-roofing.com` }),
    );
    const directory = h.deps.db.directory;
    const counted = new Proxy(directory, {
      get(target, property, receiver) {
        if (property !== "findChannelConnectionBySubscription") {
          return Reflect.get(target, property, receiver) as unknown;
        }
        return (channel: "email", id: string) => {
          lookups += 1;
          return target.findChannelConnectionBySubscription(channel, id);
        };
      },
    });
    const handler = createGraphNotificationHandler({
      ...h.deps,
      db: new Proxy(h.deps.db, {
        get: (target, property, receiver) =>
          property === "directory" ? counted : (Reflect.get(target, property, receiver) as unknown),
      }),
    });
    const body = (ids: string[]) =>
      JSON.stringify({
        value: ids.map((subscriptionId) => ({ subscriptionId, clientState: "guess" })),
      });
    const before = h.events.length;
    const flood = await handler({
      headers: {},
      query: {},
      rawBody: body(Array.from({ length: 1000 }, (_, index) => `made-up-${index}`)),
    });
    expect(flood.status).toBe(202);
    expect(lookups).toBe(MAX_UNMATCHED_NOTIFICATIONS);
    // The same id a thousand times is one lookup.
    lookups = 0;
    await handler({
      headers: {},
      query: {},
      rawBody: body(Array.from({ length: 1000 }, () => "same")),
    });
    expect(lookups).toBe(1);
    expect(h.events.length).toBe(before);
  });
});

describe("Gmail push (Pub/Sub OIDC)", () => {
  it("accepts Google's token for our audience and push account, and nothing else", async () => {
    const gmail = createFakeGmail({ address: `push-${randomUUID().slice(0, 6)}@acme-roofing.com` });
    const h = harness(gmail);
    const tenant = await newBusiness();
    const { connection } = await connectGmail(h, tenant);
    const handler = createGmailPushHandler(h.deps);
    const call = (token: string | null, body = pubsubBody(gmail.address)) =>
      handler({
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        query: {},
        rawBody: body,
      });

    const before = h.events.length;
    expect((await call(pushToken(goodClaims()))).status).toBe(204);
    expect(h.events.slice(before)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ connectionId: connection.connectionId, reason: "push" }),
      }),
    ]);

    expect((await call(null)).status).toBe(401);
    expect((await call(pushToken({ ...goodClaims(), aud: "https://evil.example" }))).status).toBe(
      401,
    );
    expect(
      (await call(pushToken({ ...goodClaims(), email: "someone@evil.iam.gserviceaccount.com" })))
        .status,
    ).toBe(401);
    expect((await call(pushToken({ ...goodClaims(), email_verified: false }))).status).toBe(401);
    expect((await call(pushToken({ ...goodClaims(), iss: "https://evil.example" }))).status).toBe(
      401,
    );
    expect(
      (await call(pushToken({ ...goodClaims(), exp: Math.floor(Date.now() / 1000) - 3600 })))
        .status,
    ).toBe(401);
    expect((await call(pushToken(goodClaims(), "unknown-key"))).status).toBe(401);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key-1" })).toString(
      "base64url",
    );
    const body = Buffer.from(JSON.stringify(goodClaims())).toString("base64url");
    const forged = `${header}.${body}.${sign("RSA-SHA256", Buffer.from(`${header}.${body}`), other.privateKey).toString("base64url")}`;
    expect((await call(forged)).status).toBe(401);
    expect((await call(`${header}.${body}.`)).status).toBe(401);
    expect(h.events.length).toBe(before + 1);

    // A mailbox that is not connected here (or not Gmail) is acknowledged and ignored.
    expect(
      (await call(pushToken(goodClaims()), pubsubBody("nobody@acme-roofing.com"))).status,
    ).toBe(204);
    expect(h.events.length).toBe(before + 1);
  });
});

describe("Google's push keys", () => {
  it("reads the keys again for a key id it does not know (rotation), at most every few minutes", async () => {
    let fetches = 0;
    let published: JsonWebKeySet = { keys: [] };
    let now = new Date("2026-11-12T10:00:00Z");
    const source = googleKeySource(
      async () => {
        fetches += 1;
        return Response.json(published, { headers: { "cache-control": "max-age=3600" } });
      },
      () => now,
    );
    const check = (token: string) =>
      verifyGoogleOidcToken(
        token,
        { audience: goodClaims().aud, serviceAccount: goodClaims().email, now: new Date() },
        source,
      );
    // Read (and cached) before Google published the new key.
    expect((await check(pushToken(goodClaims()))).ok).toBe(false);
    expect(fetches).toBe(1);
    published = jwks;
    // Within the refresh interval an unknown id does not fetch again (forged ids cost nothing).
    expect((await check(pushToken(goodClaims()))).ok).toBe(false);
    expect(fetches).toBe(1);
    now = new Date(now.getTime() + 6 * 60_000);
    expect(await check(pushToken(goodClaims()))).toEqual({ ok: true, email: goodClaims().email });
    expect(fetches).toBe(2);
    // A known id uses the cache.
    expect((await check(pushToken(goodClaims()))).ok).toBe(true);
    expect(fetches).toBe(2);
  });
});

describe("IMAP/SMTP connections", () => {
  it("checks both servers, starts reading at the next message and stores the passwords encrypted", async () => {
    const h = harness(createFakeGmail());
    const tenant = await newBusiness();
    mail.deliver(rawEmail({ messageId: "<old@example.com>" }));
    const view = await createEmailConnectionService(h.deps).connectImap(tenant, null, {
      address: mail.address,
      imap: mail.imap,
      smtp: mail.smtp,
      imapPassword: mail.password,
    });
    expect(view).toMatchObject({
      provider: "imap",
      address: mail.address,
      status: "active",
      delivery: "polling",
    });
    expect(JSON.stringify(view)).not.toContain(mail.password);
    const [row] = await t.admin
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.id, view.connectionId));
    expect(EmailConnectionConfig.parse(row!.config)).toMatchObject({
      provider: "imap",
      sentFolder: "Sent",
    });
    const [secret] = await t.admin
      .select()
      .from(channelConnectionSecrets)
      .where(eq(channelConnectionSecrets.connectionId, view.connectionId));
    expect(secret?.ciphertext).not.toContain(mail.password);

    // The old message is not read; a new one is, once.
    mail.deliver(
      rawEmail({ messageId: `<new-${view.connectionId}@example.com>`, to: mail.address }),
    );
    mail.deliver(outOfOffice("<nothing-of-ours@x>"));
    const target = { ...tenant, connectionId: view.connectionId };
    const result = await syncBatch(h.deps, createAccessTokens(h.deps), target);
    expect(result.outcomes).toEqual({ ingested: 1, automatic: 1 });
    expect(h.ingested.at(-1)?.messages[0]).toMatchObject({
      externalMessageId: `<new-${view.connectionId}@example.com>`,
      externalThreadId: `mid:<new-${view.connectionId}@example.com>`,
    });
    expect((await syncBatch(h.deps, createAccessTokens(h.deps), target)).fetched).toBe(0);

    // A wrong password, a private host and an odd port are refused before anything is stored.
    const service = createEmailConnectionService(h.deps);
    const other = await newBusiness();
    await expect(
      service.connectImap(other, null, {
        address: "x@acme.example",
        imap: mail.imap,
        smtp: mail.smtp,
        imapPassword: "wrong",
      }),
    ).rejects.toThrow(/refused the user name or password/);
    const strict = createEmailConnectionService({ ...h.deps, mailPolicy: undefined });
    await expect(
      strict.connectImap(other, null, {
        address: "x@acme.example",
        imap: { ...mail.imap, port: 993, host: "10.0.0.5" },
        smtp: mail.smtp,
        imapPassword: "x",
      }),
    ).rejects.toThrow(/public internet/);
    await expect(
      strict.connectImap(other, null, {
        address: "x@acme.example",
        imap: { ...mail.imap, port: 993, host: "mail.internal" },
        smtp: mail.smtp,
        imapPassword: "x",
      }),
    ).rejects.toThrow(/not a public host name/);
    await expect(
      strict.connectImap(other, null, {
        address: "x@acme.example",
        imap: { ...mail.imap, port: 22, host: "mail.acme.example" },
        smtp: mail.smtp,
        imapPassword: "x",
      }),
    ).rejects.toThrow(/standard IMAP port/);
    const otherRows = await t.admin
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.businessId, other.businessId));
    expect(otherRows).toEqual([]);
    // Another business cannot take the same inbox.
    await expect(
      service.connectImap(other, null, {
        address: mail.address,
        imap: mail.imap,
        smtp: mail.smtp,
        imapPassword: mail.password,
      }),
    ).rejects.toThrow(/another business/);

    // Disconnecting switches it off and deletes the password.
    await service.disconnect(tenant, view.connectionId);
    const [after] = await t.admin
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.id, view.connectionId));
    expect(after?.status).toBe("disabled");
    expect(
      await t.admin
        .select()
        .from(channelConnectionSecrets)
        .where(eq(channelConnectionSecrets.connectionId, view.connectionId)),
    ).toEqual([]);
    expect((await syncBatch(h.deps, createAccessTokens(h.deps), target)).stopped).toBe(
      "connection_disabled",
    );
  });
});

describe("keeping push alive", () => {
  it("renews a Graph subscription close to expiry and recreates one Microsoft removed", async () => {
    const graph = createFakeGraph({
      address: `renew-${randomUUID().slice(0, 6)}@acme-roofing.com`,
    });
    const h = harness(graph);
    const tenant = await newBusiness();
    const service = createEmailConnectionService(h.deps);
    const started = service.startOAuth(tenant, await staffUser(), "microsoft", { returnTo: "/x" });
    const { connection } = await service.completeOAuth(
      service.readState(
        new URL(started.authorizationUrl).searchParams.get("state")!,
        started.cookie.value,
      ),
      "code",
    );
    const target = { ...tenant, connectionId: connection.connectionId };
    const tokens = createAccessTokens(h.deps);
    expect(await ensurePush(h.deps, tokens, target)).toBe("current");
    const first = [...graph.subscriptions.keys()].at(-1)!;
    await saveState(h.deps, target, {
      microsoft: {
        deltaLinks: {},
        subscriptionExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    expect(await ensurePush(h.deps, tokens, target)).toBe("renewed");
    expect(Date.parse(graph.subscriptions.get(first)!.expirationDateTime)).toBeGreaterThan(
      Date.now() + 2 * 24 * 3600_000,
    );
    graph.subscriptions.delete(first);
    expect(await ensurePush(h.deps, tokens, target, { force: true })).toBe("created");
    const second = [...graph.subscriptions.keys()].at(-1)!;
    expect(second).not.toBe(first);
    expect(
      (await t.db.directory.findChannelConnectionBySubscription("email", second))?.connectionId,
    ).toBe(connection.connectionId);
    expect(await t.db.directory.findChannelConnectionBySubscription("email", first)).toBeNull();
  });

  it("renews a Gmail watch once a day without moving the history cursor", async () => {
    const gmail = createFakeGmail({
      address: `watch-${randomUUID().slice(0, 6)}@acme-roofing.com`,
    });
    const h = harness(gmail);
    const tenant = await newBusiness();
    const { connection } = await connectGmail(h, tenant);
    const target = { ...tenant, connectionId: connection.connectionId };
    const tokens = createAccessTokens(h.deps);
    expect(await ensurePush(h.deps, tokens, target)).toBe("current");
    const [before] = await t.admin
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.id, connection.connectionId));
    const cursor = readState(before?.state).gmail?.historyId;
    gmail.deliver(rawEmail({ to: gmail.address }));
    await saveState(h.deps, target, {
      gmail: {
        historyId: cursor!,
        watchExpiresAt: new Date(Date.now() + 6 * 24 * 3600_000 - 21 * 3600_000).toISOString(),
      },
    });
    gmail.watch = null;
    expect(await ensurePush(h.deps, tokens, target)).toBe("renewed");
    expect(gmail.watch).not.toBeNull();
    const [after] = await t.admin
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.id, connection.connectionId));
    expect(readState(after?.state).gmail?.historyId).toBe(cursor);
  });
});

describe("sending limits per inbox", () => {
  it("holds the bot's emails past the hourly limit until the next hour, and always lets a person's through", async () => {
    const tenant = await newBusiness();
    const throttle = createEmailSendThrottle();
    const connectionId = randomUUID();
    const now = new Date("2026-11-11T21:10:00Z");
    const scope = t.db.forBusiness(tenant.businessId);
    const { applySettingChanges } = await import("@repo/settings/server");
    await scope.run((ctx) =>
      applySettingChanges(ctx, {
        target: { scope: "business", ...tenant },
        changes: [{ key: "channels.email.max_sends_per_hour", value: 2 }],
        actor: { type: "system", label: "email tests" },
      }),
    );
    const acquire = (author: "bot" | "human_agent") =>
      scope.run((ctx) =>
        throttle.acquire(ctx, { connectionId, messageId: randomUUID(), author, now }),
      );
    expect(await acquire("bot")).toEqual({ ok: true });
    expect(await acquire("bot")).toEqual({ ok: true });
    expect(await acquire("bot")).toEqual({
      ok: false,
      retryAfterSeconds: 50 * 60,
      reason: "hourly_limit",
    });
    expect(await acquire("human_agent")).toEqual({ ok: true });
    // Refused attempts are not counted; a new hour starts fresh.
    const later = new Date("2026-11-11T22:00:01Z");
    expect(
      await scope.run((ctx) =>
        throttle.acquire(ctx, { connectionId, messageId: randomUUID(), author: "bot", now: later }),
      ),
    ).toEqual({ ok: true });

    // At the daily limit the send waits for the next day, and the hour's count is given back.
    await scope.run((ctx) =>
      applySettingChanges(ctx, {
        target: { scope: "business", ...tenant },
        changes: [{ key: "channels.email.max_sends_per_day", value: 4 }],
        actor: { type: "system", label: "email tests" },
      }),
    );
    const evening = new Date("2026-11-11T23:30:00Z");
    const atEvening = () =>
      scope.run((ctx) =>
        throttle.acquire(ctx, {
          connectionId,
          messageId: randomUUID(),
          author: "bot",
          now: evening,
        }),
      );
    // 2 + 1 (person) + 1 counted today: the day is full.
    expect(await atEvening()).toEqual({
      ok: false,
      retryAfterSeconds: 30 * 60,
      reason: "daily_limit",
    });
    const [hour] = await t.admin
      .select({ value: usageCounters.value })
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.subject, `connection:${connectionId}`),
          eq(usageCounters.windowStart, new Date("2026-11-11T23:00:00Z")),
          eq(usageCounters.windowSeconds, 3600),
        ),
      );
    expect(hour?.value).toBe(0);
  });
});
