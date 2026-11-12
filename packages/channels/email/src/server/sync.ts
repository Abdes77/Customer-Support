import type { BusinessTenant } from "@repo/db";
import {
  type AgencyId,
  AppError,
  type BusinessId,
  type ChannelConnectionId,
  ConfigError,
} from "@repo/core";
import { channelConnections, eq, sql } from "@repo/db";
import { type AppResolvedSettings } from "@repo/settings";
import { loadSettings } from "@repo/settings/server";

import {
  EmailConnectionConfig,
  type EmailConnectionState,
  type GmailConfig,
  type ImapConfig,
  type MicrosoftConfig,
  PasswordCredentials,
  readState,
} from "../config";
import { DEFAULT_MAIL_POLICY } from "../net/resolve";
import { MailProviderError } from "../providers/http";
import { MailServerError, openImap } from "../providers/imap";
import { GRAPH_FOLDERS, type GraphFolder } from "../providers/microsoft";
import type { EmailServerDeps } from "./deps";
import {
  type FetchedEmail,
  type ProcessContext,
  type ProcessOutcome,
  processEmail,
} from "./process";
import { type AccessTokens, markReconnectNeeded } from "./tokens";

/*
 * Reading an inbox from its stored cursor: Gmail's history id, Graph's delta links (one per
 * folder), IMAP's UIDVALIDITY and last UID (one per folder). One call reads at most
 * `BATCH_SIZE` messages and moves the cursor past them; `more` says whether to call again.
 * A new connection starts from the moment it was connected: old mail is never answered.
 */

export const BATCH_SIZE = 25;
/** How far back a Gmail or Graph inbox is read when its cursor was lost. */
const RESYNC_WINDOW_MS = 24 * 3600_000;

export interface SyncTarget {
  readonly agencyId: AgencyId;
  readonly businessId: BusinessId;
  readonly connectionId: ChannelConnectionId;
}

export interface BatchResult {
  readonly fetched: number;
  readonly more: boolean;
  readonly outcomes: Readonly<Partial<Record<ProcessOutcome, number>>>;
  /** Why nothing was read: the connection is switched off, not configured, refused access. */
  readonly stopped: string | null;
}

interface LoadedConnection {
  readonly tenant: BusinessTenant;
  readonly status: string;
  readonly config: EmailConnectionConfig;
  readonly state: EmailConnectionState;
  readonly connectedAt: Date | null;
  readonly settings: AppResolvedSettings;
}

async function load(deps: EmailServerDeps, target: SyncTarget): Promise<LoadedConnection | null> {
  return deps.db.forBusiness(target.businessId, { agencyId: target.agencyId }).run(async (ctx) => {
    const [row] = await ctx.tx
      .select({
        status: channelConnections.status,
        channel: channelConnections.channel,
        config: channelConnections.config,
        state: channelConnections.state,
        connectedAt: channelConnections.connectedAt,
      })
      .from(channelConnections)
      .where(eq(channelConnections.id, target.connectionId))
      .limit(1);
    if (row?.channel !== "email") return null;
    const config = EmailConnectionConfig.safeParse(row.config);
    if (!config.success) return null;
    const settings = await loadSettings(ctx, ctx.tenant, { logger: deps.logger });
    return {
      tenant: ctx.tenant,
      status: row.status,
      config: config.data,
      state: readState(row.state),
      connectedAt: row.connectedAt,
      settings,
    };
  });
}

/** Merges `patch` into the connection's state and records the sync. */
export async function saveState(
  deps: EmailServerDeps,
  target: SyncTarget,
  patch: Partial<EmailConnectionState>,
): Promise<void> {
  const now = (deps.clock ?? (() => new Date()))();
  const value = JSON.stringify({ ...patch });
  await deps.db.forBusiness(target.businessId, { agencyId: target.agencyId }).run(async (ctx) => {
    await ctx.tx
      .update(channelConnections)
      .set({ state: sql`${channelConnections.state} || ${value}::jsonb`, updatedAt: now })
      .where(eq(channelConnections.id, target.connectionId));
  });
}

function count(outcomes: Partial<Record<ProcessOutcome, number>>, outcome: ProcessOutcome): void {
  outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
}

