/*
 * The email a customer receives. The engine writes the words (a greeting, short paragraphs,
 * a sign-off with the bot's name); this module makes it the business's email: the greeting
 * in the form `channels.email.greeting` asks for, the sign-off of `channels.email.sign_off`
 * followed by the signature of `channels.email.signature`, the customer's message quoted
 * below as mail programs do (`channels.email.quote_original`), and an HTML part that looks
 * like a person typed it (one font, plain paragraphs, no template).
 *
 * A person's reply from the inbox (author `human_agent`) is sent as they wrote it.
 */

export type GreetingStyle = "hi_first_name" | "hello_first_name" | "dear_full_name";

export interface QuotedMessage {
  readonly text: string;
  readonly fromName: string | null;
  readonly fromAddress: string;
  readonly sentAt: Date;
}

export interface ComposeInput {
  readonly body: string;
  readonly author: "bot" | "human_agent";
  readonly greeting: GreetingStyle;
  readonly signOff: string;
  /** The signature with its placeholders filled in; may be empty. */
  readonly signature: string;
  readonly botName: string;
  /** The customer's name as the channel knows it (display name), if it looks like one. */
  readonly contactName: string | null;
  readonly quote: QuotedMessage | null;
  /** The business's time zone, for the date of the quoted message. */
  readonly timeZone: string;
}

export interface ComposedEmail {
  readonly text: string;
  readonly html: string;
}

const GREETING_LINE =
  /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening)|greetings)\b(?:\s+([^,!.:\n]{1,60}?))?\s*[,!.:]?\s*$/i;
const SIGN_OFF_LINE =
  /^(?:best|best regards|kind regards|warm regards|warmest regards|regards|thanks|thank you|thanks again|many thanks|cheers|sincerely|talk soon|speak soon|all the best|take care|warmly|respectfully|with thanks)[,.!]?$/i;
const GENERIC_NAMES = new Set(["there", "all", "everyone", "team", "folks", "friend", "customer"]);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A display name that reads as a person's name ("Maria Lopez"), or null. */
export function personName(displayName: string | null | undefined): string | null {
  if (displayName == null) return null;
  const name = displayName
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length === 0 || name.length > 60) return null;
  if (/[@\d,;:()<>[\]{}|/\\_]/.test(name)) return null;
  const words = name.split(" ");
  if (words.length > 4) return null;
  if (!words.every((word) => /^[\p{L}][\p{L}'’.-]*$/u.test(word))) return null;
  // "MARIA LOPEZ" → "Maria Lopez"; "maria" → "Maria".
  return words
    .map((word) =>
      word === word.toUpperCase() || word === word.toLowerCase()
        ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        : word,
    )
    .join(" ");
}

function renderGreeting(style: GreetingStyle, first: string | null, full: string | null): string {
  switch (style) {
    case "hi_first_name":
      return first === null ? "Hi there," : `Hi ${first},`;
    case "hello_first_name":
      return first === null ? "Hello," : `Hello ${first},`;
    case "dear_full_name":
      return full !== null ? `Dear ${full},` : first !== null ? `Dear ${first},` : "Hello,";
  }
}

/** The greeting line rewritten in the configured form, keeping the name the bot used. */
function applyGreeting(lines: string[], input: ComposeInput): string[] {
  const index = lines.findIndex((line) => line.trim().length > 0);
  if (index < 0) return lines;
  const match = GREETING_LINE.exec(lines[index]!.trim());
  if (match === null) return lines;
  const said = match[1]?.trim() ?? null;
  const contact = personName(input.contactName);
  const saidName = said !== null && !GENERIC_NAMES.has(said.toLowerCase()) ? said : null;
  const first = saidName?.split(" ")[0] ?? contact?.split(" ")[0] ?? null;
  const full =
    contact !== null &&
    (first === null || contact.split(" ")[0]!.toLowerCase() === first.toLowerCase())
      ? contact
      : saidName;
  const next = [...lines];
  next[index] = renderGreeting(input.greeting, first, full);
  return next;
}

/** The engine's closing ("Best,\nSam" or "Thanks!") taken off the end. */
function withoutSignOff(lines: string[]): string[] {
  const content = [...lines];
  while (content.length > 0 && content[content.length - 1]!.trim() === "") content.pop();
  const last = content[content.length - 1]?.trim() ?? "";
  const before = content[content.length - 2]?.trim() ?? "";
  if (
    SIGN_OFF_LINE.test(before) &&
    last.length > 0 &&
    last.length <= 40 &&
    last.split(/\s+/).length <= 4 &&
    !/[?!.:]$/.test(last)
  ) {
    return content.slice(0, -2);
  }
  if (SIGN_OFF_LINE.test(last)) return content.slice(0, -1);
  return content;
}

function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start += 1;
  while (end > start && lines[end - 1]!.trim() === "") end -= 1;
  return lines.slice(start, end);
}

function quoteHeader(quote: QuotedMessage, timeZone: string): string {
  let when: string;
  try {
    const date = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(quote.sentAt);
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(quote.sentAt);
    when = `${date} at ${time}`;
  } catch {
    when = quote.sentAt.toUTCString();
  }
  const who =
    quote.fromName === null ? `<${quote.fromAddress}>` : `${quote.fromName} <${quote.fromAddress}>`;
  return `On ${when}, ${who} wrote:`;
}

function paragraphsHtml(lines: readonly string[]): string {
  const text = lines.join("\n");
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => `<div>${escapeHtml(block).replace(/\n/g, "<br>")}</div>`)
    .join("<div><br></div>");
}

