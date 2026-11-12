import { randomBytes, randomUUID } from "node:crypto";

import { businessHoursState, describeNextOpen } from "@repo/ai";
import {
  type AgencyId,
  type BusinessId,
  type ChannelConnectionId,
  type Logger,
  logger as rootLogger,
  type NormalizedInboundMessage,
  type ParsedWebhook,
  TenantAccessError,
  WIDGET_MAX_TEXT_LENGTH,
  WidgetClientMessageId,
  type WidgetConfig,
  type WidgetError,
  type WidgetErrorCode,
  type WidgetMessage,
  type WidgetMessages,
  type WidgetPostResult,
  WidgetProfileField,
  WidgetProfileRequest,
  type WidgetProfileResult,
  type WidgetSession,
  WidgetSessionRequest,
} from "@repo/core";
import {
  and,
  asc,
  attachments,
  type BusinessContext,
  type BusinessTenant,
  businesses,
  channelConnections,
  contactIdentities,
  conversations,
  type Database,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  messages,
  or,
  sql,
  takeoverLocks,
  widgetSessions,
} from "@repo/db";
import type { TenantStorage } from "@repo/db/storage";
import { type AppSettings, channelSetting, renderTemplate } from "@repo/settings";
import { loadSettings } from "@repo/settings/server";
import { z } from "zod";

import { isOriginAllowed, normalizeOrigin } from "../origins";
import { visitorTopic } from "../realtime";
import { assertWidgetSecret, hashIp, signWidgetToken, verifyWidgetToken } from "../token";
import { MEGABYTE, photoFileName, type SniffedImage, sniffImage } from "../uploads";
import { isWidgetKey } from "./connection";
import { hit } from "./limits";

/** What the route knows about the HTTP request, besides its body. */
export interface WidgetRequestInfo {
  /** The `Origin` header. Browsers set it on every cross-origin request the widget makes. */
  readonly origin: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export type WidgetOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly body: WidgetError };

export interface WidgetPhoto {
  readonly bytes: Uint8Array;
  readonly fileName: string | null;
}

export interface WidgetServiceOptions {
  readonly db: Database;
  /** `pipeline.ingest`: stores the visitor's message and starts the reply. */
  readonly ingest: (parsed: ParsedWebhook) => Promise<unknown>;
  readonly storage: (tenant: BusinessTenant) => TenantStorage;
  /** WIDGET_SESSION_SECRET. */
  readonly secret: string;
  /** Supabase Realtime for live pokes; null makes the browser poll. */
  readonly realtime: { readonly url: string; readonly apiKey: string } | null;
  readonly clock?: () => Date;
  readonly logger?: Logger;
}

export interface WidgetService {
  /** Appearance and behaviour of a business's widget, for an allowed site. */
  config(key: string, request: WidgetRequestInfo): Promise<WidgetOutcome<WidgetConfig>>;
  /** Starts a visitor session, or resumes the one whose token the browser kept. */
  startSession(body: unknown, request: WidgetRequestInfo): Promise<WidgetOutcome<WidgetSession>>;
  /** Saves the pre-chat details (name, phone, email). */
  saveProfile(
    token: string | null,
    body: unknown,
    request: WidgetRequestInfo,
  ): Promise<WidgetOutcome<WidgetProfileResult>>;
  /** A visitor's message: text, a photo or both. */
  postMessage(
    token: string | null,
    input: { readonly id: unknown; readonly text: unknown; readonly photo: WidgetPhoto | null },
    request: WidgetRequestInfo,
  ): Promise<WidgetOutcome<WidgetPostResult>>;
  /** The visitor's conversation, from `after` on, and whether a reply is being written. */
  listMessages(
    token: string | null,
    after: string | null,
    request: WidgetRequestInfo,
  ): Promise<WidgetOutcome<WidgetMessages>>;
}

const TYPING_WINDOW_MS = 2 * 60 * 1000;
const PHOTO_LINK_SECONDS = 10 * 60;
const SEEN_UPDATE_MS = 60 * 1000;
const HISTORY_LIMIT = 100;
const VISIBLE_OUTBOUND = ["sent", "delivered", "read"] as const;
/**
 * Message polls and pre-chat saves one session may make per minute. The script polls at most
 * every 1.5 s (40 a minute) plus a fetch per poke, so only a script run by someone else
 * reaches this. A protocol guard, not a business choice: no setting.
 */