async function gmailBatch(
  deps: EmailServerDeps,
  tokens: AccessTokens,
  target: SyncTarget,
  loaded: LoadedConnection & { config: GmailConfig },
  context: ProcessContext,
): Promise<BatchResult> {
  const now = (deps.clock ?? (() => new Date()))();
  const scope = deps.db.forBusiness(target.businessId, { agencyId: target.agencyId });
  const token = await scope.run((ctx) => tokens.inScope(ctx, target.connectionId, "gmail"));
  const outcomes: Partial<Record<ProcessOutcome, number>> = {};
  const start = loaded.state.gmail?.historyId;
  if (start === undefined) {
    const profile = await deps.gmail.profile(token);
    await saveState(deps, target, {
      gmail: { historyId: profile.historyId, watchExpiresAt: null },
      lastSyncAt: now.toISOString(),
      lastSyncError: null,
    });
    return { fetched: 0, more: false, outcomes, stopped: null };
  }

  const refs: {
    id: string;
    threadId: string | null;
    folder: "inbox" | "sent";
    historyId: string;
  }[] = [];
  let cursor = start;
  let pageToken: string | null = null;
  let exhausted = false;
  try {
    for (;;) {
      const page = await deps.gmail.history(token, { startHistoryId: start, pageToken });
      for (const record of page.history ?? []) {
        if (refs.length >= BATCH_SIZE) break;
        for (const added of record.messagesAdded ?? []) {
          const labels = added.message.labelIds ?? [];
          if (
            labels.some(
              (label) =>
                label === "DRAFT" || label === "SPAM" || label === "TRASH" || label === "CHAT",
            )
          )
            continue;
          const folder = labels.includes("SENT")
            ? "sent"
            : labels.includes("INBOX")
              ? "inbox"
              : null;
          if (folder === null) continue;
          if (refs.some((ref) => ref.id === added.message.id)) continue;
          refs.push({
            id: added.message.id,
            threadId: added.message.threadId ?? null,
            folder,
            historyId: record.id,
          });
        }
        cursor = record.id;
      }
      if (refs.length >= BATCH_SIZE) break;
      if (page.nextPageToken === undefined) {
        cursor = page.historyId;
        exhausted = true;
        break;
      }
      pageToken = page.nextPageToken;
    }
  } catch (error) {
    if (!(error instanceof MailProviderError && error.status === 404)) throw error;
    // The history id is too old (Gmail keeps about a week): read what arrived since the last
    // sync, then start again from the mailbox's current history id.
    // Never further back than a day: after a long outage (a reconnect weeks later) old mail
    // must not be answered.
    const since = Math.floor(
      Math.max(Date.parse(loaded.state.lastSyncAt ?? "") || 0, now.getTime() - RESYNC_WINDOW_MS) /
        1000,
    );
    const profile = await deps.gmail.profile(token);
    for (const [label, folder] of [
      ["INBOX", "inbox"],
      ["SENT", "sent"],
    ] as const) {
      const list = await deps.gmail.list(token, { q: `after:${since}`, labelIds: [label] });
      for (const message of list.messages ?? []) {
        if (refs.length >= BATCH_SIZE * 4) break;
        refs.push({
          id: message.id,
          threadId: message.threadId ?? null,
          folder,
          historyId: profile.historyId,
        });
      }
    }
    cursor = profile.historyId;
    exhausted = true;
    deps.logger.warn("email.gmail_history_reset", {
      businessId: target.businessId,
      connectionId: target.connectionId,
    });
  }

  for (const ref of refs) {
    let fetched: FetchedEmail;
    try {
      const message = await deps.gmail.raw(token, ref.id);
      if (message.labelIds.includes("SPAM") || message.labelIds.includes("DRAFT")) continue;
      fetched = {
        raw: message.raw,
        folder: ref.folder,
        providerMessageId: message.id,
        providerThreadKey: `gmail:${message.threadId}`,
        receivedAt: message.internalDate === null ? now : new Date(Number(message.internalDate)),
      };
    } catch (error) {
      // Deleted between the notification and now, or too large: skip it.
      if (error instanceof MailProviderError && error.status === 404) continue;
      if (error instanceof AppError && error.code === "validation_failed") {
        count(outcomes, "unreadable");
        continue;
      }
      throw error;
    }
    count(outcomes, await processEmail(deps, context, fetched));
  }
  await saveState(deps, target, {
    gmail: { historyId: cursor, watchExpiresAt: loaded.state.gmail?.watchExpiresAt ?? null },
    lastSyncAt: now.toISOString(),
    lastSyncError: null,
  });
  return { fetched: refs.length, more: !exhausted, outcomes, stopped: null };
}

