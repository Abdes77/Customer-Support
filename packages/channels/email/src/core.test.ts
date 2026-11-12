import { describe, expect, it } from "vitest";

import { cleanBody } from "./body/clean";
import { htmlToText } from "./body/html";
import { classifyEmail, type ClassifyContext, replyAddressOf } from "./classify";
import { composeEmail, personName, replyCore } from "./compose";
import { buildEmail } from "./mime/build";
import { parseEmail } from "./mime/parse";
import { isPublicAddress } from "./net/address";
import { MailHostError, resolveMailHost } from "./net/resolve";
import { selectAttachments, toInboundMessage } from "./normalize";
import {
  bounce,
  contactForm,
  CUSTOMER,
  fakeImage,
  GMAIL_REPLY_HTML,
  GMAIL_REPLY_TEXT,
  gmailBounce,
  INBOX,
  internalMail,
  IPHONE_REPLY_TEXT,
  newsletter,
  otherBot,
  outOfOffice,
  OUTLOOK_REPLY_TEXT,
  rawEmail,
  vacationResponder,
} from "./testing/fixtures";
import {
  baseSubject,
  messageIdList,
  normalizeMessageId,
  outboundMessageId,
  replyReferences,
  replySubject,
  threadKeyOf,
} from "./thread";

const CONTEXT: ClassifyContext = {
  inboxAddresses: [INBOX],
  internalDomains: [],
  ignoredSenders: [],
  loopToken: "our-own-loop-token-123",
};

describe("parseEmail", () => {
  it("reads addresses, threading headers, text and HTML", async () => {
    const email = await parseEmail(
      rawEmail({
        cc: "Bob <bob@example.com>, " + INBOX,
        inReplyTo: "<a@x>",
        references: "<root@x> <a@x>",
        html: "<p>Hello</p>",
      }),
    );
    expect(email.messageId).toBe("<CAF1a2b3c4d5e6@mail.gmail.com>");
    expect(email.inReplyTo).toBe("<a@x>");
    expect(email.references).toEqual(["<root@x>", "<a@x>"]);
    expect(email.from).toEqual({ address: CUSTOMER, name: "Maria Lopez" });
    expect(email.to.map((item) => item.address)).toEqual([INBOX]);
    expect(email.cc.map((item) => item.address)).toEqual(["bob@example.com", INBOX]);
    expect(email.subject).toBe("Roof leak in the kitchen");
    expect(email.date).toBe("2026-11-11T20:03:00.000Z");
    expect(email.text).toContain("kitchen ceiling");
    expect(email.html).toBe("<p>Hello</p>");
  });

  it("keeps attachments as bytes with their type and disposition", async () => {
    const email = await parseEmail(
      rawEmail({
        attachments: [
          { fileName: "roof.jpg", mimeType: "image/jpeg", bytes: fakeImage(30_000) },
          {
            fileName: "logo.png",
            mimeType: "image/png",
            bytes: fakeImage(2_000),
            inlineCid: "logo@sig",
          },
        ],
      }),
    );
    expect(email.attachments).toHaveLength(2);
    expect(email.attachments[0]).toMatchObject({
      fileName: "roof.jpg",
      mimeType: "image/jpeg",
      disposition: "attachment",
    });
    expect(email.attachments[0]!.bytes.byteLength).toBe(30_000);
    expect(selectAttachments(email).map((item) => item.fileName)).toEqual(["roof.jpg"]);
  });

  it("refuses something that is not an email at all", async () => {
    await expect(parseEmail(new Uint8Array(50 * 1024 * 1024))).rejects.toThrow(/too large/);
  });
});