const READS_PER_SESSION_PER_MINUTE = 120;

const ERROR_MESSAGES: Readonly<Record<WidgetErrorCode, string>> = {
  invalid_request: "The request is not valid.",
  origin_not_allowed: "The chat is not enabled on this website.",
  widget_not_found: "This chat is not available.",
  session_invalid: "The chat session has ended. Please reload the page.",
  profile_required: "Please fill in your details first.",
  rate_limited: "You're sending messages very quickly. Please wait a moment.",
  photos_disabled: "Photos can't be sent in this chat.",
  photo_too_large: "That photo is too large.",
  photo_type: "Please send a JPG, PNG, WebP, GIF or HEIC photo.",
  too_large: "The request is too large.",
  unavailable: "The chat is unavailable right now. Please try again shortly.",
};

export function widgetFailure(
  status: number,
  error: WidgetErrorCode,
  extra: { readonly message?: string; readonly retryAfterSeconds?: number } = {},
): { readonly ok: false; readonly status: number; readonly body: WidgetError } {
  return {
    ok: false,
    status,
    body: {
      error,
      message: extra.message ?? ERROR_MESSAGES[error],
      ...(extra.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: extra.retryAfterSeconds }),
    },
  };
}

const ok = <T>(value: T): WidgetOutcome<T> => ({ ok: true, value });

/** A US number as E.164 (+1 and ten digits), or an international one that starts with +. */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  if (trimmed.startsWith("+")) {
    if (digits.startsWith("1")) return digits.length === 11 ? `+${digits}` : null;
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

type Profile = Readonly<Partial<Record<WidgetProfileField, string>>>;

function profileOf(stored: Record<string, string> | null | undefined): Profile {
  const profile: Partial<Record<WidgetProfileField, string>> = {};
  for (const field of WidgetProfileField.options) {
    const value = stored?.[field];
    if (typeof value === "string" && value.length > 0) profile[field] = value;
  }
  return profile;
}

function missingProfile(values: AppSettings, profile: Profile): WidgetProfileField[] {
  return values["channels.widget.pre_chat_fields"].filter((field) => profile[field] === undefined);
}

type SessionRow = typeof widgetSessions.$inferSelect;

interface Authed {
  readonly ctx: BusinessContext;
  readonly session: SessionRow;
  /** The connection's current public key (the account id messages are ingested under). */
  readonly key: string;
  readonly values: AppSettings;
}

type Checked =
  | { readonly duplicate: true }
  | {
      readonly duplicate: false;
      readonly tenant: BusinessTenant;
      readonly session: SessionRow;
      readonly key: string;
      readonly profile: Profile;
      readonly externalMessageId: string;
      readonly image: SniffedImage | null;
    };

const Cursor = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,9})$/;

/**
 * The website chat's public API, behind `/api/widget/v1` (ARCHITECTURE §3, "Public"). Every
 * call is tied to one business: the config and session calls by the widget's public key
 * (through the directory), the others by the signed session token, and every one of them
 * checks the request's origin against the business's allowed sites. All database work then
 * happens in that business's system scope.
 */
