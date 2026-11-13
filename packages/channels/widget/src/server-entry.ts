/**
 * @repo/channel-widget/server: the database half of the website chat. The public API service
 * (`createWidgetService`, behind `/api/widget/v1`) and the connection functions the admin
 * panel calls (C16) after checking the user: set up, rotate the key, switch on or off, and
 * the embed snippet. Server only.
 */
export {
  createWidgetService,
  normalizePhone,
  widgetFailure,
  type WidgetOutcome,
  type WidgetPhoto,
  type WidgetRequestInfo,
  type WidgetService,
  type WidgetServiceOptions,
} from "./server/service";
export {
  ensureWidgetConnection,
  generateWidgetKey,
  isWidgetKey,
  rotateWidgetKey,
  setWidgetEnabled,
  type WidgetConnectionRow,
  type WidgetEmbedInfo,
  widgetEmbedInfo,
  widgetScriptUrl,
  widgetSnippet,
} from "./server/connection";
export { hit } from "./server/limits";
