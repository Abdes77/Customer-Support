import { Parser } from "htmlparser2";

import { cleanLine, cleanText } from "../knowledge/text";

/**
 * Reading a web page: its visible text, its links and the structured data it publishes
 * about the business (JSON-LD). Scripts, styles and anything marked as hidden are skipped:
 * hidden text is where a page would put words meant for a machine and not for a visitor.
 */

export interface PageContent {
  readonly title: string | null;
  readonly description: string | null;
  /** The visible text, one block per line, cut to `maxChars`. */
  readonly text: string;
  readonly truncated: boolean;
  /** Absolute http(s) links, without fragments, in page order, each once. */
  readonly links: readonly string[];
  /** Parsed JSON-LD blocks (schema.org), as the page published them. */
  readonly structured: readonly unknown[];
}

const SKIP = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "select",
  "textarea",
  "button",
  "form",
]);
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);
const VOID = new Set(["br", "hr", "img", "input", "link", "meta", "area", "base", "col", "wbr"]);

const MAX_JSON_LD_CHARS = 100_000;
const MAX_LINKS = 400;

function isHidden(attributes: Readonly<Record<string, string>>): boolean {
  if ("hidden" in attributes) return true;
  if ((attributes["aria-hidden"] ?? "").toLowerCase() === "true") return true;
  const style = (attributes["style"] ?? "").toLowerCase().replaceAll(/\s+/g, "");
  return (
    style.includes("display:none") ||
    style.includes("visibility:hidden") ||
    style.includes("font-size:0") ||
    style.includes("opacity:0;") ||
    style.endsWith("opacity:0")
  );
}

export function extractPage(
  html: string,
  pageUrl: string,
  options: { readonly maxChars?: number } = {},
): PageContent {
  const maxChars = options.maxChars ?? 12_000;
  let base = pageUrl;
  let title = "";
  let description: string | null = null;
  const parts: string[] = [];
  const links: string[] = [];
  const seenLinks = new Set<string>();
  const structured: unknown[] = [];

  /** Depth inside an element whose content is skipped (0: not skipping). */
  let skipDepth = 0;
  let inTitle = false;
  let jsonLd: string | null = null;
  /** Open elements, so that the close of a hidden one ends the skipping. */
  const stack: { name: string; skipping: boolean }[] = [];

  const addLink = (href: string) => {
    if (links.length >= MAX_LINKS) return;
    const trimmed = href.trim();
    if (trimmed.length === 0 || /^(?:#|mailto:|tel:|sms:|javascript:|data:)/i.test(trimmed)) return;
    let url: URL;
    try {
      url = new URL(trimmed, base);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    url.hash = "";
    const absolute = url.toString();
    if (seenLinks.has(absolute)) return;
    seenLinks.add(absolute);
    links.push(absolute);
  };

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const starts = skipDepth === 0 && (SKIP.has(name) || isHidden(attributes));
        if (!VOID.has(name)) stack.push({ name, skipping: starts });
        if (name === "script" && skipDepth === 0) {
          const type = (attributes["type"] ?? "").toLowerCase();
          if (type === "application/ld+json") jsonLd = "";
        }
        if (starts && !VOID.has(name)) skipDepth = 1;
        else if (skipDepth > 0 && !VOID.has(name)) skipDepth += 1;
        if (skipDepth > 0) return;

        if (name === "title") inTitle = true;
        if (name === "base" && attributes["href"] !== undefined) {
          try {
            base = new URL(attributes["href"], pageUrl).toString();
          } catch {
            // An unusable <base> is ignored.
          }
        }
        if (name === "meta") {
          const key = (attributes["name"] ?? attributes["property"] ?? "").toLowerCase();
          const value = attributes["content"];
          if ((key === "description" || key === "og:description") && value !== undefined) {
            description ??= cleanLine(value).slice(0, 500);
          }
        }
        if (name === "a" && attributes["href"] !== undefined) addLink(attributes["href"]);
        if (BLOCK.has(name)) parts.push("\n");
      },
      ontext(text) {
        if (jsonLd !== null) {
          if (jsonLd.length + text.length <= MAX_JSON_LD_CHARS) jsonLd += text;
          return;
        }
        if (skipDepth > 0) return;
        if (inTitle) {
          title += text;
          return;
        }
        parts.push(text);
      },
      onclosetag(name) {
        if (VOID.has(name)) return;
        if (name === "script" && jsonLd !== null) {
          try {
            const value: unknown = JSON.parse(jsonLd);
            if (Array.isArray(value)) structured.push(...(value as unknown[]));
            else structured.push(value);
          } catch {
            // Not JSON: the page's problem, not ours.
          }
          jsonLd = null;
        }
        if (name === "title") inTitle = false;
        const open = stack.pop();
        if (skipDepth > 0) {
          skipDepth -= 1;
          // Unbalanced markup: the element that started the skipping is the authority.
          if (open?.skipping === true) skipDepth = 0;
          return;
        }
        if (BLOCK.has(name)) parts.push("\n");
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  const text = cleanText(
    parts
      .join("")
      .replaceAll(/[ \t\u00a0]+/g, " ")
      .replaceAll(/ ?\n ?/g, "\n")
      .replaceAll(/\n{2,}/g, "\n"),
  );
  const cleanTitle = cleanLine(title).slice(0, 200);
  return {
    title: cleanTitle.length > 0 ? cleanTitle : null,
    description,
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
    links,
    structured,
  };
}