/**
 * The words of a reply without the greeting line and the closing the composer replaces
 * (whitespace collapsed): what any email composed from `body` contains verbatim above the
 * quote. Used to recognize our own sent copy without its headers (C11 review).
 */
export function replyCore(body: string): string {
  let lines = body.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first >= 0 && GREETING_LINE.test(lines[first]!.trim())) lines.splice(first, 1);
  lines = trimBlank(withoutSignOff(lines));
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

const STYLE = "font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222";

export function composeEmail(input: ComposeInput): ComposedEmail {
  let lines = input.body.replace(/\r\n?/g, "\n").split("\n");
  let closing: string[] = [];
  if (input.author === "bot") {
    lines = applyGreeting(lines, input);
    lines = withoutSignOff(lines);
    const signature = input.signature.replace(/\r\n?/g, "\n").trim();
    closing = [
      input.signOff.trim(),
      ...(signature.length === 0 ? [input.botName] : signature.split("\n")),
    ]
      .map((line) => line.trimEnd())
      .filter((line, index) => index > 0 || line.length > 0);
  }
  lines = trimBlank(lines);

  const textParts = [lines.join("\n")];
  if (closing.length > 0) textParts.push(closing.join("\n"));
  let text = textParts.filter((part) => part.length > 0).join("\n\n");

  let html = paragraphsHtml(lines);
  if (closing.length > 0) {
    html += `<div><br></div><div>${closing.map(escapeHtml).join("<br>")}</div>`;
  }

  if (input.quote !== null && input.quote.text.trim().length > 0) {
    const head = quoteHeader(input.quote, input.timeZone);
    const quoted = input.quote.text.replace(/\r\n?/g, "\n").trim();
    text += `\n\n${head}\n${quoted
      .split("\n")
      .map((line) => (line.length === 0 ? ">" : `> ${line}`))
      .join("\n")}`;
    html +=
      `<br><div class="gmail_quote"><div>${escapeHtml(head)}</div>` +
      `<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #cccccc;padding-left:1ex">` +
      `${escapeHtml(quoted).replace(/\n/g, "<br>")}</blockquote></div>`;
  }
  return {
    text: `${text}\n`,
    html: `<div dir="ltr" style="${STYLE}">${html}</div>`,
  };
}
