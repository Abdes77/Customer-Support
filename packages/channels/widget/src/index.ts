/**
 * @repo/channel-widget (owner: C8)
 *
 * Server side of the website chat widget: the channel adapter, visitor session tokens,
 * allowed origins, photo checks and the Realtime poke. The database half (sessions,
 * configuration, messages, rate limits, the embed data for the admin panel) is
 * `@repo/channel-widget/server`. Server only.
 */
export { createWidgetAdapter, type WidgetAdapterOptions } from "./adapter";
export { isOriginAllowed, normalizeOrigin } from "./origins";
export {
  createRealtimeNotifier,
  silentNotifier,
  visitorTopic,
  type WidgetNotifier,
  type WidgetPokeEvent,
} from "./realtime";
export {
  assertWidgetSecret,
  hashIp,
  signWidgetToken,
  verifyWidgetToken,
  type WidgetTokenClaims,
} from "./token";
export { MEGABYTE, photoFileName, sniffImage, type SniffedImage } from "./uploads";
