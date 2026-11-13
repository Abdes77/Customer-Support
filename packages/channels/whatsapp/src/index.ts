/**
 * @repo/channel-whatsapp (owner: C9)
 *
 * WhatsApp Business Cloud API. This entry point is the stateless channel adapter (webhook
 * verification and parsing, sending, read receipts and typing, media download) and the
 * shapes it stores; `@repo/channel-whatsapp/server` holds what touches the database
 * (Embedded Signup, connections, templates, the window fallback, voice messages, jobs);
 * `@repo/channel-whatsapp/testing` has recorded-style fixtures and a fake Graph API.
 */
export {
  createWhatsAppAdapter,
  type MediaReader,
  sendFailureOf,
  WHATSAPP_CAPABILITIES,
  type WhatsAppAdapter,
  type WhatsAppAdapterOptions,
} from "./adapter";
export { GraphId, WhatsAppConfig, WhatsAppCredentials } from "./credentials";
export {
  appendOptions,
  BUTTON_LIMITS,
  LIST_LIMITS,
  MEDIA_LIMITS,
  mediaBody,
  readBody,
  recipientOf,
  templateBody,
  textBody,
} from "./send";
export { e164, normalizeLanguage, normalizeMessage, parseWhatsAppWebhook } from "./webhook";
