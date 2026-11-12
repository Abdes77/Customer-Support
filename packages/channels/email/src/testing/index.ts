/**
 * @repo/channel-email/testing (owner: C11): raw email fixtures, fakes of the Gmail API and
 * Microsoft Graph (with their OAuth token endpoints), and a local IMAP/SMTP server. For tests
 * and local tries only; never imported by product code.
 */
export { createFakeGmail, type FakeGmail } from "./fake-gmail";
export { createFakeGraph, type FakeGraph } from "./fake-graph";
export * from "./fixtures";
export { localCertificate, type LocalMailServer, startLocalMailServer } from "./mail-server";
