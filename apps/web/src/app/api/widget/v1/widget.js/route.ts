import { WIDGET_SCRIPT, WIDGET_SCRIPT_VERSION } from "@repo/widget-embed";

// Dynamic, so the ETag check sees the request headers; browsers and CDNs cache by the headers below.
export const dynamic = "force-dynamic";

const ETAG = `"${WIDGET_SCRIPT_VERSION}"`;

/**
 * The embeddable script (`<script src=".../api/widget/v1/widget.js" data-key="wpk_..." async>`).
 * Cached for five minutes and then revalidated by its ETag, so a new release reaches every
 * site within minutes without a version in the snippet.
 */
export function GET(request: Request): Response {
  const headers = {
    "content-type": "application/javascript; charset=utf-8",
    "cache-control": "public, max-age=300, stale-while-revalidate=86400",
    etag: ETAG,
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "cross-origin",
  };
  if (request.headers.get("if-none-match") === ETAG) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(WIDGET_SCRIPT, { status: 200, headers });
}
