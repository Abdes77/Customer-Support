/**
 * @repo/channel-messenger-instagram/server (owner: C10). Server only: the parts that touch the
 * database.
 *
 * For the admin panel (C16), call these in a server action or route after checking that the
 * signed-in user may manage the business's channels (agency staff):
 * - `pages.loginConfig()` for the browser's Facebook Login for Business, then
 *   `pages.completeFacebookLogin(tenant, userId, { code, pageId?, channels? })` (also behind
 *   `POST /api/oauth/meta/facebook`); a login that granted several Pages answers
 *   `choose_page` and is run again with the chosen `pageId`;
 * - `pages.list(tenant)` and `pages.disconnect(tenant, connectionId)`.
 *
 * For the pipeline (registered in apps/web): `createMetaPagesEventHandler` (one per channel)
 * and `metaChannelGuard`.
 */
export type { MetaPagesServerDeps } from "./deps";
export {
  createMetaPagesService,
  type FacebookLoginConfig,
  FacebookLoginInput,
  type FacebookLoginResult,
  type MetaConnectionView,
  type MetaPagesService,
  PAGE_SUBSCRIBED_FIELDS,
  type PageChoice,
} from "./connections";
export { createMetaPagesEventHandler, POLICY_BLOCK_PREFIX } from "./events";
export { metaChannelGuard, type MetaTurnFacts } from "./guard";
