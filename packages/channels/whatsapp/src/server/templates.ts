import { z } from "zod";

import { AppError, type ChannelConnectionId, NotFoundError, ValidationError } from "@repo/core";
import {
  and,
  type BusinessContext,
  type BusinessTenant,
  channelConnections,
  eq,
  messageTemplates,
  type MessageTemplateStatus,
} from "@repo/db";

import { GraphId, WhatsAppConfig, WhatsAppCredentials } from "../credentials";
import { normalizeLanguage } from "../webhook";
import type { WhatsAppServerDeps } from "./deps";

/*
 * Message templates: the only messages WhatsApp lets a business send once the 24-hour
 * customer-service window has closed. They are created at Meta (reviewed, usually within
 * minutes), synced back, and kept current by `message_template_status_update` webhooks.
 *
 * Templates created here use named parameters from a fixed list, so the pipeline can fill
 * them from the conversation without guessing (DECISIONS). A template made elsewhere (in
 * WhatsApp Manager) is synced too and usable when its parameters are from the same list.
 */

/** The parameters a template may use, and the example Meta's review sees for each. */
export const WHATSAPP_TEMPLATE_VARIABLES = {
  first_name: { label: "The customer's first name", example: "Maria" },
  contact_name: { label: "The customer's name", example: "Maria Lopez" },
  business_name: { label: "The business's name", example: "Summit Roofing" },
  bot_name: { label: "The bot's name", example: "Alex" },
  business_phone: { label: "The business's phone number", example: "(612) 555-0142" },
  business_website: { label: "The business's website", example: "summitroofing.com" },
} as const;
export type WhatsAppTemplateVariable = keyof typeof WHATSAPP_TEMPLATE_VARIABLES;

