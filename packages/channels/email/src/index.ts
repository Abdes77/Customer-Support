/**
 * @repo/channel-email (owner: C11)
 *
 * Email: Gmail (API, push through Pub/Sub), Microsoft 365 and Outlook (Graph, change
 * notifications) and any IMAP/SMTP inbox, with threading, body cleaning, classification of
 * automatic mail and the composition of the business's replies. This entry is stateless
 * (no database); `@repo/channel-email/server` holds what touches the database, and
 * `@repo/channel-email/testing` fakes and a local mail server for tests.
 */
export {
  createEmailAdapter,
  type EmailAdapterDeps,
  type EmailMediaReader,
  gmailThreadOf,
} from "./adapter";
export {
  domainMatches,
  domainOf,
  formatAddress,
  isNoReplyAddress,
  normalizeAddress,
  PUBLIC_MAIL_DOMAINS,
} from "./addresses";
export { cleanBody, type CleanedBody, MAX_BODY_CHARS } from "./body/clean";
export { htmlToText } from "./body/html";
export {
  businessAddressReason,
  type ClassifyContext,
  classifyEmail,
  type EmailClass,
  replyAddressOf,
} from "./classify";
export {
  type ComposedEmail,
  composeEmail,
  replyCore,
  type ComposeInput,
  type GreetingStyle,
  personName,
  type QuotedMessage,
} from "./compose";
export {
  EMAIL_PROVIDERS,
  EmailConnectionConfig,
  EmailConnectionState,
  EmailCredentials,
  EmailProvider,
  GmailConfig,
  ImapConfig,
  LOOP_HEADER,
  MailSecurity,
  MailServer,
  MicrosoftConfig,
  OAuthCredentials,
  PasswordCredentials,
  readState,
} from "./config";
export { buildEmail, type OutgoingEmail } from "./mime/build";
export {
  header,
  MAX_RAW_MESSAGE_BYTES,
  parseEmail,
  type ParsedAddress,
  type ParsedAttachment,
  type ParsedEmail,
} from "./mime/parse";
export { isPublicAddress } from "./net/address";
export {
  DEFAULT_MAIL_POLICY,
  MailHostError,
  type MailNetworkPolicy,
  resolveMailHost,
} from "./net/resolve";
export {
  attachmentKind,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  selectAttachments,
  toInboundMessage,
} from "./normalize";
export {
  createGmailClient,
  GMAIL_API,
  type GmailClient,
  type GmailRawMessage,
} from "./providers/gmail";
export { apiRequest, type FetchLike, MailProviderError } from "./providers/http";
export {
  checkImap,
  checkSmtp,
  type ImapSession,
  MailServerError,
  openImap,
  sendSmtp,
} from "./providers/imap";
export {
  createGraphMailClient,
  GRAPH_API,
  GRAPH_FOLDERS,
  type GraphDeltaItem,
  type GraphFolder,
  type GraphMailClient,
} from "./providers/microsoft";
export {
  exchangeGoogleCode,
  exchangeMicrosoftCode,
  GOOGLE_SCOPES,
  googleAuthorizationUrl,
  MICROSOFT_SCOPES,
  microsoftAuthorizationUrl,
  type MicrosoftOAuthApp,
  type OAuthApp,
  pkcePair,
  refreshGoogleToken,
  refreshMicrosoftToken,
  revokeGoogleToken,
  tokenExpiresSoon,
} from "./providers/oauth";
export {
  baseSubject,
  messageIdList,
  normalizeMessageId,
  outboundMessageId,
  replyReferences,
  replySubject,
  threadKeyOf,
} from "./thread";