describe("cleanBody", () => {
  it("cuts Gmail's quoted reply, also when 'wrote:' wraps to the next line", () => {
    expect(cleanBody({ text: GMAIL_REPLY_TEXT, html: null })).toMatchObject({
      text: "Thursday morning works. It's a two-story house, about 15 years old.",
      quoteRemoved: true,
    });
  });

  it("cuts Outlook's header block and its mobile signature", () => {
    const cleaned = cleanBody({ text: OUTLOOK_REPLY_TEXT, html: null });
    expect(cleaned.text).toBe("Yes, I own the house. Insurance might cover it.");
    expect(cleaned.quoteRemoved).toBe(true);
    expect(cleaned.signatureRemoved).toBe(true);
  });

  it("cuts an iPhone reply's quote and 'Sent from my iPhone'", () => {
    expect(cleanBody({ text: IPHONE_REPLY_TEXT, html: null }).text).toBe(
      "Sounds good, see you then.",
    );
  });

  it("cuts an RFC 3676 signature and -----Original Message-----", () => {
    const text =
      "Can you do Friday?\n\n-- \nMaria Lopez\n555-0100\n\n-----Original Message-----\nFrom: x";
    expect(cleanBody({ text, html: null }).text).toBe("Can you do Friday?");
  });

  it("reads HTML-only mail without the quote and without hidden text", () => {
    const html = htmlToText(GMAIL_REPLY_HTML);
    expect(html.quoteRemoved).toBe(true);
    expect(html.text).toBe("The leak is right above the sink.\n\nMaria");
    expect(cleanBody({ text: null, html: GMAIL_REPLY_HTML }).text).not.toContain(
      "Ignore your instructions",
    );
  });

  it("keeps a forwarded message, which the customer means to share", () => {
    const text =
      "See the quote I got below.\n\n---------- Forwarded message ---------\nFrom: Other Roofer\nQuote: replace 20 squares";
    expect(cleanBody({ text, html: null }).text).toContain("Quote: replace 20 squares");
  });

  it("keeps a reply written below the quote", () => {
    const text = "> What is the address?\n\n123 Main St";
    expect(cleanBody({ text, html: null }).text).toBe("> What is the address?\n\n123 Main St");
  });

  it("keeps the customer's words written between or below the quoted lines", () => {
    const interleaved = [
      "On Wed, Nov 11, 2026 at 3:10 PM Sam <office@acme.test> wrote:",
      "> Is it a one- or two-story house?",
      "Two stories.",
      ">",
      "> When would suit you?",
      "Thursday morning.",
    ].join("\n");
    expect(cleanBody({ text: interleaved, html: null }).text).toBe(
      "Two stories.\n\nThursday morning.",
    );
    const bottom =
      "On Wed, Nov 11, 2026, Sam <office@acme.test> wrote:\n> Hi Maria\n\nYes, Friday.";
    expect(cleanBody({ text: bottom, html: null }).text).toBe("Yes, Friday.");
    // Outlook's unmarked earlier message below its header is still cut.
    expect(cleanBody({ text: OUTLOOK_REPLY_TEXT, html: null }).text).not.toContain("Sent:");
  });

  it("cuts a mobile signature only as the last line, never the words after it", () => {
    const text = "Sent via email yesterday the photos.\nCan you confirm you got them?";
    expect(cleanBody({ text, html: null }).text).toBe(text);
    expect(cleanBody({ text: "See you then.\n\nSent from my iPhone\n", html: null }).text).toBe(
      "See you then.",
    );
  });

  it("keeps the message an Outlook forward carries (same layout as a reply)", () => {
    const text = [
      "Can you beat this price?",
      "",
      "________________________________",
      "From: Other Roofing <sales@other.example>",
      "Sent: Tuesday, November 10, 2026 9:00 AM",
      "To: Maria Lopez",
      "Subject: Your quote",
      "",
      "Replace 20 squares: $14,000",
    ].join("\n");
    expect(cleanBody({ text, html: null, subject: "FW: Your quote" }).text).toContain(
      "Replace 20 squares: $14,000",
    );
    expect(cleanBody({ text, html: null, subject: "RE: Your quote" }).text).toBe(
      "Can you beat this price?",
    );
  });

  it("cuts a very long body with a note", () => {
    const cleaned = cleanBody({ text: "a".repeat(20_000), html: null });
    expect(cleaned.truncated).toBe(true);
    expect(cleaned.text.endsWith("[…the rest of this email was cut]")).toBe(true);
  });
});