const VARIABLE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** The parameter names (or positions) a body uses, in order of first appearance. */
export function templateVariables(body: string): string[] {
  const seen: string[] = [];
  for (const match of body.matchAll(VARIABLE)) {
    const name = match[1]!;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

export function isKnownVariable(name: string): name is WhatsAppTemplateVariable {
  return Object.hasOwn(WHATSAPP_TEMPLATE_VARIABLES, name);
}

/** Fills `{{name}}` placeholders; unknown ones stay as they are. */
export function renderTemplateBody(body: string, values: Readonly<Record<string, string>>): string {
  return body.replace(VARIABLE, (whole, name: string) => values[name] ?? whole);
}

/** The body text of a template's components as Meta stores them. */
export function bodyOf(components: readonly unknown[]): string | null {
  for (const component of components) {
    if (component === null || typeof component !== "object") continue;
    const record = component as Record<string, unknown>;
    if (String(record["type"]).toUpperCase() === "BODY" && typeof record["text"] === "string") {
      return record["text"];
    }
  }
  return null;
}

/** Meta's template states (webhook `event` or API `status`) as ours. Null: leave as is. */
export function templateStatusOf(meta: string): MessageTemplateStatus | null {
  switch (meta.toUpperCase()) {
    // A flagged template can still be sent; a pause follows if quality stays low.
    case "APPROVED":
    case "REINSTATED":
    case "UNARCHIVED":
    case "FLAGGED":
      return "approved";
    case "PENDING":
    case "IN_APPEAL":
      return "pending";
    case "REJECTED":
      return "rejected";
    case "PAUSED":
      return "paused";
    case "DISABLED":
    case "DELETED":
    case "PENDING_DELETION":
    case "ARCHIVED":
    case "LOCKED":
    case "LIMIT_EXCEEDED":
      return "disabled";
    default:
      return null;
  }
}

export const TEMPLATE_PURPOSES = ["follow_up", "staff_reply", "reminder"] as const;

export const CreateTemplateInput = z.object({
  connectionId: z.uuid(),
  name: z
    .string()
    .regex(/^[a-z0-9_]{1,512}$/, "Use lowercase letters, digits and underscores only."),
  language: z
    .string()
    .regex(/^[a-z]{2,3}(_[A-Z]{2})?$/)
    .default("en_US"),
  category: z.enum(["utility", "marketing"]),
  body: z.string().trim().min(1).max(1024),
  purpose: z.enum(TEMPLATE_PURPOSES).nullable().default(null),
});
export type CreateTemplateInput = z.input<typeof CreateTemplateInput>;

/** Templates ready to propose to a new business, one per purpose. */
export const SUGGESTED_TEMPLATES: readonly {
  readonly name: string;
  readonly purpose: (typeof TEMPLATE_PURPOSES)[number];
  readonly category: "utility";
  readonly body: string;
}[] = [
  {
    name: "follow_up_check_in",
    purpose: "follow_up",
    category: "utility",
    body: "Hi {{first_name}}, this is {{bot_name}} from {{business_name}} following up on your request. Reply here whenever you're ready and we'll pick up where we left off.",
  },
  {
    name: "team_reply_ready",
    purpose: "staff_reply",
    category: "utility",
    body: "Hi {{first_name}}, the team at {{business_name}} has an answer to your message. Reply to this message to see it and continue the conversation.",
  },
  {
    name: "appointment_reminder",
    purpose: "reminder",
    category: "utility",
    body: "Hi {{first_name}}, a reminder of your upcoming appointment with {{business_name}}. Reply here if you need to change it.",
  },
];

export interface TemplateView {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly category: string | null;
  readonly purpose: string | null;
  readonly status: MessageTemplateStatus;
  readonly body: string | null;
  readonly variables: readonly string[];
  /** All parameters are ones the pipeline can fill. */
  readonly usableAsFallback: boolean;
  readonly rejectionReason: string | null;
  readonly lastSyncedAt: string | null;
}

function viewOf(row: typeof messageTemplates.$inferSelect): TemplateView {
  const body = bodyOf(row.components);
  const variables = body === null ? [] : templateVariables(body);
  return {
    id: row.id,
    name: row.name,
    language: row.language,
    category: row.category,
    purpose: row.purpose,
    status: row.status,
    body,
    variables,
    usableAsFallback: body !== null && variables.every(isKnownVariable),
    rejectionReason: row.rejectionReason,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
  };
}

/** Loads a WhatsApp connection of this business with its token (inside the business scope). */
export async function loadWhatsAppConnection(
  ctx: BusinessContext,
  deps: Pick<WhatsAppServerDeps, "db">,
  connectionId: string,
): Promise<{
  readonly id: ChannelConnectionId;
  readonly config: WhatsAppConfig;
  readonly token: string;
}> {
  const [row] = await ctx.tx
    .select({ id: channelConnections.id, config: channelConnections.config })
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.id, connectionId as ChannelConnectionId),
        eq(channelConnections.channel, "whatsapp"),
      ),
    )
    .limit(1);
  if (row === undefined) throw new NotFoundError("WhatsApp connection not found.");
  const config = WhatsAppConfig.safeParse(row.config);
  if (!config.success) {
    throw new AppError("config_missing", "The WhatsApp connection is incomplete.", {
      retryable: false,
    });
  }
  const credentials = await deps.db.secrets.channel.read(ctx, row.id, WhatsAppCredentials);
  if (credentials === null) {
    throw new AppError("config_missing", "The WhatsApp number has no stored token.", {
      retryable: false,
    });
  }
  return { id: row.id, config: config.data, token: credentials.accessToken };
}

const MetaTemplate = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string(),
    language: z.string(),
    status: z.string(),
    category: z.string().optional(),
    components: z.array(z.unknown()).default([]),
    rejected_reason: z.string().optional(),
  })
  .passthrough();

const TemplatePage = z.object({
  data: z.array(z.unknown()),
  paging: z
    .object({
      cursors: z.object({ after: z.string().optional() }).partial().optional(),
      next: z.string().optional(),
    })
    .partial()
    .optional(),
});

const CreateResponse = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  status: z.string().optional(),
  category: z.string().optional(),
});

const MAX_SYNC_PAGES = 20;