async function graphBatch(
  deps: EmailServerDeps,
  tokens: AccessTokens,
  target: SyncTarget,
  loaded: LoadedConnection & { config: MicrosoftConfig },
  context: ProcessContext,
): Promise<BatchResult> {
  const now = (deps.clock ?? (() => new Date()))();
  const scope = deps.db.forBusiness(target.businessId, { agencyId: target.agencyId });
  const token = await scope.run((ctx) => tokens.inScope(ctx, target.connectionId, "microsoft"));
  const outcomes: Partial<Record<ProcessOutcome, number>> = {};
  const links: Record<string, string> = { ...(loaded.state.microsoft?.deltaLinks ?? {}) };
  const since = loaded.connectedAt ?? new Date(now.getTime() - RESYNC_WINDOW_MS);
  let fetchedCount = 0;
  let more = false;
  for (const folder of GRAPH_FOLDERS as readonly GraphFolder[]) {
    let link = links[folder] ?? null;
    for (;;) {
      if (fetchedCount >= BATCH_SIZE) {
        more = true;
        break;
      }
      let page;
      try {
        page =
          link === null
            ? await deps.graph.deltaStart(token, folder, since)
            : await deps.graph.deltaNext(token, link);
      } catch (error) {
        // An expired delta state (410, "resync required"): start again from the last sync.
        if (
          error instanceof MailProviderError &&
          (error.status === 410 || error.providerCode === "resyncRequired") &&
          link !== null
        ) {
          link = null;
          const lastSync = Date.parse(loaded.state.lastSyncAt ?? "");
          // At most a day back, like Gmail's recovery: old mail is never answered.
          page = await deps.graph.deltaStart(
            token,
            folder,
            new Date(
              Math.max(
                Number.isNaN(lastSync) ? since.getTime() : lastSync - 3600_000,
                now.getTime() - RESYNC_WINDOW_MS,
              ),
            ),
          );
        } else {
          throw error;
        }
      }
      for (const item of page.value) {
        if (item["@removed"] !== undefined) continue;
        let raw: Uint8Array;
        try {
          raw = await deps.graph.mime(token, item.id);
        } catch (error) {
          if (error instanceof MailProviderError && error.status === 404) continue;
          if (error instanceof AppError && error.code === "validation_failed") {
            count(outcomes, "unreadable");
            continue;
          }
          throw error;
        }
        fetchedCount += 1;
        count(
          outcomes,
          await processEmail(deps, context, {
            raw,
            folder: folder === "sentitems" ? "sent" : "inbox",
            providerMessageId: item.id,
            providerThreadKey: item.conversationId ? `graph:${item.conversationId}` : null,
            receivedAt: item.receivedDateTime ? new Date(item.receivedDateTime) : now,
          }),
        );
      }
      const next = page["@odata.nextLink"];
      const delta = page["@odata.deltaLink"];
      if (next !== undefined) {
        link = next;
        continue;
      }
      if (delta !== undefined) link = delta;
      break;
    }
    if (link !== null) links[folder] = link;
  }
  await saveState(deps, target, {
    microsoft: {
      subscriptionExpiresAt: loaded.state.microsoft?.subscriptionExpiresAt ?? null,
      deltaLinks: links,
    },
    lastSyncAt: now.toISOString(),
    lastSyncError: null,
  });
  return { fetched: fetchedCount, more, outcomes, stopped: null };
}

