import { WIDGET_PUBLIC_KEY_PATTERN } from "@repo/core";

/**
 * The chat on a demo page, embedded exactly as a business embeds it on its own site: one
 * script tag with the widget's public key. Written into the page's HTML (not added by React
 * afterwards), so the browser runs it once per page load; the key is checked against its
 * pattern (letters and digits only) before it is put into markup.
 */
export function ChatSnippet({ widgetKey }: { readonly widgetKey: string }) {
  if (!WIDGET_PUBLIC_KEY_PATTERN.test(widgetKey)) return null;
  const snippet = `<script src="/api/widget/v1/widget.js" data-key="${widgetKey}" async></script>`;
  return <div hidden dangerouslySetInnerHTML={{ __html: snippet }} />;
}