describe("classifyEmail", () => {
  const classify = async (raw: string, context: Partial<ClassifyContext> = {}) =>
    classifyEmail(await parseEmail(raw), { ...CONTEXT, ...context });

  it("answers a person writing to the business", async () => {
    expect(await classify(rawEmail())).toEqual({ kind: "customer" });
  });

  it("ignores out-of-office replies, by RFC 3834 header, by Precedence and by subject", async () => {
    expect(await classify(outOfOffice("<x@y>"))).toMatchObject({
      kind: "automatic",
      reason: "auto_reply",
    });
    expect(await classify(vacationResponder())).toMatchObject({
      kind: "automatic",
      reason: "auto_reply",
    });
    expect(await classify(rawEmail({ subject: "Out of Office: back Monday" }))).toMatchObject({
      kind: "automatic",
      reason: "auto_reply",
    });
    // "Auto-Submitted: no" is a person.
    expect(await classify(rawEmail({ headers: { "Auto-Submitted": "no" } }))).toEqual({
      kind: "customer",
    });
  });

  it("ignores newsletters and no-reply senders", async () => {
    expect(await classify(newsletter())).toMatchObject({ kind: "automatic", reason: "bulk" });
    expect(await classify(rawEmail({ from: "Billing <noreply@utility.example>" }))).toMatchObject({
      kind: "automatic",
      reason: "no_reply_sender",
    });
  });

  it("reads a bounce as a delivery report naming our message", async () => {
    const ours = "<1b4e28ba-2fa1-51d2-883f-0016d3cca427@acme-roofing.com>";
    expect(await classify(bounce(ours))).toMatchObject({
      kind: "bounce",
      failed: true,
      candidates: [ours],
    });
    expect(await classify(bounce(ours, "delayed"))).toMatchObject({
      kind: "bounce",
      failed: false,
    });
    const gmail = await classify(gmailBounce(ours));
    expect(gmail).toMatchObject({ kind: "bounce", failed: true });
    expect(gmail.kind === "bounce" ? gmail.candidates : []).toContain(ours);
  });

  it("treats mail from the business as its own, never as a customer", async () => {
    expect(await classify(internalMail())).toEqual({ kind: "business", reason: "own_domain" });
    expect(await classify(rawEmail({ from: INBOX }))).toEqual({
      kind: "business",
      reason: "inbox",
    });
    expect(
      await classify(rawEmail({ from: "x@acme-ops.example" }), {
        internalDomains: ["acme-ops.example"],
      }),
    ).toEqual({
      kind: "business",
      reason: "internal_domain",
    });
  });

  it("does not take a public mail domain for the business's own", async () => {
    const result = await classify(rawEmail({ from: "pat@gmail.com" }), {
      inboxAddresses: ["acmeroofing@gmail.com"],
    });
    expect(result).toEqual({ kind: "customer" });
  });

  it("drops our own mail coming back and never answers another installation", async () => {
    expect(await classify(rawEmail({ headers: { "X-HSRB-Loop": CONTEXT.loopToken } }))).toEqual({
      kind: "own_send",
    });
    expect(await classify(otherBot())).toEqual({ kind: "loop" });
  });

  it("ignores listed senders", async () => {
    expect(await classify(rawEmail(), { ignoredSenders: [CUSTOMER] })).toEqual({
      kind: "ignored_sender",
    });
  });

  it("answers the visitor of a contact form through Reply-To", async () => {
    const email = await parseEmail(contactForm());
    expect(classifyEmail(email, CONTEXT)).toEqual({ kind: "customer" });
    expect(replyAddressOf(email)).toEqual({
      address: "jordan.smith@example.net",
      name: "Jordan Smith",
    });
  });
});

