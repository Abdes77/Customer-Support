/**
 * @repo/channel-email/server (owner: C11). Server only: the parts that touch the database.
 *
 * For the admin panel (C16), after checking that the signed-in user is agency staff of the
 * business (`requireBusinessRole(access, business, ["agency_admin", "agency_member"])`):
 * - `connections.availability()`, `connections.list(tenant)`;
 * - Gmail and Microsoft 365: `connections.startOAuth(tenant, userId, provider, { returnTo })`
 *   (behind `POST /api/oauth/email/{google|microsoft}`), then the provider redirects to
 *   `GET /api/oauth/email/{google|microsoft}/callback`, which calls `readState` and
 *   `completeOAuth`;
 * - IMAP/SMTP: `connections.connectImap(tenant, userId, input)` (behind
 *   `POST /api/channels/email/imap`);
 * - `connections.syncNow(tenant, id)` and `connections.disconnect(tenant, id)`.
 *
 * For the pipeline (registered in apps/web): `createEmailComposer` (`outboundComposers`),
 * `createEmailSendThrottle` (`sendThrottles`), `emailChannelGuard` (`channelGuards`), the
 * jobs of `createEmailJobs`, and the notification handlers for the two webhook routes.
 */
export {
  createEmailConnectionService,
  type EmailConnectionService,
  type EmailConnectionView,
  ImapConnectInput,
  type OAuthFinish,
  type OAuthStart,
} from "./connections";
export {
  type EmailServerDeps,
  type GoogleSetup,
  type MicrosoftSetup,
  publicUrl,
  ROUTES,
} from "./deps";
export {
  createEmailJobs,
  EMAIL_POLL_FUNCTION_ID,
  EMAIL_SYNC_FUNCTION_ID,
  EMAIL_WATCH_RENEW_FUNCTION_ID,
  type EmailJobOptions,
  emailSyncEvent,
} from "./jobs";
export { OAUTH_COOKIE, type OAuthStatePayload } from "./oauth-state";
export { googleKeySource, type JsonWebKeySet, verifyGoogleOidcToken } from "./oidc";
export {
  type ComposeRequest,
  createEmailComposer,
  createEmailSendThrottle,
  emailChannelGuard,
  type EmailTurnFacts,
} from "./pipeline-parts";
export { type FetchedEmail, processEmail, type ProcessOutcome, resolveThread } from "./process";
export {
  createGmailPushHandler,
  createGraphNotificationHandler,
  type PushRequest,
  type PushResponse,
} from "./push";
export { type BatchResult, syncBatch, type SyncTarget } from "./sync";
export { type AccessTokens, createAccessTokens, RECONNECT_MESSAGE } from "./tokens";
export { clientStateMatches, ensurePush, graphClientState } from "./watch";
