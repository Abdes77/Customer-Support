/**
 * @repo/widget-embed (owner: C8)
 *
 * The embeddable website chat script that runs in the visitor's browser. Its source is
 * `src/browser` (plain TypeScript, no framework, types from @repo/core only); the bundle the
 * app serves at `/api/widget/v1/widget.js` is generated into `src/bundle.generated.ts` by
 * `pnpm --filter @repo/widget-embed build`, and a test fails when it is stale or too big.
 */
export { WIDGET_SCRIPT, WIDGET_SCRIPT_SHA256, WIDGET_SCRIPT_VERSION } from "./bundle.generated";