async function imapBatch(
  deps: EmailServerDeps,
  target: SyncTarget,
  loaded: LoadedConnection & { config: ImapConfig },
  context: ProcessContext,
): Promise<BatchResult> {
  const now = (deps.clock ?? (() => new Date()))();
  const credentials = await deps.db
    .forBusiness(target.businessId, { agencyId: target.agencyId })
    .run((ctx) => deps.db.secrets.channel.read(ctx, target.connectionId, PasswordCredentials));
  if (credentials === null) throw new ConfigError("The inbox's password is not stored.");
  const outcomes: Partial<Record<ProcessOutcome, number>> = {};
  const folders = { ...(loaded.state.imap?.folders ?? {}) };
  const paths: { path: string; folder: "inbox" | "sent" }[] = [{ path: "INBOX", folder: "inbox" }];
  if (loaded.config.sentFolder !== null)
    paths.push({ path: loaded.config.sentFolder, folder: "sent" });
  let fetchedCount = 0;
  let more = false;
  const session = await openImap(
    loaded.config.imap,
    credentials.imapPassword,
    deps.mailPolicy ?? DEFAULT_MAIL_POLICY,
  );
  try {
    for (const { path, folder } of paths) {
      let box: { uidValidity: string; uidNext: number };
      try {
        box = await session.open(path);
      } catch (error) {
        if (folder === "sent") continue; // a renamed Sent folder must not stop the inbox
        throw error;
      }
      const cursor = folders[path];
      if (cursor?.uidValidity !== box.uidValidity) {
        // New folder, or the server renumbered it (UIDVALIDITY changed): start from now.
        folders[path] = { uidValidity: box.uidValidity, lastUid: Math.max(0, box.uidNext - 1) };
        if (cursor !== undefined) {
          deps.logger.warn("email.imap_uidvalidity_changed", {
            businessId: target.businessId,
            connectionId: target.connectionId,
          });
        }
        continue;
      }
      const batch = await session.fetchAfter(cursor.lastUid, BATCH_SIZE);
      let lastUid = cursor.lastUid;
      for (const message of batch) {
        lastUid = Math.max(lastUid, message.uid);
        fetchedCount += 1;
        if (message.source === null) {
          count(outcomes, "unreadable");
          continue;
        }
        count(
          outcomes,
          await processEmail(deps, context, {
            raw: message.source,
            folder,
            providerMessageId: `${box.uidValidity}:${message.uid}`,
            providerThreadKey: null,
            receivedAt: now,
          }),
        );
      }
      folders[path] = { uidValidity: box.uidValidity, lastUid };
      if (batch.length >= BATCH_SIZE) more = true;
    }
  } finally {
    await session.close();
  }
  await saveState(deps, target, {
    imap: { folders },
    lastSyncAt: now.toISOString(),
    lastSyncError: null,
  });
  return { fetched: fetchedCount, more, outcomes, stopped: null };
}

/**
 * Reads one batch of new mail of one inbox and hands it to the pipeline. A mailbox that
 * refuses our access marks the connection for reconnecting and stops; other failures are
 * thrown so the job retries.
 */
export async function syncBatch(
  deps: EmailServerDeps,
  tokens: AccessTokens,
  target: SyncTarget,
): Promise<BatchResult> {
  const loaded = await load(deps, target);
  if (loaded === null) return { fetched: 0, more: false, outcomes: {}, stopped: "not_found" };
  if (loaded.status !== "active" && loaded.status !== "error" && loaded.status !== "pending") {
    return { fetched: 0, more: false, outcomes: {}, stopped: `connection_${loaded.status}` };
  }
  const context: ProcessContext = {
    tenant: loaded.tenant,
    connectionId: target.connectionId,
    config: loaded.config,
    settings: loaded.settings,
    logger: deps.logger,
  };
  try {
    const result =
      loaded.config.provider === "gmail"
        ? await gmailBatch(deps, tokens, target, { ...loaded, config: loaded.config }, context)
        : loaded.config.provider === "microsoft"
          ? await graphBatch(deps, tokens, target, { ...loaded, config: loaded.config }, context)
          : await imapBatch(deps, target, { ...loaded, config: loaded.config }, context);
    if (loaded.status === "error") {
      // The mailbox answers again: the connection is healthy.
      await deps.db
        .forBusiness(target.businessId, { agencyId: target.agencyId })
        .run(async (ctx) => {
          await ctx.tx
            .update(channelConnections)
            .set({ status: "active", lastError: null, lastErrorAt: null })
            .where(eq(channelConnections.id, target.connectionId));
        });
    }
    return result;
  } catch (error) {
    const authFailed =
      (error instanceof MailProviderError || error instanceof MailServerError) && error.authFailed;
    if (authFailed) {
      await markReconnectNeeded(
        deps,
        target.businessId,
        target.connectionId,
        error instanceof Error ? error.message : "auth",
      );
      return { fetched: 0, more: false, outcomes: {}, stopped: "auth_failed" };
    }
    await saveState(deps, target, {
      lastSyncError: (error instanceof Error ? error.message : "sync failed").slice(0, 300),
    });
    throw error;
  }
}
