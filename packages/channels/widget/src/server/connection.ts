import { randomBytes } from "node:crypto";

import { type ChannelConnectionId, WIDGET_PUBLIC_KEY_PATTERN } from "@repo/core";
import {
  and,
  type AuditActor,
  type BusinessContext,
  channelConnections,
  eq,
  recordSystemAudit,
} from "@repo/db";
import { loadSettings } from "@repo/settings/server";

const KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A fresh public key: `wpk_` and 24 random letters and digits (about 143 bits). */
export function generateWidgetKey(): string {
  const bytes = randomBytes(48);
  let key = "";
  for (const byte of bytes) {
    // 248 = 62 × 4: drop the bytes that would bias the alphabet.
    if (byte >= 248) continue;
    key += KEY_ALPHABET[byte % 62];
    if (key.length === 24) break;
  }
  if (key.length < 24) return generateWidgetKey();
  return `wpk_${key}`;
}

export function isWidgetKey(value: string): boolean {
  return WIDGET_PUBLIC_KEY_PATTERN.test(value);
}

export interface WidgetConnectionRow {
  readonly connectionId: ChannelConnectionId;
  readonly publicKey: string;
  readonly status: string;
}

async function findConnection(ctx: BusinessContext): Promise<WidgetConnectionRow | null> {
  const [row] = await ctx.tx
    .select({
      connectionId: channelConnections.id,
      publicKey: channelConnections.externalAccountId,
      status: channelConnections.status,
    })
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.businessId, ctx.tenant.businessId),
        eq(channelConnections.channel, "widget"),
      ),
    )
    .orderBy(channelConnections.createdAt)
    .limit(1);
  return row ?? null;
}

/**
 * The business's website chat connection, created on first use with a fresh public key.
 * A business has one. Like every connection it is written in the business's system scope:
 * call this from a server function after checking that the user may manage the business's
 * channels (C16). The public key decides only which business a visitor writes to; it cannot
 * claim anyone else's messages, so creating one needs no proof of control.
 */
export async function ensureWidgetConnection(
  ctx: BusinessContext,
  options: { readonly actor: AuditActor; readonly now?: Date },
): Promise<WidgetConnectionRow> {
  const existing = await findConnection(ctx);
  if (existing !== null) {
    if (existing.status !== "active" && existing.status !== "disabled") {
      await ctx.tx
        .update(channelConnections)
        .set({ status: "active", lastError: null, lastErrorAt: null })
        .where(eq(channelConnections.id, existing.connectionId));
      return { ...existing, status: "active" };
    }
    return existing;
  }
  const publicKey = generateWidgetKey();
  const [created] = await ctx.tx
    .insert(channelConnections)
    .values({
      ...ctx.tenant,
      channel: "widget",
      externalAccountId: publicKey,
      displayName: "Website chat",
      status: "active",
      connectedAt: options.now ?? new Date(),
      connectedBy: options.actor.type === "user" ? options.actor.userId : null,
    })
    .returning({ id: channelConnections.id });
  await recordSystemAudit(ctx, options.actor, {
    action: "channel.widget_created",
    targetType: "channel_connection",
    targetId: created!.id,
    summary: "Website chat set up.",
  });
  return { connectionId: created!.id, publicKey, status: "active" };
}

/**
 * Gives the widget a new public key. The old snippet stops working at once (visitors already
 * chatting keep their session); the website must be updated with the new snippet.
 */
export async function rotateWidgetKey(
  ctx: BusinessContext,
  options: { readonly actor: AuditActor },
): Promise<WidgetConnectionRow> {
  const current = await ensureWidgetConnection(ctx, options);
  const publicKey = generateWidgetKey();
  await ctx.tx
    .update(channelConnections)
    .set({ externalAccountId: publicKey })
    .where(eq(channelConnections.id, current.connectionId));
  await recordSystemAudit(ctx, options.actor, {
    action: "channel.widget_key_rotated",
    targetType: "channel_connection",
    targetId: current.connectionId,
    summary: "Website chat key replaced.",
  });
  return { ...current, publicKey };
}

/** Switches the website chat off (`disabled`) or back on (`active`). */
export async function setWidgetEnabled(
  ctx: BusinessContext,
  options: { readonly enabled: boolean; readonly actor: AuditActor },
): Promise<WidgetConnectionRow> {
  const current = await ensureWidgetConnection(ctx, options);
  const status = options.enabled ? "active" : "disabled";
  await ctx.tx
    .update(channelConnections)
    .set({ status })
    .where(eq(channelConnections.id, current.connectionId));
  await recordSystemAudit(ctx, options.actor, {
    action: options.enabled ? "channel.widget_enabled" : "channel.widget_disabled",
    targetType: "channel_connection",
    targetId: current.connectionId,
  });
  return { ...current, status };
}

export interface WidgetEmbedInfo {
  readonly connectionId: ChannelConnectionId | null;
  readonly publicKey: string | null;
  readonly status: string | null;
  /** Where the script is served. */
  readonly scriptUrl: string;
  /** The one line to paste before `</body>`, or null before the widget is set up. */
  readonly snippet: string | null;
  /** `channels.widget.allowed_origins`: the chat works on these sites only. */
  readonly allowedOrigins: readonly string[];
  /** True when no site is allowed yet, so the snippet would show nothing anywhere. */
  readonly needsOrigins: boolean;
}

export function widgetScriptUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/widget/v1/widget.js`;
}

export function widgetSnippet(appUrl: string, publicKey: string): string {
  return `<script src="${widgetScriptUrl(appUrl)}" data-key="${publicKey}" async></script>`;
}

/**
 * What the admin screen for the website chat shows (C16): the snippet, the key, the status
 * and the allowed sites. Contains nothing secret. Read-only: works in any business scope.
 */
export async function widgetEmbedInfo(
  ctx: BusinessContext,
  options: { readonly appUrl: string },
): Promise<WidgetEmbedInfo> {
  const connection = await findConnection(ctx);
  const settings = await loadSettings(ctx, ctx.tenant);
  const allowedOrigins = settings.values["channels.widget.allowed_origins"];
  return {
    connectionId: connection?.connectionId ?? null,
    publicKey: connection?.publicKey ?? null,
    status: connection?.status ?? null,
    scriptUrl: widgetScriptUrl(options.appUrl),
    snippet: connection === null ? null : widgetSnippet(options.appUrl, connection.publicKey),
    allowedOrigins,
    needsOrigins: allowedOrigins.length === 0,
  };
}
