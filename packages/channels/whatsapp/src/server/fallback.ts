import type {
  WindowFallbackRequest,
  WindowFallbackResolver,
  WindowFallbackResult,
} from "@repo/core";
import { and, businesses, contacts, conversations, eq, messageTemplates } from "@repo/db";
import { loadSettings } from "@repo/settings/server";

import type { WhatsAppServerDeps } from "./deps";
import { bodyOf, isKnownVariable, renderTemplateBody, templateVariables } from "./templates";

/**
 * What replaces a free-form WhatsApp message once the 24-hour customer-service window has
 * closed (invariant I6): the approved template the business named for it, with its
 * parameters filled from the conversation. A bot message (a follow-up nudge, C13) uses
 * `channels.whatsapp.follow_up_template`; a person's reply from the inbox (C16) uses
 * `channels.whatsapp.staff_reply_template`. Without an approved, fillable template the
 * answer is "none" and the pipeline fails the message instead of sending it.
 */
export function createWhatsAppWindowFallback(
  deps: Pick<WhatsAppServerDeps, "db" | "logger">,
): WindowFallbackResolver {
  return {
    channel: "whatsapp",
    async resolve(request: WindowFallbackRequest): Promise<WindowFallbackResult> {
      return deps.db
        .forBusiness(request.businessId, { agencyId: request.agencyId })
        .run(async (ctx) => {
          const settings = await loadSettings(ctx, ctx.tenant, { logger: deps.logger });
          const values = settings.values;
          const name =
            request.author === "human_agent"
              ? values["channels.whatsapp.staff_reply_template"]
              : values["channels.whatsapp.follow_up_template"];
          if (name === null) return { kind: "none", reason: "no_template_configured" };
          const language = values["channels.whatsapp.template_language"];

          const [template] = await ctx.tx
            .select()
            .from(messageTemplates)
            .where(
              and(
                eq(messageTemplates.channelConnectionId, request.connectionId),
                eq(messageTemplates.name, name),
                eq(messageTemplates.language, language),
              ),
            )
            .limit(1);
          if (template === undefined) return { kind: "none", reason: "template_not_found" };
          if (template.status !== "approved") {
            return { kind: "none", reason: `template_${template.status}` };
          }
          const body = bodyOf(template.components);
          if (body === null) return { kind: "none", reason: "template_without_body" };
          const variables = templateVariables(body);
          if (!variables.every(isKnownVariable)) {
            return { kind: "none", reason: "template_parameters_unknown" };
          }

          const [row] = await ctx.tx
            .select({
              contactName: contacts.displayName,
              businessName: businesses.name,
              businessPhone: businesses.phone,
              businessWebsite: businesses.websiteUrl,
            })
            .from(conversations)
            .innerJoin(contacts, eq(contacts.id, conversations.contactId))
            .innerJoin(businesses, eq(businesses.id, conversations.businessId))
            .where(eq(conversations.id, request.conversationId))
            .limit(1);
          if (row === undefined) return { kind: "none", reason: "conversation_not_found" };
          const fullName = row.contactName?.trim() ?? "";
          const firstName = fullName.split(/\s+/)[0] ?? "";
          const known: Record<string, string> = {
            first_name: firstName.length > 0 ? firstName : "there",
            contact_name: fullName.length > 0 ? fullName : "there",
            business_name: row.businessName,
            bot_name: values["persona.bot_name"],
            business_phone: row.businessPhone ?? row.businessName,
            business_website: row.businessWebsite ?? row.businessName,
          };
          // Template parameters may not be empty, and Meta refuses newlines and long runs of
          // spaces in them.
          const namedVariables = Object.fromEntries(
            variables.map((variable) => [
              variable,
              (known[variable] ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
            ]),
          );
          return {
            kind: "template",
            message: {
              kind: "template",
              templateName: template.name,
              languageCode: template.language,
              variables: [],
              ...(variables.length === 0 ? {} : { namedVariables }),
            },
            renderedText: renderTemplateBody(body, namedVariables),
          };
        });
    },
  };
}
