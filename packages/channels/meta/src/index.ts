/**
 * @repo/channel-meta (owner: C9; extended by C10)
 *
 * The parts every Meta channel shares: webhook verification (handshake and
 * `X-Hub-Signature-256`), the Graph API client with Meta's error codes and rate limits,
 * media download and upload, and the code exchange of Embedded Signup and Facebook Login.
 * Stateless: no database, no environment. WhatsApp (C9) and Instagram and Messenger (C10)
 * build their adapters on it.
 */
export { classifyGraphError, type GraphErrorClass, regainAccessSeconds } from "./errors";
export {
  assertMetaMediaUrl,
  cleanMimeType,
  createGraphClient,
  DEFAULT_GRAPH_API_VERSION,
  type FetchLike,
  GRAPH_BASE_URL,
  GraphApiError,
  type GraphClient,
  type GraphClientOptions,
  type GraphQuery,
  type GraphRequest,
  META_MEDIA_HOST_SUFFIXES,
} from "./graph";
export { type DownloadedMedia, downloadMedia, MediaInfo, uploadMedia } from "./media";
export { type ExchangedToken, exchangeCode } from "./oauth";
export {
  META_SIGNATURE_HEADER,
  metaSignature,
  type MetaWebhookSecrets,
  safeEqual,
  verifyMetaSignature,
  verifyMetaWebhook,
} from "./signature";
