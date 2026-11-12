import { z } from "zod";

/**
 * What a Messenger or Instagram connection stores. Both channels send through the Facebook
 * Page (an Instagram professional account linked to a Page is messaged with the Page's
 * token, on the Page's `/messages` endpoint). The token is encrypted in
 * `channel_connection_secrets` and decrypted only inside the step that calls Meta; the
 * config is the non-secret description shown in the admin panel.
 */
export const MetaPageCredentials = z.object({
  /** Page access token read with the token from Facebook Login for Business. */
  pageAccessToken: z.string().min(1),
});
export type MetaPageCredentials = z.infer<typeof MetaPageCredentials>;

export const MetaPageConfig = z.object({
  pageId: z.string().min(1),
  pageName: z.string().nullable().default(null),
  /** Instagram connections only: the professional account linked to the Page. */
  instagramAccountId: z.string().nullable().default(null),
  instagramUsername: z.string().nullable().default(null),
});
export type MetaPageConfig = z.infer<typeof MetaPageConfig>;

/** Graph ids are digits; anything else in a path segment is refused. */
export const GraphId = z.string().regex(/^\d{1,30}$/, "Not a Meta id.");

/**
 * The app id the Page inbox (Meta Business Suite, the Pages app) sends with, according to the
 * message_echoes reference ("Starting Graph API v12.0+ ... Facebook Page inbox app id").
 * The reference prints 26390203743090; the id Meta has long used is 263902037430900. Both
 * are taken as a person replying from Meta's inbox.
 */
export const PAGE_INBOX_APP_IDS: ReadonlySet<string> = new Set([
  "263902037430900",
  "26390203743090",
]);

/** Prefix of the `metadata` we put on every message we send; echoes carry it back. */
export const SEND_METADATA_PREFIX = "hsrb:";
