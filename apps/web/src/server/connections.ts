import { z } from "zod";

import {
  ensureWidgetConnection,
  rotateWidgetKey,
  setWidgetEnabled,
} from "@repo/channel-widget/server";
import type { MetaPagesService } from "@repo/channel-messenger-instagram/server";
import type { EmailConnectionService } from "@repo/channel-email/server";
import {
  type ConnectionService as WhatsAppService,
  SUGGESTED_TEMPLATES,
} from "@repo/channel-whatsapp/server";
import {
  ChannelConnectionId,
  IntegrationConnectionId,
  LeadId,
  TenantAccessError,
} from "@repo/core";
import type { BusinessTenant, Database } from "@repo/db";
import { CRM_PROVIDERS, type IntegrationService } from "@repo/integrations";
import type { SchedulingConnectionService } from "@repo/scheduling";

import { actionBusiness } from "@/server/admin";
import { ActionError } from "@/server/admin/result";
import type { SessionAccess } from "@/server/auth";

/*
 * The connection pages' server actions (C16): the website chat, WhatsApp, Messenger and
 * Instagram, email, calendars and Calendly, CRMs and webhooks. Agency staff only: each action
 * looks the business up again as the signed-in person (`actionBusiness`, row-level security)
 * and refuses client users, then calls the owning chunk's service in that business's system
 * scope, where a connection id of another business is simply not found. The services never
 * return a token, password or key; a webhook signing secret is revealed only by
 * `revealWebhookSecret`, which the integration service allows to agency admins alone and
 * audits.
 *
 * Flows that prove control of an account (Embedded Signup, Facebook Login, OAuth, an IMAP
 * login, a Calendly token, a CRM key) go through the routes C9 to C14 built, which apply the
 * same checks; the pages call them with `fetch`.
 */

export interface ConnectionDeps {
  readonly db: Database;
  readonly whatsapp: WhatsAppService | null;
  readonly metaPages: MetaPagesService | null;
  readonly email: EmailConnectionService;
  readonly scheduling: SchedulingConnectionService;
  readonly integrations: IntegrationService;
}