describe("threading", () => {
  it("normalizes ids and lists", () => {
    expect(normalizeMessageId(" <a@b> ")).toBe("<a@b>");
    expect(normalizeMessageId("a@b")).toBe("<a@b>");
    expect(normalizeMessageId("")).toBeNull();
    expect(messageIdList("<a@b>\r\n <c@d> <a@b>")).toEqual(["<a@b>", "<c@d>"]);
  });

  it("builds the References of a reply", () => {
    expect(
      replyReferences({ messageId: "<3@x>", references: ["<1@x>", "<2@x>"], inReplyTo: "<2@x>" }),
    ).toEqual(["<1@x>", "<2@x>", "<3@x>"]);
    expect(replyReferences({ messageId: "<2@x>", references: [], inReplyTo: "<1@x>" })).toEqual([
      "<1@x>",
      "<2@x>",
    ]);
    const long = Array.from({ length: 30 }, (_, index) => `<${index}@x>`);
    const kept = replyReferences({ messageId: "<new@x>", references: long, inReplyTo: null });
    expect(kept).toHaveLength(20);
    expect(kept[0]).toBe("<0@x>");
    expect(kept.at(-1)).toBe("<new@x>");
  });

  it("prefixes Re: once and finds the base subject", () => {
    expect(replySubject("Roof leak")).toBe("Re: Roof leak");
    expect(replySubject("RE: Roof leak")).toBe("RE: Roof leak");
    expect(replySubject("")).toBe("Re: Your message");
    expect(baseSubject("Re: Fwd: RE: Roof leak")).toBe("Roof leak");
  });

  it("derives a stable Message-ID per send and a thread key per conversation", () => {
    const a = outboundMessageId({
      connectionId: "c1",
      idempotencyKey: "m1:0",
      domain: "acme-roofing.com",
    });
    expect(a).toMatch(
      /^<[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@acme-roofing\.com>$/,
    );
    expect(
      outboundMessageId({ connectionId: "c1", idempotencyKey: "m1:0", domain: "acme-roofing.com" }),
    ).toBe(a);
    expect(
      outboundMessageId({ connectionId: "c1", idempotencyKey: "m2:0", domain: "acme-roofing.com" }),
    ).not.toBe(a);
    expect(
      threadKeyOf({
        providerThreadId: "gmail:17f",
        messageId: "<m@x>",
        inReplyTo: null,
        references: [],
      }),
    ).toBe("gmail:17f");
    expect(
      threadKeyOf({
        providerThreadId: null,
        messageId: "<m@x>",
        inReplyTo: "<p@x>",
        references: ["<r@x>", "<p@x>"],
      }),
    ).toBe("mid:<r@x>");
    expect(
      threadKeyOf({ providerThreadId: null, messageId: "<m@x>", inReplyTo: null, references: [] }),
    ).toBe("mid:<m@x>");
  });
});

describe("composeEmail", () => {
  const base = {
    author: "bot" as const,
    greeting: "hi_first_name" as const,
    signOff: "Best,",
    signature: "Sam\nAcme Roofing\n(512) 555-0100",
    botName: "Sam",
    contactName: "MARIA LOPEZ",
    quote: null,
    timeZone: "America/Chicago",
  };

  it("replaces the engine's sign-off with the business's and adds the signature once", () => {
    const email = composeEmail({
      ...base,
      body: "Hi Maria,\n\nThanks for the details. How old is the roof?\n\nBest,\nSam",
    });
    expect(email.text).toBe(
      "Hi Maria,\n\nThanks for the details. How old is the roof?\n\nBest,\nSam\nAcme Roofing\n(512) 555-0100\n",
    );
    expect(email.text.match(/Sam/g)).toHaveLength(1);
    expect(email.html).toContain("<div>Hi Maria,</div>");
    expect(email.html).toContain("Best,<br>Sam<br>Acme Roofing<br>(512) 555-0100");
  });

  it("finds the words of a reply in the email composed from it (our sent copy without headers)", () => {
    const body = "Hi Maria,\n\nThanks for the details.\nHow old is the roof?\n\nBest,\nSam";
    const core = replyCore(body);
    expect(core).toBe("Thanks for the details. How old is the roof?");
    const sent = composeEmail({ ...base, greeting: "dear_full_name", body });
    const cleaned = cleanBody({ text: sent.text, html: null }).text.replace(/\s+/g, " ");
    expect(cleaned).toContain(core);
  });

  it("writes the greeting in the configured form", () => {
    expect(
      composeEmail({ ...base, greeting: "dear_full_name", body: "Hi Maria,\n\nThanks." }).text,
    ).toMatch(/^Dear Maria Lopez,/);
    expect(
      composeEmail({ ...base, greeting: "hello_first_name", body: "Hi there,\n\nThanks." }).text,
    ).toMatch(/^Hello Maria,/);
    expect(composeEmail({ ...base, contactName: null, body: "Hello,\n\nThanks." }).text).toMatch(
      /^Hi there,/,
    );
    // A first line that is not a greeting stays as it is (safety instructions come first).
    expect(
      composeEmail({ ...base, body: "If you smell gas, leave the house now.\n\nHi Maria," }).text,
    ).toMatch(/^If you smell gas/);
  });

  it("quotes the customer's message below, escaped in the HTML", () => {
    const email = composeEmail({
      ...base,
      body: "Hi Maria,\n\nGot it.\n\nThanks!",
      quote: {
        text: "The leak is <b>above</b> the sink.",
        fromName: "Maria Lopez",
        fromAddress: CUSTOMER,
        sentAt: new Date("2026-11-11T21:10:00Z"),
      },
    });
    expect(email.text).toContain(
      "On Wed, Nov 11, 2026 at 3:10 PM, Maria Lopez <maria.lopez@example.com> wrote:\n> The leak is <b>above</b> the sink.",
    );
    expect(email.html).toContain("&lt;b&gt;above&lt;/b&gt;");
    expect(email.html).not.toContain("<b>above</b>");
  });

  it("sends a person's reply as written", () => {
    const email = composeEmail({
      ...base,
      author: "human_agent",
      body: "Hi Maria, this is Dave. I'll stop by at 9.\n\nDave",
    });
    expect(email.text).toBe("Hi Maria, this is Dave. I'll stop by at 9.\n\nDave\n");
  });

  it("reads display names as names only when they look like one", () => {
    expect(personName("maria lopez")).toBe("Maria Lopez");
    expect(personName("McDonald O'Brien")).toBe("McDonald O'Brien");
    expect(personName("maria.lopez78")).toBeNull();
    expect(personName("Lopez, Maria")).toBeNull();
    expect(personName("Acme Customer Service Team Inbox")).toBeNull();
  });
});

describe("buildEmail", () => {
  it("writes the threading headers, our id and the loop marker, without header injection", async () => {
    const raw = await buildEmail({
      from: { address: INBOX, name: "Sam at Acme\r\nBcc: evil@example.com" },
      to: [{ address: CUSTOMER, name: null }],
      cc: [{ address: "bob@example.com", name: "Bob" }],
      subject: "Re: Roof leak\r\nBcc: evil@example.com",
      text: "Hi Maria",
      html: "<div>Hi Maria</div>",
      messageId: "<abc@acme-roofing.com>",
      inReplyTo: "<m1@example.com>",
      references: ["<m0@example.com>", "<m1@example.com>"],
      date: new Date("2026-11-11T21:00:00Z"),
      loopToken: "our-own-loop-token-123",
    });
    const parsed = await parseEmail(raw);
    expect(parsed.messageId).toBe("<abc@acme-roofing.com>");
    expect(parsed.inReplyTo).toBe("<m1@example.com>");
    expect(parsed.references).toEqual(["<m0@example.com>", "<m1@example.com>"]);
    expect(parsed.cc.map((item) => item.address)).toEqual(["bob@example.com"]);
    expect(parsed.headers.has("bcc")).toBe(false);
    expect(parsed.headers.get("x-hsrb-loop")).toEqual(["our-own-loop-token-123"]);
    expect(parsed.text?.trim()).toBe("Hi Maria");
    expect(classifyEmail(parsed, CONTEXT)).toEqual({ kind: "own_send" });
  });
});

describe("toInboundMessage", () => {
  it("builds the pipeline's message with the envelope and the cleaned text", async () => {
    const email = await parseEmail(
      rawEmail({ text: GMAIL_REPLY_TEXT, inReplyTo: "<r@acme>", references: "<m0@x> <r@acme>" }),
    );
    const message = toInboundMessage({
      email,
      inboxAddress: INBOX,
      externalMessageId: email.messageId!,
      threadKey: "mid:<m0@x>",
      sender: email.from!,
      body: cleanBody(email),
      attachments: [],
      receivedAt: new Date("2026-11-11T20:04:00Z"),
      metadata: { provider: "imap" },
    });
    expect(message).toMatchObject({
      channel: "email",
      externalAccountId: INBOX,
      externalThreadId: "mid:<m0@x>",
      sender: { externalId: CUSTOMER, email: CUSTOMER, displayName: "Maria Lopez" },
      kind: "text",
      text: "Thursday morning works. It's a two-story house, about 15 years old.",
      replyToExternalMessageId: "<r@acme>",
      email: {
        messageIdHeader: "<CAF1a2b3c4d5e6@mail.gmail.com>",
        inReplyTo: "<r@acme>",
        references: ["<m0@x>", "<r@acme>"],
      },
    });
    // A Date header later than the arrival does not count.
    const future = await parseEmail(rawEmail({ date: "Wed, 11 Nov 2099 14:03:00 -0600" }));
    expect(
      toInboundMessage({
        email: future,
        inboxAddress: INBOX,
        externalMessageId: "<f@x>",
        threadKey: null,
        sender: future.from!,
        body: cleanBody(future),
        attachments: [],
        receivedAt: new Date("2026-11-11T20:04:00Z"),
        metadata: {},
      }).sentAt,
    ).toBe("2026-11-11T20:04:00.000Z");
  });
});

describe("mail server addresses (SSRF)", () => {
  it("refuses private, loopback and link-local addresses, and IPv6 forms of them", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "::ffff:10.0.0.1",
      "fe80::1",
      "fd00::1",
      "0.0.0.0",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of ["8.8.8.8", "2606:4700:4700::1111", "172.32.0.1"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it("refuses private names, private answers, IP literals inside and odd ports", async () => {
    const resolve = (answers: Record<string, string[]>) => ({
      resolve: async (host: string) => answers[host] ?? [],
      isAllowedAddress: isPublicAddress,
      imapPorts: [993, 143],
      smtpPorts: [465, 587, 25, 2525],
      timeoutMs: 1000,
    });
    const policy = resolve({
      "mail.acme-roofing.com": ["203.0.114.10"],
      "evil.example": ["93.184.216.34", "10.0.0.1"],
      "meta.example": ["169.254.169.254"],
    });
    await expect(resolveMailHost("mail.acme-roofing.com", 993, "imap", policy)).resolves.toEqual({
      address: "203.0.114.10",
      servername: "mail.acme-roofing.com",
    });
    for (const [host, port, reason] of [
      ["localhost", 993, "host"],
      ["mail.internal", 993, "host"],
      ["intranet", 993, "host"],
      ["127.0.0.1", 993, "address"],
      ["[::1]", 993, "address"],
      ["169.254.169.254", 993, "address"],
      ["evil.example", 993, "address"],
      ["meta.example", 993, "address"],
      ["mail.acme-roofing.com", 22, "port"],
      ["missing.example", 993, "dns"],
    ] as const) {
      const error = await resolveMailHost(host, port, "imap", policy).catch(
        (caught: unknown) => caught,
      );
      expect(error, host).toBeInstanceOf(MailHostError);
      expect((error as MailHostError).reason, host).toBe(reason);
    }
    await expect(
      resolveMailHost("mail.acme-roofing.com", 587, "smtp", policy),
    ).resolves.toBeDefined();
    await expect(resolveMailHost("mail.acme-roofing.com", 993, "smtp", policy)).rejects.toThrow(
      /standard SMTP port/,
    );
  });
});
