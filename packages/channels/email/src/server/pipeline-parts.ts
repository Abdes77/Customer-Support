import type { ChannelId, ConversationId } from "@repo/core";
import {
  and,
  type BusinessContext,
  businesses,
  channelConnections,
  contacts,
  conversations,
  count,
  desc,
  eq,
  gt,
  gte,
  messages,
  ne,
  notInArray,
  sql,
  usageCounters,
} from "@repo/db";
import { type AppResolvedSettings, renderTemplate } from "@repo/settings";
import { loadSettings } from "@repo/settings/server";

import { domainMatches } from "../addresses";
import { composeEmail } from "../compose";
import { EmailConnectionConfig } from "../config";

/*
 * The email parts the pipeline calls through its extension points (registered by apps/web):
 * the composer (send step: the stored reply becomes the business's email), the send throttle
 * (send step: emails per inbox per hour and per day) and the channel guard (reply turn:
 * automatic mail, threads the team is in, the daily reply limit per thread).
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const EmailAddressList = (value: unknown): { address: string; name: string | null }[] =>
  Array.isArray(value)
    ? value
        .map(asRecord)
        .filter((item) => typeof item["address"] === "string")
        .map((item) => ({
          address: String(item["address"]).toLowerCase(),
          name: typeof item["name"] === "string" ? item["name"] : null,
        }))
    : [];

/** What the composer receives from the send step (matches the pipeline's `OutboundComposer`). */
export interface ComposeRequest {
  readonly messageId: string;
  readonly conversationId: ConversationId;
  readonly author: "bot" | "human_agent";
  readonly text: string;
  readonly subject: string;
  readonly now: Date;
}

/**
 * The business's email for a stored reply: greeting, sign-off and signature from the
 * settings, the customer's last message quoted, everyone on it copied only when
 * `channels.email.reply_to` is "all" (default "sender"; never the inbox itself), the sender name of
 * `channels.email.from_name`.
 */
