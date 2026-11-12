/**
 * @repo/channel-whatsapp/server (owner: C9). Server only: the parts that touch the database.
 *
 * For the admin panel (C16), call these in a server action or route after checking that the
 * signed-in user may manage the business's channels (agency staff):
 * - `connections.signupConfig()` for the browser's Embedded Signup, then
 *   `connections.completeEmbeddedSignup(tenant, userId, { code, businessAccountId,
 *   phoneNumberId })` (also behind `POST /api/oauth/meta/whatsapp`);
 * - `connections.list(tenant)` and `connections.disconnect(tenant, connectionId)`;
 * - `connections.templates.list / create / sync / remove` and `SUGGESTED_TEMPLATES`.
 *
 * For the pipeline (registered in apps/web): `createWhatsAppWindowFallback`,
 * `createWhatsAppEventHandler`, `createVoiceMessageEnricher` and `createWhatsAppJobs`.
 */
export type { WhatsAppServerDeps } from "./deps";
export {
  type ConnectionService,
  createConnectionService,
  type EmbeddedSignupConfig,
  EmbeddedSignupInput,
  type WhatsAppConnectionView,
} from "./connections";
export { createWhatsAppEventHandler } from "./events";
export { createWhatsAppWindowFallback } from "./fallback";
export { createWhatsAppJobs, TEMPLATE_SYNC_FUNCTION_ID } from "./jobs";
export {
  bodyOf,
  CreateTemplateInput,
  createTemplateService,
  renderTemplateBody,
  SUGGESTED_TEMPLATES,
  TEMPLATE_PURPOSES,
  type TemplateService,
  type TemplateView,
  templateStatusOf,
  templateVariables,
  WHATSAPP_TEMPLATE_VARIABLES,
  type WhatsAppTemplateVariable,
} from "./templates";
export {
  ASK_TO_TYPE_NOTE,
  createDeepgramTranscriber,
  createVoiceMessageEnricher,
  type Transcriber,
  transcriptNote,
} from "./voice";
