/**
 * @repo/channel-messenger-instagram (owner: C10)
 *
 * Facebook Messenger and Instagram Direct through the Messenger Platform (an Instagram
 * professional account linked to a Facebook Page). This entry point is the stateless channel
 * adapters (webhook verification and parsing, sending with the right messaging type, typing
 * and seen indicators, attachment downloads) and the shapes they store;
 * `@repo/channel-messenger-instagram/server` holds what touches the database (Facebook Login
 * for Business, connections, account events, the story-reply guard);
 * `@repo/channel-messenger-instagram/testing` has recorded-style fixtures and a fake Graph API.
 */
export {
  createInstagramAdapter,
  createMessengerAdapter,
  createMetaMessagingAdapter,
  INSTAGRAM_CAPABILITIES,
  type MediaReader,
  MESSENGER_CAPABILITIES,
  type MetaMessagingAdapter,
  type MetaMessagingAdapterOptions,
  messagingTypeFor,
  sendFailureOf,
} from "./adapter";
export {
  GraphId,
  MetaPageConfig,
  MetaPageCredentials,
  PAGE_INBOX_APP_IDS,
  SEND_METADATA_PREFIX,
} from "./credentials";
export {
  appendOptions,
  attachmentBody,
  fitText,
  HUMAN_AGENT_TAG,
  MEDIA_LIMITS,
  type MessagingType,
  QUICK_REPLY_LIMITS,
  RESPONSE,
  senderActionBody,
  TEXT_LIMITS,
  textBody,
} from "./send";
export { isoFromMetaTime, type MetaMessagingChannel, parseMetaMessagingWebhook } from "./webhook";