export function createEmailComposer() {
  return {
    channel: "email" as ChannelId,
    async compose(ctx: BusinessContext, input: ComposeRequest) {
      const settings = await loadSettings(ctx, ctx.tenant);
      const values = settings.values;
      const [business] = await ctx.tx
        .select({
          name: businesses.name,
          phone: businesses.phone,
          website: businesses.websiteUrl,
          timezone: businesses.timezone,
        })
        .from(businesses)
        .where(eq(businesses.id, ctx.tenant.businessId))
        .limit(1);
      const [conversation] = await ctx.tx
        .select({
          contactId: conversations.contactId,
          connectionId: conversations.channelConnectionId,
        })
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .limit(1);
      const [contact] =
        conversation === undefined
          ? []
          : await ctx.tx
              .select({ name: contacts.displayName })
              .from(contacts)
              .where(eq(contacts.id, conversation.contactId))
              .limit(1);
      const [connection] =
        conversation === undefined
          ? []
          : await ctx.tx
              .select({ config: channelConnections.config })
              .from(channelConnections)
              .where(eq(channelConnections.id, conversation.connectionId))
              .limit(1);
      const inbox = EmailConnectionConfig.safeParse(connection?.config).data?.address ?? null;
      const [lastInbound] = await ctx.tx
        .select({
          text: messages.text,
          payload: messages.payload,
          sentAt: messages.sentAt,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(eq(messages.conversationId, input.conversationId), eq(messages.direction, "inbound")),
        )
        .orderBy(desc(messages.sequence))
        .limit(1);

      const templateValues = {
        business_name: business?.name ?? null,
        business_phone: business?.phone ?? null,
        business_website: business?.website ?? null,
        bot_name: values["persona.bot_name"],
      };
      const fill = (template: string) =>
        renderTemplate(template, templateValues)
          .replace(/\{\{[a-z_]+\}\}/g, "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1] !== ""))
          .join("\n")
          .trim();

      // The bot never quotes the very first email of an address (C17: reflection). From is
      // not authenticated: whoever forges someone's address would otherwise get their own
      // text delivered to that person from the business's inbox. Once the address has written
      // again (in reply to us, so from the real mailbox), quoting is safe.
      const [written] =
        conversation === undefined || input.author !== "bot"
          ? []
          : await ctx.tx
              .select({ total: sql<number>`count(*)::int` })
              .from(messages)
              .innerJoin(conversations, eq(conversations.id, messages.conversationId))
              .where(
                and(
                  eq(conversations.contactId, conversation.contactId),
                  eq(messages.direction, "inbound"),
                ),
              );
      const firstContact = written !== undefined && written.total <= 1;
      const envelope = asRecord(asRecord(lastInbound?.payload)["email"]);
      const from = asRecord(envelope["from"]);
      const quote =
        values["channels.email.quote_original"] &&
        !firstContact &&
        lastInbound !== undefined &&
        (lastInbound.text ?? "").trim().length > 0
          ? {
              text: lastInbound.text ?? "",
              fromName: typeof from["name"] === "string" ? from["name"] : null,
              fromAddress: typeof from["address"] === "string" ? from["address"] : "",
              sentAt: lastInbound.sentAt ?? lastInbound.createdAt,
            }
          : null;
      const composed = composeEmail({
        body: input.text,
        author: input.author,
        greeting: values["channels.email.greeting"],
        signOff: values["channels.email.sign_off"],
        signature: fill(values["channels.email.signature"]),
        botName: values["persona.bot_name"],
        contactName: contact?.name ?? null,
        quote: quote !== null && quote.fromAddress.length > 0 ? quote : null,
        timeZone: business?.timezone ?? "America/Chicago",
      });

      // Reply to all: everyone the customer's last email went to, except the inbox (and the
      // customer, whom the adapter addresses directly).
      const copied =
        values["channels.email.reply_to"] === "all"
          ? [...EmailAddressList(envelope["to"]), ...EmailAddressList(envelope["cc"])].filter(
              (item, index, list) =>
                item.address !== inbox &&
                list.findIndex((other) => other.address === item.address) === index,
            )
          : [];
      const fromName =
        input.author === "bot"
          ? fill(values["channels.email.from_name"])
          : (business?.name ?? null);
      return {
        kind: "email" as const,
        subject: input.subject,
        text: composed.text,
        html: composed.html,
        cc: copied.slice(0, 20),
        fromName: fromName === null || fromName.length === 0 ? null : fromName,
      };
    },
  };
}

/**
 * Counts one send in a fixed window when the window is below `limit` (or always, when
 * `limit` is null) and says whether it was counted. One statement, so concurrent sends cannot
 * both slip under the limit, and refused attempts are not counted.
 */
async function take(
  ctx: BusinessContext,
  input: {
    readonly subject: string;
    readonly windowSeconds: number;
    readonly limit: number | null;
    readonly now: Date;
  },
): Promise<{ readonly ok: boolean; readonly retryAfterSeconds: number }> {
  const windowMs = input.windowSeconds * 1000;
  const start = Math.floor(input.now.getTime() / windowMs) * windowMs;
  const rows = await ctx.tx
    .insert(usageCounters)
    .values({
      ...ctx.tenant,
      metric: "email_sends",
      subject: input.subject,
      windowStart: new Date(start),
      windowSeconds: input.windowSeconds,
      value: 1,
    })
    .onConflictDoUpdate({
      target: [
        usageCounters.businessId,
        usageCounters.metric,
        usageCounters.subject,
        usageCounters.windowStart,
        usageCounters.windowSeconds,
      ],
      set: { value: sql`${usageCounters.value} + 1`, updatedAt: input.now },
      ...(input.limit === null ? {} : { setWhere: sql`${usageCounters.value} < ${input.limit}` }),
    })
    .returning({ value: usageCounters.value });
  return {
    ok: rows.length > 0,
    retryAfterSeconds: Math.max(1, Math.ceil((start + windowMs - input.now.getTime()) / 1000)),
  };
}

/**
 * Per-inbox sending limits (`channels.email.max_sends_per_hour`, `…_per_day`). The bot's
 * emails wait for the next window; a person's reply always goes out, and is counted.
 */
export function createEmailSendThrottle() {
  return {
    channel: "email" as ChannelId,
    async acquire(
      ctx: BusinessContext,
      input: {
        readonly connectionId: string;
        readonly messageId: string;
        readonly author: "bot" | "human_agent";
        readonly now: Date;
      },
    ) {
      const settings = await loadSettings(ctx, ctx.tenant);
      const subject = `connection:${input.connectionId}`;
      const bot = input.author === "bot";
      const hour = await take(ctx, {
        subject,
        windowSeconds: 3600,
        limit: bot ? settings.values["channels.email.max_sends_per_hour"] : null,
        now: input.now,
      });
      if (!hour.ok)
        return {
          ok: false as const,
          retryAfterSeconds: hour.retryAfterSeconds,
          reason: "hourly_limit",
        };
      const day = await take(ctx, {
        subject,
        windowSeconds: 86_400,
        limit: bot ? settings.values["channels.email.max_sends_per_day"] : null,
        now: input.now,
      });
      if (!day.ok) {
        // Not sent after all: give back the hour's count taken above.
        const hourStart = new Date(Math.floor(input.now.getTime() / 3_600_000) * 3_600_000);
        await ctx.tx
          .update(usageCounters)
          .set({ value: sql`greatest(${usageCounters.value} - 1, 0)`, updatedAt: input.now })
          .where(
            and(
              eq(usageCounters.businessId, ctx.tenant.businessId),
              eq(usageCounters.metric, "email_sends"),
              eq(usageCounters.subject, subject),
              eq(usageCounters.windowStart, hourStart),
              eq(usageCounters.windowSeconds, 3600),
            ),
          );
        return {
          ok: false as const,
          retryAfterSeconds: day.retryAfterSeconds,
          reason: "daily_limit",
        };
      }
      return { ok: true as const };
    },
  };
}

/** What the guard reads of a turn (a subset of the pipeline's `TurnFacts`). */
export interface EmailTurnFacts {
  readonly conversationId: ConversationId;
  readonly channel: ChannelId;
  readonly trigger: string;
  readonly settings: AppResolvedSettings;
  readonly now: Date;
}

/**
 * Keeps the bot quiet in an email conversation (the pipeline's `TurnGuard`, registered by
 * apps/web):
 * - `automatic_mail`: every message waiting for an answer is automatic (an out-of-office
 *   reply or a list mail inside the thread): answering it would start a mail loop;
 * - `staffed_thread`: someone at the business wrote in this thread from the mailbox and
 *   `channels.email.skip_staffed_threads` is on;
 * - `thread_daily_limit`: the bot already sent `channels.email.max_replies_per_thread_per_day`
 *   emails in this thread in the last 24 hours (two auto-responders answering each other);
 * - `contact_daily_limit`: twice that many to this contact from this inbox, across threads
 *   (a correspondent whose every email starts a new thread);
 * - `internal_sender`: the customer's address belongs to the business (defence in depth;
 *   such mail is not stored as a customer's).
 */
export const emailChannelGuard = {
  name: "email_channel",
  async check(ctx: BusinessContext, facts: EmailTurnFacts): Promise<string | null> {
    if (facts.channel !== "email") return null;
    const values = facts.settings.values;
    const [conversation] = await ctx.tx
      .select({
        handled: conversations.handledThroughSeq,
        contactId: conversations.contactId,
        connectionId: conversations.channelConnectionId,
      })
      .from(conversations)
      .where(eq(conversations.id, facts.conversationId))
      .limit(1);
    if (conversation === undefined) return null;

    if (facts.trigger === "inbound_message") {
      const pending = await ctx.tx
        .select({ payload: messages.payload })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, facts.conversationId),
            eq(messages.direction, "inbound"),
            ne(messages.kind, "reaction"),
            gt(messages.sequence, conversation.handled),
          ),
        );
      if (
        pending.length > 0 &&
        pending.every(
          (row) => typeof asRecord(asRecord(row.payload)["metadata"])["automated"] === "string",
        )
      ) {
        return "automatic_mail";
      }
    }

    const [contact] = await ctx.tx
      .select({ email: contacts.email })
      .from(contacts)
      .where(eq(contacts.id, conversation.contactId))
      .limit(1);
    const domain = contact?.email?.split("@")[1] ?? null;
    if (domain !== null && domainMatches(domain, values["channels.email.internal_domains"])) {
      return "internal_sender";
    }

    if (values["channels.email.skip_staffed_threads"]) {
      const [staffed] = await ctx.tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, facts.conversationId),
            eq(messages.direction, "outbound"),
            eq(messages.author, "human_agent"),
            sql`coalesce(${messages.payload} ->> 'source', '') = 'provider_inbox'`,
          ),
        )
        .limit(1);
      if (staffed !== undefined) return "staffed_thread";
    }

    const [sent] = await ctx.tx
      .select({ total: count() })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, facts.conversationId),
          eq(messages.direction, "outbound"),
          eq(messages.author, "bot"),
          notInArray(messages.status, ["superseded", "failed"]),
          gte(messages.createdAt, new Date(facts.now.getTime() - 24 * 3600_000)),
        ),
      );
    const limit = values["channels.email.max_replies_per_thread_per_day"];
    if ((sent?.total ?? 0) >= limit) return "thread_daily_limit";

    // A correspondent that never threads (no In-Reply-To or References: an auto-responder
    // without RFC 3834 headers) starts a new conversation with every email, so the limit per
    // thread alone would never stop two bots. The same contact on the same inbox gets at most
    // twice that many of the bot's emails in 24 hours, across all its threads (C11 review).
    const [acrossThreads] = await ctx.tx
      .select({ total: count() })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(conversations.contactId, conversation.contactId),
          eq(conversations.channelConnectionId, conversation.connectionId),
          eq(messages.direction, "outbound"),
          eq(messages.author, "bot"),
          notInArray(messages.status, ["superseded", "failed"]),
          gte(messages.createdAt, new Date(facts.now.getTime() - 24 * 3600_000)),
        ),
      );
    if ((acrossThreads?.total ?? 0) >= limit * 2) return "contact_daily_limit";
    return null;
  },
};