const BusinessRef = z.strictObject({ businessId: z.uuid() });
const WidgetEnabled = z.strictObject({ businessId: z.uuid(), enabled: z.boolean() });
const ChannelRef = z.strictObject({ businessId: z.uuid(), connectionId: ChannelConnectionId });
const TemplateRef = z.strictObject({
  businessId: z.uuid(),
  connectionId: ChannelConnectionId,
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
});
const IntegrationRef = z.strictObject({
  businessId: z.uuid(),
  connectionId: IntegrationConnectionId,
});
const CalendarsInput = z.strictObject({
  businessId: z.uuid(),
  connectionId: IntegrationConnectionId,
  calendarIds: z.array(z.string().min(1).max(500)).min(1).max(10),
  bookingCalendarId: z.string().min(1).max(500),
});
const ConfigInput = z.strictObject({
  businessId: z.uuid(),
  connectionId: IntegrationConnectionId,
  config: z.record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
  ),
});
const DeliveryRef = z.strictObject({ businessId: z.uuid(), deliveryId: z.uuid() });
const PreviewInput = z.strictObject({
  businessId: z.uuid(),
  provider: z.enum(CRM_PROVIDERS),
  leadId: LeadId,
});
const WebhookRef = z.strictObject({
  businessId: z.uuid(),
  scope: z.enum(["business", "agency"]),
  name: z.string().min(1).max(100),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ActionError("That request was not valid. Reload the page.");
  return parsed.data;
}

function notConfigured(what: string): ActionError {
  return new ActionError(`${what} is not set up on this deployment.`);
}

export function createConnectionActions(deps: ConnectionDeps) {
  /** The business of the input, for agency staff only. */
  async function staffTenant(session: SessionAccess, businessId: string): Promise<BusinessTenant> {
    return (await actionBusiness(session, businessId)).tenant;
  }
  const scope = (tenant: BusinessTenant) =>
    deps.db.forBusiness(tenant.businessId, { agencyId: tenant.agencyId });
  const actor = (session: SessionAccess) => ({
    type: "user" as const,
    userId: session.user.id,
    label: session.user.email,
  });

  return {
    // --- website chat (C8) ---------------------------------------------------------------
    async widgetSetUp(session: SessionAccess, input: unknown): Promise<string> {
      const tenant = await staffTenant(session, parse(BusinessRef, input).businessId);
      await scope(tenant).run((ctx) => ensureWidgetConnection(ctx, { actor: actor(session) }));
      return "The website chat is set up. Paste the snippet into the website.";
    },
    async widgetRotate(session: SessionAccess, input: unknown): Promise<string> {
      const tenant = await staffTenant(session, parse(BusinessRef, input).businessId);
      await scope(tenant).run((ctx) => rotateWidgetKey(ctx, { actor: actor(session) }));
      return "New key made. Replace the snippet on the website: the old one has stopped working.";
    },
    async widgetEnable(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(WidgetEnabled, input);
      const tenant = await staffTenant(session, parsed.businessId);
      await scope(tenant).run((ctx) =>
        setWidgetEnabled(ctx, { enabled: parsed.enabled, actor: actor(session) }),
      );
      return parsed.enabled ? "The website chat is on." : "The website chat is off.";
    },

    // --- WhatsApp (C9) --------------------------------------------------------------------
    async whatsappDisconnect(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(ChannelRef, input);
      const tenant = await staffTenant(session, parsed.businessId);
      if (deps.whatsapp === null) throw notConfigured("WhatsApp");
      await deps.whatsapp.disconnect(tenant, parsed.connectionId);
      return "The number is disconnected: no more messages are read or sent.";
    },
    async whatsappSyncTemplates(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(ChannelRef, input);
      const tenant = await staffTenant(session, parsed.businessId);
      if (deps.whatsapp === null) throw notConfigured("WhatsApp");
      const { synced } = await deps.whatsapp.templates.sync(tenant, parsed.connectionId);
      return `${synced} template${synced === 1 ? "" : "s"} read from Meta.`;
    },
    async whatsappAddSuggestedTemplate(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(TemplateRef, input);
      const tenant = await staffTenant(session, parsed.businessId);
      if (deps.whatsapp === null) throw notConfigured("WhatsApp");
      const suggestion = SUGGESTED_TEMPLATES.find((item) => item.name === parsed.name);
      if (suggestion === undefined) throw new ActionError("That template is not one we suggest.");
      await deps.whatsapp.templates.create(tenant, {
        connectionId: parsed.connectionId,
        name: suggestion.name,
        category: suggestion.category,
        body: suggestion.body,
        purpose: suggestion.purpose,
      });
      return "Template sent to Meta for review.";
    },

    // --- Messenger and Instagram (C10) ----------------------------------------------------
    async metaDisconnect(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(ChannelRef, input);
      const tenant = await staffTenant(session, parsed.businessId);
      if (deps.metaPages === null) throw notConfigured("Messenger and Instagram");
      await deps.metaPages.disconnect(tenant, parsed.connectionId);
      return "Disconnected.";
    },

    // --- email (C11) ----------------------------------------------------------------------
    async emailSync(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(ChannelRef, input);
      const tenant = await staffTenant(session, parsed.businessId);
      await deps.email.syncNow(tenant, parsed.connectionId);
      return "The inbox is being read now.";
    },
    async emailDisconnect(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(ChannelRef, input);
      const tenant = await staffTenant(session, parsed.businessId);
      await deps.email.disconnect(tenant, parsed.connectionId);
      return "The inbox is disconnected and its credentials deleted.";
    },

    // --- calendars and Calendly (C12) -----------------------------------------------------
    async calendarList(
      session: SessionAccess,
      input: unknown,
    ): Promise<
      readonly { readonly id: string; readonly name: string; readonly primary: boolean }[]
    > {
      const parsed = parse(IntegrationRef, input);
      const tenant = await staffTenant(session, parsed.businessId);
      const calendars = await deps.scheduling.listCalendars(tenant, parsed.connectionId);
      return calendars.map((calendar) => ({
        id: calendar.id,
        name: calendar.name,
        primary: calendar.primary,
      }));
    },
    async calendarSet(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(CalendarsInput, input);
      const tenant = await staffTenant(session, parsed.businessId);
      if (!parsed.calendarIds.includes(parsed.bookingCalendarId)) {
        throw new ActionError(
          "The calendar meetings go into must be one of the checked calendars.",
        );
      }
      await deps.scheduling.setCalendars(tenant, session.user.id, parsed.connectionId, {
        calendarIds: parsed.calendarIds,
        bookingCalendarId: parsed.bookingCalendarId,
      });
      return "Calendars saved.";
    },
    async calendarDisconnect(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(IntegrationRef, input);
      const tenant = await staffTenant(session, parsed.businessId);
      await deps.scheduling.disconnect(tenant, session.user.id, parsed.connectionId);
      return "Disconnected.";
    },

    // --- CRMs and webhooks (C14) ----------------------------------------------------------
    async crmUpdateConfig(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(ConfigInput, input);
      const tenant = await staffTenant(session, parsed.businessId);
      await deps.integrations.updateConfig(
        tenant,
        session.user.id,
        parsed.connectionId,
        parsed.config,
      );
      return "Saved.";
    },
    async crmTest(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(IntegrationRef, input);
      const tenant = await staffTenant(session, parsed.businessId);
      const result = await deps.integrations.test(tenant, session.user.id, parsed.connectionId);
      if (!result.ok) throw new ActionError(result.message);
      return result.message;
    },
    async crmDisconnect(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(IntegrationRef, input);
      const tenant = await staffTenant(session, parsed.businessId);
      await deps.integrations.disconnect(tenant, session.user.id, parsed.connectionId);
      return "Disconnected. Leads are no longer sent to it.";
    },
    async deliveryRetry(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(DeliveryRef, input);
      const tenant = await staffTenant(session, parsed.businessId);
      await deps.integrations.retry(tenant, session.user.id, parsed.deliveryId);
      return "Queued again.";
    },
    async mappingPreview(
      session: SessionAccess,
      input: unknown,
    ): Promise<{
      readonly fields: Readonly<Record<string, string>>;
      readonly ignored: readonly string[];
    }> {
      const parsed = parse(PreviewInput, input);
      const tenant = await staffTenant(session, parsed.businessId);
      const preview = await deps.integrations.previewMapping(
        tenant,
        parsed.provider,
        parsed.leadId,
      );
      // Values as text: what the CRM would receive, shown to staff of this business.
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(preview.fields)) {
        fields[key] = typeof value === "string" ? value : JSON.stringify(value);
      }
      return { fields, ignored: preview.ignored };
    },
    async webhookTest(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(WebhookRef, input);
      const tenant = await staffTenant(session, parsed.businessId);
      const result = await deps.integrations.testWebhook(
        tenant,
        session.user.id,
        parsed.scope,
        parsed.name,
      );
      if (!result.ok) throw new ActionError(result.message);
      return result.message;
    },
    /** Agency admins only (the service checks the access and audits every reveal). */
    async webhookReveal(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(WebhookRef, input);
      const tenant = await staffTenant(session, parsed.businessId);
      try {
        return parsed.scope === "agency"
          ? await deps.integrations.revealAgencyWebhookSecret(
              tenant.agencyId,
              session.access,
              parsed.name,
            )
          : await deps.integrations.revealWebhookSecret(tenant, session.access, parsed.name);
      } catch (error) {
        if (error instanceof TenantAccessError) {
          throw new ActionError("Only an agency admin can see a signing secret.");
        }
        throw error;
      }
    },
    async webhookRotate(session: SessionAccess, input: unknown): Promise<string> {
      const parsed = parse(WebhookRef, input);
      const tenant = await staffTenant(session, parsed.businessId);
      try {
        return parsed.scope === "agency"
          ? await deps.integrations.rotateAgencyWebhookSecret(
              tenant.agencyId,
              session.access,
              parsed.name,
            )
          : await deps.integrations.rotateWebhookSecret(tenant, session.access, parsed.name);
      } catch (error) {
        if (error instanceof TenantAccessError) {
          throw new ActionError("Only an agency admin can replace a signing secret.");
        }
        throw error;
      }
    },
  };
}

export type ConnectionActions = ReturnType<typeof createConnectionActions>;