export function createWidgetService(options: WidgetServiceOptions): WidgetService {
  assertWidgetSecret(options.secret);
  const { db, secret } = options;
  const clock = options.clock ?? (() => new Date());
  const log = (options.logger ?? rootLogger).child({ component: "widget" });

  async function businessRow(ctx: BusinessContext) {
    const [row] = await ctx.tx
      .select({ name: businesses.name, timezone: businesses.timezone, status: businesses.status })
      .from(businesses)
      .where(eq(businesses.id, ctx.tenant.businessId))
      .limit(1);
    return row;
  }

  /** The connection of a public key, when the key is well-formed and the chat is switched on. */
  async function findWidget(key: string) {
    if (!isWidgetKey(key)) return null;
    const ref = await db.directory.findChannelConnection("widget", key);
    if (ref?.channel !== "widget" || ref.status !== "active") return null;
    if (ref.businessStatus === "archived") return null;
    return ref;
  }

  function realtimeFor(connectionId: string, visitorId: string): WidgetSession["realtime"] {
    if (options.realtime === null) return null;
    return { ...options.realtime, topic: visitorTopic(secret, connectionId, visitorId) };
  }

  function issue(session: SessionRow, tenant: BusinessTenant, expiresAt: Date): string {
    return signWidgetToken(secret, {
      sid: session.id,
      cid: session.channelConnectionId,
      bid: tenant.businessId,
      aid: tenant.agencyId,
      exp: Math.floor(expiresAt.getTime() / 1000),
    });
  }

  /** Counts a poll or a pre-chat save; a failure once the session makes too many. */
  async function readLimit(ctx: BusinessContext, session: SessionRow, now: Date) {
    const reads = await hit(ctx, {
      metric: "widget_reads",
      subject: `widget_session:${session.id}`,
      windowSeconds: 60,
      now,
    });
    if (reads.count <= READS_PER_SESSION_PER_MINUTE) return null;
    return widgetFailure(429, "rate_limited", { retryAfterSeconds: reads.retryAfterSeconds });
  }

  async function authed<T>(
    token: string | null,
    request: WidgetRequestInfo,
    work: (state: Authed) => Promise<WidgetOutcome<T>>,
  ): Promise<WidgetOutcome<T>> {
    const origin = normalizeOrigin(request.origin);
    if (origin === null) return widgetFailure(403, "origin_not_allowed");
    const now = clock();
    const claims = token === null ? null : verifyWidgetToken(secret, token, now);
    if (claims === null) return widgetFailure(401, "session_invalid");
    try {
      return await db
        .forBusiness(claims.bid as BusinessId, { agencyId: claims.aid as AgencyId })
        .run(async (ctx) => {
          const [session] = await ctx.tx
            .select()
            .from(widgetSessions)
            .where(
              and(
                eq(widgetSessions.id, claims.sid),
                eq(widgetSessions.channelConnectionId, claims.cid as ChannelConnectionId),
              ),
            )
            .limit(1);
          const expired =
            session?.expiresAt != null && session.expiresAt.getTime() <= now.getTime();
          if (session?.revokedAt !== null || expired) {
            return widgetFailure(401, "session_invalid");
          }
          // A session belongs to the site it was started on.
          if (session.origin !== origin) return widgetFailure(403, "origin_not_allowed");
          const [connection] = await ctx.tx
            .select({
              key: channelConnections.externalAccountId,
              status: channelConnections.status,
              channel: channelConnections.channel,
            })
            .from(channelConnections)
            .where(eq(channelConnections.id, session.channelConnectionId))
            .limit(1);
          const business = await businessRow(ctx);
          if (
            connection?.channel !== "widget" ||
            connection.status !== "active" ||
            business === undefined ||
            business.status === "archived"
          ) {
            return widgetFailure(404, "widget_not_found");
          }
          const settings = await loadSettings(ctx, ctx.tenant, { logger: log });
          if (!isOriginAllowed(origin, settings.values["channels.widget.allowed_origins"])) {
            return widgetFailure(403, "origin_not_allowed");
          }
          return work({ ctx, session, key: connection.key, values: settings.values });
        });
    } catch (error) {
      // A token whose business is not in its agency (or no longer exists).
      if (error instanceof TenantAccessError) return widgetFailure(401, "session_invalid");
      throw error;
    }
  }

  return {
    async config(key, request) {
      const origin = normalizeOrigin(request.origin);
      if (origin === null) return widgetFailure(403, "origin_not_allowed");
      const ref = await findWidget(key);
      if (ref === null) return widgetFailure(404, "widget_not_found");
      const now = clock();
      return db.forBusiness(ref.businessId, { agencyId: ref.agencyId }).run(async (ctx) => {
        const settings = await loadSettings(ctx, ctx.tenant, { logger: log });
        const values = settings.values;
        if (!isOriginAllowed(origin, values["channels.widget.allowed_origins"])) {
          return widgetFailure(403, "origin_not_allowed");
        }
        const business = await businessRow(ctx);
        if (business === undefined) return widgetFailure(404, "widget_not_found");
        const vars = { business_name: business.name, bot_name: values["persona.bot_name"] };
        // "Summit Roofing Co." at the end of a sentence must not read "Co..".
        const fill = (text: string) =>
          renderTemplate(text, vars)
            .replace(/(?<!\.)\.\.(?!\.)/g, ".")
            .trim();
        const hours = businessHoursState(values, business.timezone, now);
        let notice: string | null = null;
        if (!hours.open && values["channels.widget.show_hours_notice"]) {
          const reason = hours.holiday === null ? "" : ` for ${hours.holiday}`;
          notice =
            hours.nextOpen === null
              ? `Our office is closed${reason} right now. Leave a message and the team will get back to you.`
              : `Our office is closed${reason} right now and opens ${describeNextOpen(hours.nextOpen)}. Leave a message and the team will get back to you.`;
        }
        return ok<WidgetConfig>({
          key,
          businessName: business.name,
          botName: values["persona.bot_name"],
          appearance: {
            primaryColor: values["channels.widget.primary_color"],
            textColor: values["channels.widget.text_color"],
            logoUrl: values["channels.widget.logo_url"],
            title: fill(values["channels.widget.title"]),
            subtitle: fill(values["channels.widget.subtitle"]),
            teaser: fill(values["channels.widget.teaser"]),
            position: values["channels.widget.position"],
            autoOpenSeconds: values["channels.widget.auto_open_seconds"],
          },
          greeting: fill(channelSetting(values, "voice.opening_message", "widget")),
          preChat: values["channels.widget.pre_chat_fields"],
          photos: {
            enabled: values["channels.widget.photo_upload"],
            maxBytes: values["channels.widget.max_upload_mb"] * MEGABYTE,
          },
          privacy: {
            text: values["channels.widget.consent_text"],
            url: values["channels.widget.privacy_url"],
          },
          hours: { open: hours.open, notice },
          maxTextLength: WIDGET_MAX_TEXT_LENGTH,
        });
      });
    },

    async startSession(body, request) {
      const parsed = WidgetSessionRequest.safeParse(body);
      if (!parsed.success) return widgetFailure(400, "invalid_request");
      const origin = normalizeOrigin(request.origin);
      if (origin === null) return widgetFailure(403, "origin_not_allowed");
      const ref = await findWidget(parsed.data.key);
      if (ref === null) return widgetFailure(404, "widget_not_found");
      const now = clock();
      const claims =
        parsed.data.token === null ? null : verifyWidgetToken(secret, parsed.data.token, now);

      return db.forBusiness(ref.businessId, { agencyId: ref.agencyId }).run(async (ctx) => {
        const settings = await loadSettings(ctx, ctx.tenant, { logger: log });
        const values = settings.values;
        if (!isOriginAllowed(origin, values["channels.widget.allowed_origins"])) {
          return widgetFailure(403, "origin_not_allowed");
        }
        const expiresAt = new Date(
          now.getTime() + values["channels.widget.session_days"] * 24 * 60 * 60 * 1000,
        );

        // Resume the session the browser kept, when it is still good for this site.
        if (
          claims !== null &&
          claims.cid === ref.connectionId &&
          claims.bid === ref.businessId &&
          claims.aid === ref.agencyId
        ) {
          const [resumed] = await ctx.tx
            .update(widgetSessions)
            .set({ lastSeenAt: now, expiresAt })
            .where(
              and(
                eq(widgetSessions.id, claims.sid),
                eq(widgetSessions.channelConnectionId, ref.connectionId),
                eq(widgetSessions.origin, origin),
                isNull(widgetSessions.revokedAt),
                gt(widgetSessions.expiresAt, now),
              ),
            )
            .returning();
          if (resumed !== undefined) {
            return ok<WidgetSession>({
              token: issue(resumed, ctx.tenant, expiresAt),
              expiresAt: expiresAt.toISOString(),
              needsProfile: missingProfile(values, profileOf(resumed.profile)),
              realtime: realtimeFor(ref.connectionId, resumed.visitorId),
              resumed: true,
            });
          }
        }

        const ipHash = hashIp(secret, request.ip);
        const limit = await hit(ctx, {
          metric: "widget_sessions",
          subject: `ip:${ipHash}`,
          windowSeconds: 3600,
          now,
        });
        if (limit.count > values["limits.widget_sessions_per_ip_per_hour"]) {
          log.warn("widget.session_rate_limited", { businessId: ctx.tenant.businessId });
          return widgetFailure(429, "rate_limited", {
            message: "Too many new chats from your network. Please try again later.",
            retryAfterSeconds: limit.retryAfterSeconds,
          });
        }
        const [created] = await ctx.tx
          .insert(widgetSessions)
          .values({
            ...ctx.tenant,
            channelConnectionId: ref.connectionId,
            visitorId: `v_${randomBytes(16).toString("base64url")}`,
            origin,
            userAgent: request.userAgent?.slice(0, 300) ?? null,
            ipHash,
            lastSeenAt: now,
            expiresAt,
          })
          .returning();
        const session = created!;
        return ok<WidgetSession>({
          token: issue(session, ctx.tenant, expiresAt),
          expiresAt: expiresAt.toISOString(),
          needsProfile: missingProfile(values, {}),
          realtime: realtimeFor(ref.connectionId, session.visitorId),
          resumed: false,
        });
      });
    },

    async saveProfile(token, body, request) {
      const parsed = WidgetProfileRequest.safeParse(body);
      if (!parsed.success) {
        return widgetFailure(400, "invalid_request", { message: "Please check your details." });
      }
      const update: Partial<Record<WidgetProfileField, string>> = {};
      if (parsed.data.name !== undefined) update.name = parsed.data.name.replace(/\s+/g, " ");
      if (parsed.data.phone !== undefined) {
        const phone = normalizePhone(parsed.data.phone);
        if (phone === null) {
          return widgetFailure(400, "invalid_request", {
            message: "Please enter a valid phone number.",
          });
        }
        update.phone = phone;
      }
      if (parsed.data.email !== undefined) {
        const email = z.email().safeParse(parsed.data.email.toLowerCase());
        if (!email.success) {
          return widgetFailure(400, "invalid_request", {
            message: "Please enter a valid email address.",
          });
        }
        update.email = email.data;
      }
      return authed(token, request, async ({ ctx, session, values }) => {
        const limited = await readLimit(ctx, session, clock());
        if (limited !== null) return limited;
        const profile = { ...profileOf(session.profile), ...update };
        await ctx.tx
          .update(widgetSessions)
          .set({ profile, lastSeenAt: clock() })
          .where(eq(widgetSessions.id, session.id));
        return ok<WidgetProfileResult>({ needsProfile: missingProfile(values, profile) });
      });
    },

    async postMessage(token, input, request) {
      const id = WidgetClientMessageId.safeParse(input.id);
      if (!id.success) return widgetFailure(400, "invalid_request");
      if (input.text !== null && input.text !== undefined && typeof input.text !== "string") {
        return widgetFailure(400, "invalid_request");
      }
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (text.length > WIDGET_MAX_TEXT_LENGTH) {
        return widgetFailure(400, "invalid_request", { message: "That message is too long." });
      }
      if (text.length === 0 && input.photo === null) return widgetFailure(400, "invalid_request");
      const now = clock();

      const checked = await authed<Checked>(
        token,
        request,
        async ({ ctx, session, key, values }) => {
          const profile = profileOf(session.profile);
          if (missingProfile(values, profile).length > 0) {
            return widgetFailure(409, "profile_required");
          }
          const externalMessageId = `${session.id}:${id.data}`;
          const [existing] = await ctx.tx
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.channelConnectionId, session.channelConnectionId),
                eq(messages.externalMessageId, externalMessageId),
              ),
            )
            .limit(1);
          if (existing !== undefined) {
            return ok<Checked>({ duplicate: true });
          }

          const perVisitor = await hit(ctx, {
            metric: "widget_messages",
            subject: `widget_session:${session.id}`,
            windowSeconds: 60,
            now,
          });
          if (perVisitor.count > values["limits.widget_messages_per_minute"]) {
            return widgetFailure(429, "rate_limited", {
              retryAfterSeconds: perVisitor.retryAfterSeconds,
            });
          }
          const perBusiness = await hit(ctx, {
            metric: "widget_messages",
            subject: "business",
            windowSeconds: 60,
            now,
          });
          if (perBusiness.count > values["limits.widget_messages_per_business_per_minute"]) {
            log.warn("widget.business_rate_limited", { businessId: ctx.tenant.businessId });
            return widgetFailure(429, "rate_limited", {
              message: "The chat is very busy right now. Please try again in a minute.",
              retryAfterSeconds: perBusiness.retryAfterSeconds,
            });
          }

          let image: SniffedImage | null = null;
          if (input.photo !== null) {
            if (!values["channels.widget.photo_upload"]) {
              return widgetFailure(403, "photos_disabled");
            }
            const maxMb = values["channels.widget.max_upload_mb"];
            if (input.photo.bytes.length > maxMb * MEGABYTE) {
              return widgetFailure(413, "photo_too_large", {
                message: `That photo is too large. Please send one under ${maxMb} MB.`,
              });
            }
            image = sniffImage(input.photo.bytes);
            if (image === null) return widgetFailure(415, "photo_type");
            const photos = await hit(ctx, {
              metric: "widget_photos",
              subject: `widget_session:${session.id}`,
              windowSeconds: 3600,
              now,
            });
            if (photos.count > values["limits.widget_photos_per_visitor_per_hour"]) {
              return widgetFailure(429, "rate_limited", {
                message: "You've sent a lot of photos. Please wait a while before sending more.",
                retryAfterSeconds: photos.retryAfterSeconds,
              });
            }
          }
          return ok<Checked>({
            duplicate: false,
            tenant: ctx.tenant,
            session,
            key,
            profile,
            externalMessageId,
            image,
          });
        },
      );
      if (!checked.ok) return checked;
      if (checked.value.duplicate) return ok<WidgetPostResult>({ accepted: true, duplicate: true });
      const { tenant, session, key, profile, externalMessageId, image } = checked.value;

      const photos: NormalizedInboundMessage["attachments"] = [];
      if (input.photo !== null && image !== null) {
        const fileName = photoFileName(input.photo.fileName, image);
        const stored = await options
          .storage(tenant)
          .putUpload({ ownerId: session.id, uploadId: randomUUID(), fileName }, input.photo.bytes, {
            contentType: image.mimeType,
          });
        photos.push({
          kind: "image",
          mimeType: image.mimeType,
          fileName,
          sizeBytes: input.photo.bytes.length,
          source: { type: "storage", bucket: stored.bucket, path: stored.path },
        });
      }

      const message: NormalizedInboundMessage = {
        channel: "widget",
        externalAccountId: key,
        externalMessageId,
        externalThreadId: null,
        sender: {
          externalId: session.visitorId,
          displayName: profile.name ?? null,
          phone: profile.phone ?? null,
          email: profile.email ?? null,
        },
        sentAt: now.toISOString(),
        kind: text.length === 0 ? "media" : "text",
        text: text.length === 0 ? null : text,
        attachments: photos,
        location: null,
        interactiveReply: null,
        reaction: null,
        replyToExternalMessageId: null,
        email: null,
        metadata: {},
      };
      await options.ingest({ messages: [message], statuses: [], signals: [] });

      await db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId }).run(async (ctx) => {
        const found = await findConversation(ctx, session);
        await ctx.tx
          .update(widgetSessions)
          .set({
            lastMessageAt: now,
            lastSeenAt: now,
            ...(found === null
              ? {}
              : { contactId: found.contactId, conversationId: found.conversationId }),
          })
          .where(eq(widgetSessions.id, session.id));
      });
      return ok<WidgetPostResult>({ accepted: true, duplicate: false });
    },

    async listMessages(token, after, request) {
      return authed(token, request, async ({ ctx, session, values }) => {
        const now = clock();
        const limited = await readLimit(ctx, session, now);
        if (limited !== null) return limited;
        if (
          session.lastSeenAt === null ||
          now.getTime() - session.lastSeenAt.getTime() > SEEN_UPDATE_MS
        ) {
          await ctx.tx
            .update(widgetSessions)
            .set({ lastSeenAt: now })
            .where(eq(widgetSessions.id, session.id));
        }
        const found = await findConversation(ctx, session);
        if (found === null) return ok<WidgetMessages>({ messages: [], cursor: "", typing: false });
        const { conversationId, handledThroughSeq } = found;

        const match = after === null ? null : Cursor.exec(after);
        const afterSeq = match !== null && match[1] === conversationId ? Number(match[2]) : null;

        const visible = and(
          eq(messages.conversationId, conversationId),
          or(
            eq(messages.direction, "inbound"),
            and(
              eq(messages.direction, "outbound"),
              inArray(messages.author, ["bot", "human_agent"]),
              inArray(messages.status, [...VISIBLE_OUTBOUND]),
            ),
          ),
          afterSeq === null ? undefined : gt(messages.sequence, afterSeq),
        );
        const selection = {
          id: messages.id,
          direction: messages.direction,
          author: messages.author,
          kind: messages.kind,
          text: messages.text,
          payload: messages.payload,
          externalMessageId: messages.externalMessageId,
          sequence: messages.sequence,
          sentAt: messages.sentAt,
          createdAt: messages.createdAt,
        };
        const rows =
          afterSeq === null
            ? (
                await ctx.tx
                  .select(selection)
                  .from(messages)
                  .where(visible)
                  .orderBy(desc(messages.sequence))
                  .limit(HISTORY_LIMIT)
              ).reverse()
            : await ctx.tx
                .select(selection)
                .from(messages)
                .where(visible)
                .orderBy(asc(messages.sequence))
                .limit(HISTORY_LIMIT);

        const photoRows =
          rows.length === 0
            ? []
            : await ctx.tx
                .select({
                  messageId: attachments.messageId,
                  fileName: attachments.fileName,
                  path: attachments.storagePath,
                })
                .from(attachments)
                .where(
                  and(
                    inArray(
                      attachments.messageId,
                      rows.map((row) => row.id),
                    ),
                    eq(attachments.kind, "image"),
                    eq(attachments.status, "stored"),
                  ),
                )
                .orderBy(asc(attachments.createdAt));
        const storage = options.storage(ctx.tenant);
        const photosByMessage = new Map<string, { url: string; name: string | null }[]>();
        for (const photo of photoRows) {
          if (photo.path === null) continue;
          const url = await storage.signedUrl(photo.path, PHOTO_LINK_SECONDS);
          const list = photosByMessage.get(photo.messageId) ?? [];
          list.push({ url, name: photo.fileName });
          photosByMessage.set(photo.messageId, list);
        }

        const [pending] = await ctx.tx
          .select({ sequence: sql<number | null>`min(${messages.sequence})` })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversationId),
              eq(messages.direction, "outbound"),
              inArray(messages.status, ["queued", "sending"]),
            ),
          );
        const pendingOutbound = pending?.sequence ?? null;
        const [unanswered] = await ctx.tx
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversationId),
              eq(messages.direction, "inbound"),
              gt(messages.sequence, handledThroughSeq),
              sql`${messages.kind} <> 'reaction'`,
              gt(messages.createdAt, new Date(now.getTime() - TYPING_WINDOW_MS)),
            ),
          )
          .limit(1);
        const [takeover] = await ctx.tx
          .select({ id: takeoverLocks.id })
          .from(takeoverLocks)
          .where(
            and(eq(takeoverLocks.conversationId, conversationId), isNull(takeoverLocks.releasedAt)),
          )
          .limit(1);
        const typing =
          values["conversation.typing_indicator"] &&
          takeover === undefined &&
          (pendingOutbound !== null || unanswered !== undefined);

        // The cursor never moves past a reply that is still on its way, so it is not skipped
        // when it is sent after a later message of the visitor.
        let cursorSeq = Math.max(afterSeq ?? 0, rows.at(-1)?.sequence ?? 0);
        if (pendingOutbound !== null) {
          cursorSeq = Math.max(afterSeq ?? 0, Math.min(cursorSeq, Number(pendingOutbound) - 1));
        }

        const list: WidgetMessage[] = rows.map((row) => {
          const inbound = row.direction === "inbound";
          const quick = row.payload["quickReplies"];
          return {
            id: row.id,
            clientId:
              inbound && row.externalMessageId !== null
                ? (row.externalMessageId.split(":")[1] ?? null)
                : null,
            from: inbound ? "visitor" : row.author === "human_agent" ? "team" : "bot",
            text: row.text,
            at: (row.sentAt ?? row.createdAt).toISOString(),
            photos: photosByMessage.get(row.id) ?? [],
            quickReplies:
              !inbound && Array.isArray(quick)
                ? quick.filter((item): item is string => typeof item === "string").slice(0, 6)
                : [],
          };
        });
        return ok<WidgetMessages>({
          messages: list,
          cursor: `${conversationId}:${cursorSeq}`,
          typing,
        });
      });
    },
  };
}

/** The visitor's current conversation: the newest one of their contact on this connection. */
async function findConversation(ctx: BusinessContext, session: SessionRow) {
  const [identity] = await ctx.tx
    .select({ contactId: contactIdentities.contactId })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.businessId, ctx.tenant.businessId),
        eq(contactIdentities.channel, "widget"),
        eq(contactIdentities.externalId, session.visitorId),
      ),
    )
    .limit(1);
  if (identity === undefined) return null;
  const [conversation] = await ctx.tx
    .select({ id: conversations.id, handledThroughSeq: conversations.handledThroughSeq })
    .from(conversations)
    .where(
      and(
        eq(conversations.channelConnectionId, session.channelConnectionId),
        eq(conversations.contactId, identity.contactId),
      ),
    )
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  if (conversation === undefined) return null;
  return {
    contactId: identity.contactId,
    conversationId: conversation.id,
    handledThroughSeq: conversation.handledThroughSeq,
  };
}