export function createTemplateService(deps: WhatsAppServerDeps) {
  const clock = deps.clock ?? (() => new Date());
  const scope = (tenant: BusinessTenant) =>
    deps.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId });

  async function upsert(
    ctx: BusinessContext,
    connectionId: ChannelConnectionId,
    template: z.infer<typeof MetaTemplate>,
    now: Date,
  ): Promise<void> {
    const status = templateStatusOf(template.status) ?? "pending";
    const language = normalizeLanguage(template.language);
    await ctx.tx
      .insert(messageTemplates)
      .values({
        ...ctx.tenant,
        channelConnectionId: connectionId,
        name: template.name,
        language,
        category: template.category ?? null,
        status,
        externalTemplateId: template.id,
        components: template.components,
        rejectionReason:
          template.rejected_reason !== undefined && template.rejected_reason !== "NONE"
            ? template.rejected_reason
            : null,
        lastSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          messageTemplates.channelConnectionId,
          messageTemplates.name,
          messageTemplates.language,
        ],
        set: {
          category: template.category ?? null,
          status,
          externalTemplateId: template.id,
          components: template.components,
          rejectionReason:
            template.rejected_reason !== undefined && template.rejected_reason !== "NONE"
              ? template.rejected_reason
              : null,
          lastSyncedAt: now,
        },
      });
  }

  return {
    /** The templates of a connection, for the admin panel (C16). */
    async list(tenant: BusinessTenant, connectionId: string): Promise<TemplateView[]> {
      return scope(tenant).run(async (ctx) => {
        const rows = await ctx.tx
          .select()
          .from(messageTemplates)
          .where(eq(messageTemplates.channelConnectionId, connectionId as ChannelConnectionId))
          .orderBy(messageTemplates.name, messageTemplates.language);
        return rows.map(viewOf);
      });
    },

    /** Submits a template for review at Meta and stores it as pending. */
    async create(tenant: BusinessTenant, input: CreateTemplateInput): Promise<TemplateView> {
      const parsed = CreateTemplateInput.parse(input);
      const variables = templateVariables(parsed.body);
      const unknown = variables.filter((name) => !isKnownVariable(name));
      if (unknown.length > 0) {
        throw new ValidationError(
          `Templates may only use these parameters: ${Object.keys(WHATSAPP_TEMPLATE_VARIABLES).join(", ")}.`,
          { details: { unknown } },
        );
      }
      const connection = await scope(tenant).run((ctx) =>
        loadWhatsAppConnection(ctx, deps, parsed.connectionId),
      );
      const exists = await scope(tenant).run(async (ctx) => {
        const [row] = await ctx.tx
          .select({ id: messageTemplates.id })
          .from(messageTemplates)
          .where(
            and(
              eq(messageTemplates.channelConnectionId, connection.id),
              eq(messageTemplates.name, parsed.name),
              eq(messageTemplates.language, parsed.language),
            ),
          )
          .limit(1);
        return row !== undefined;
      });
      if (exists) {
        throw new AppError("conflict", "A template with this name and language exists.", {
          retryable: false,
        });
      }

      const components = [
        {
          type: "BODY",
          text: parsed.body,
          ...(variables.length === 0
            ? {}
            : {
                example: {
                  body_text_named_params: variables.map((name) => ({
                    param_name: name,
                    example: WHATSAPP_TEMPLATE_VARIABLES[name as WhatsAppTemplateVariable].example,
                  })),
                },
              }),
        },
      ];
      const created = await deps.graph.request(
        {
          method: "POST",
          path: `/${GraphId.parse(connection.config.businessAccountId)}/message_templates`,
          token: connection.token,
          json: {
            name: parsed.name,
            language: parsed.language,
            category: parsed.category,
            parameter_format: "named",
            components,
          },
        },
        CreateResponse,
      );
      return scope(tenant).run(async (ctx) => {
        const [row] = await ctx.tx
          .insert(messageTemplates)
          .values({
            ...ctx.tenant,
            channelConnectionId: connection.id,
            name: parsed.name,
            language: parsed.language,
            category: (created.category ?? parsed.category).toUpperCase(),
            purpose: parsed.purpose,
            status: templateStatusOf(created.status ?? "PENDING") ?? "pending",
            externalTemplateId: created.id,
            components,
            lastSyncedAt: clock(),
          })
          .returning();
        return viewOf(row!);
      });
    },

    /**
     * Reads every template of the number's WhatsApp Business Account and stores them. A
     * template no longer at Meta is marked disabled; drafts never submitted are left alone.
     */
    async sync(tenant: BusinessTenant, connectionId: string): Promise<{ readonly synced: number }> {
      const connection = await scope(tenant).run((ctx) =>
        loadWhatsAppConnection(ctx, deps, connectionId),
      );
      const waba = GraphId.parse(connection.config.businessAccountId);
      const templates: z.infer<typeof MetaTemplate>[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
        const result = await deps.graph.request(
          {
            method: "GET",
            path: `/${waba}/message_templates`,
            token: connection.token,
            query: {
              fields: "id,name,language,status,category,components,rejected_reason",
              limit: 100,
              ...(after === undefined ? {} : { after }),
            },
          },
          TemplatePage,
        );
        for (const item of result.data) {
          const template = MetaTemplate.safeParse(item);
          if (template.success) templates.push(template.data);
        }
        after = result.paging?.next === undefined ? undefined : result.paging.cursors?.after;
        if (after === undefined) break;
      }
      const now = clock();
      await scope(tenant).run(async (ctx) => {
        for (const template of templates) await upsert(ctx, connection.id, template, now);
        const present = new Set(
          templates.map(
            (template) => `${template.name}\u0000${normalizeLanguage(template.language)}`,
          ),
        );
        const local = await ctx.tx
          .select({
            id: messageTemplates.id,
            name: messageTemplates.name,
            language: messageTemplates.language,
            externalTemplateId: messageTemplates.externalTemplateId,
          })
          .from(messageTemplates)
          .where(eq(messageTemplates.channelConnectionId, connection.id));
        for (const row of local) {
          if (row.externalTemplateId === null) continue;
          if (present.has(`${row.name}\u0000${row.language}`)) continue;
          await ctx.tx
            .update(messageTemplates)
            .set({ status: "disabled", rejectionReason: "Deleted at Meta.", lastSyncedAt: now })
            .where(eq(messageTemplates.id, row.id));
        }
        await ctx.tx
          .update(channelConnections)
          .set({ state: { templatesSyncedAt: now.toISOString() } })
          .where(eq(channelConnections.id, connection.id));
      });
      return { synced: templates.length };
    },

    /** Deletes a template (every language of the name) at Meta and here. */
    async remove(tenant: BusinessTenant, connectionId: string, name: string): Promise<void> {
      if (!/^[a-z0-9_]{1,512}$/.test(name)) throw new ValidationError("Invalid template name.");
      const connection = await scope(tenant).run((ctx) =>
        loadWhatsAppConnection(ctx, deps, connectionId),
      );
      await deps.graph.request({
        method: "DELETE",
        path: `/${GraphId.parse(connection.config.businessAccountId)}/message_templates`,
        token: connection.token,
        query: { name },
      });
      await scope(tenant).run(async (ctx) => {
        await ctx.tx
          .delete(messageTemplates)
          .where(
            and(
              eq(messageTemplates.channelConnectionId, connection.id),
              eq(messageTemplates.name, name),
            ),
          );
      });
    },

    /**
     * A `message_template_status_update` webhook for one connection of the account. Returns
     * whether a stored template changed.
     */
    async applyStatus(
      ctx: BusinessContext,
      connectionId: ChannelConnectionId,
      update: {
        readonly templateId: string | null;
        readonly name: string;
        readonly language: string;
        readonly status: string;
        readonly reason: string | null;
      },
    ): Promise<boolean> {
      const status = templateStatusOf(update.status);
      if (status === null) return false;
      const changed = await ctx.tx
        .update(messageTemplates)
        .set({
          status,
          rejectionReason:
            status === "rejected" && update.reason !== null && update.reason !== "NONE"
              ? update.reason
              : null,
          ...(update.templateId === null ? {} : { externalTemplateId: update.templateId }),
          lastSyncedAt: clock(),
        })
        .where(
          and(
            eq(messageTemplates.channelConnectionId, connectionId),
            eq(messageTemplates.name, update.name),
            eq(messageTemplates.language, normalizeLanguage(update.language)),
          ),
        )
        .returning({ id: messageTemplates.id });
      return changed.length > 0;
    },
  };
}

export type TemplateService = ReturnType<typeof createTemplateService>;
