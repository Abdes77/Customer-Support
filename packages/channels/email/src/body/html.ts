import { Parser } from "htmlparser2";

/*
 * The text of an HTML email, for messages without a text part. Quoted earlier messages are
 * left out where the mail program marks them (Gmail's `gmail_quote`, Apple Mail's
 * `blockquote type="cite"`, Outlook's reply header and reference containers, Yahoo's quoted
 * block), and so is anything hidden: hidden text is where a sender would put words meant for
 * a machine (the bot) and not for a person.
 */

const SKIP = new Set(["script", "style", "head", "title", "template", "noscript", "svg", "object"]);
const BLOCK = new Set([
  "address",
  "article",
  "blockquote",
  "br",
  "div",
  "dl",
  "dd",
  "dt",
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
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
]);
const VOID = new Set(["br", "hr", "img", "input", "link", "meta", "area", "base", "col", "wbr"]);

function isHidden(attributes: Readonly<Record<string, string>>): boolean {
  if ("hidden" in attributes) return true;
  if ((attributes["aria-hidden"] ?? "").toLowerCase() === "true") return true;
  const style = (attributes["style"] ?? "").toLowerCase().replaceAll(/\s+/g, "");
  return (
    style.includes("display:none") ||
    style.includes("visibility:hidden") ||
    style.includes("font-size:0") ||
    style.includes("max-height:0") ||
    style.includes("opacity:0;") ||
    style.endsWith("opacity:0") ||
    /(^|;)color:(#fff(fff)?|white)(;|$)/.test(style)
  );
}

/** Containers in which mail programs put the message being replied to. */
function isQuoteContainer(name: string, attributes: Readonly<Record<string, string>>): boolean {
  const className = ` ${(attributes["class"] ?? "").toLowerCase()} `;
  const id = (attributes["id"] ?? "").toLowerCase();
  if (name === "blockquote") return true;
  if (
    className.includes(" gmail_quote ") ||
    className.includes(" gmail_quote_container ") ||
    className.includes(" yahoo_quoted ") ||
    className.includes(" moz-cite-prefix ") ||
    className.includes(" protonmail_quote ") ||
    className.includes(" zmail_extra ")
  ) {
    return true;
  }
  return (
    id === "divrplyfwdmsg" ||
    id === "appendonsend" ||
    id === "mail-editor-reference-message-container" ||
    id.startsWith("yahoo_quoted") ||
    id === "x_divrplyfwdmsg"
  );
}

export interface HtmlText {
  readonly text: string;
  /** Whether a quoted earlier message was left out. */
  readonly quoteRemoved: boolean;
}

/** The readable text of an HTML body, without quoted earlier messages and hidden text. */
export function htmlToText(
  html: string,
  options: { readonly keepQuotes?: boolean } = {},
): HtmlText {
  const keepQuotes = options.keepQuotes === true;
  const out: string[] = [];
  // Depth counters of elements we are inside and must not read.
  const stack: { name: string; skip: boolean }[] = [];
  let skipping = 0;
  let quoteRemoved = false;
  let afterReplyMarker = false;

  const newline = () => {
    if (out.length > 0 && out[out.length - 1] !== "\n") out.push("\n");
  };

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const quote = !keepQuotes && isQuoteContainer(name, attributes);
        const skip = SKIP.has(name) || isHidden(attributes) || quote || afterReplyMarker;
        if (quote) quoteRemoved = true;
        // Outlook's reply header starts with <hr id="stopSpelling"> or a border-top <div>:
        // everything after it is the earlier message.
        if (
          !keepQuotes &&
          name === "hr" &&
          ((attributes["id"] ?? "").toLowerCase() === "stopspelling" ||
            (attributes["id"] ?? "").toLowerCase() === "x_stopspelling")
        ) {
          afterReplyMarker = true;
          quoteRemoved = true;
        }
        if (VOID.has(name)) {
          if (skipping === 0 && !skip && (name === "br" || name === "hr")) out.push("\n");
          return;
        }
        stack.push({ name, skip });
        if (skip) skipping += 1;
        if (skipping === 0 && BLOCK.has(name)) newline();
        if (skipping === 0 && name === "li") out.push("- ");
      },
      ontext(text) {
        if (skipping > 0 || afterReplyMarker) return;
        out.push(text.replace(/[ \t\r\n\u00a0]+/g, " "));
      },
      onclosetag(name) {
        if (VOID.has(name)) return;
        // Close the most recent matching element (tolerates sloppy markup).
        for (let index = stack.length - 1; index >= 0; index -= 1) {
          const item = stack[index]!;
          if (item.name !== name) continue;
          for (const removed of stack.splice(index)) if (removed.skip) skipping -= 1;
          break;
        }
        if (skipping === 0 && BLOCK.has(name)) newline();
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  const text = out
    .join("")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, quoteRemoved };
}
