import { describe, expect, it } from "vitest";

import {
  CHANNEL_CAPABILITIES,
  CHANNEL_IDS,
  type ChannelCapabilities,
  NormalizedInboundMessage,
  ParsedWebhook,
} from "./channel";

const textMessage = {
  channel: "whatsapp",
  externalAccountId: "106540352242922",
  externalMessageId: "wamid.HBgLMTU1NTU1NTAxMjMVAgASGBQzQTdCNUQ4",
  externalThreadId: null,
  sender: { externalId: "15555550123", displayName: "Pat", phone: "+15555550123", email: null },
  sentAt: "2026-11-11T18:30:00.000Z",
  kind: "text",
  text: "Hi, my water heater is leaking",
  attachments: [],
  location: null,
  interactiveReply: null,
  reaction: null,
  replyToExternalMessageId: null,
  email: null,
  metadata: {},
} as const;

describe("NormalizedInboundMessage", () => {
  it("accepts a plain text message", () => {
    expect(NormalizedInboundMessage.parse(textMessage)).toEqual(textMessage);
  });

  it("accepts a photo with a provider media reference", () => {
    const parsed = NormalizedInboundMessage.parse({
      ...textMessage,
      kind: "media",
      text: "here is the panel",
      attachments: [
        {
          kind: "image",
          mimeType: "image/jpeg",
          fileName: null,
          sizeBytes: 482_113,
          source: { type: "provider_media", mediaId: "1234567890" },
        },
      ],
    });
    expect(parsed.attachments[0]?.source).toEqual({
      type: "provider_media",
      mediaId: "1234567890",
    });
  });

  it("accepts an email with its threading headers", () => {
    const parsed = NormalizedInboundMessage.parse({
      ...textMessage,
      channel: "email",
      externalAccountId: "office@acmeroofing.example",
      externalMessageId: "<CAF1234@mail.example.com>",
      externalThreadId: "thread-18c2",
      sender: {
        externalId: "pat@example.com",
        displayName: "Pat Doe",
        phone: null,
        email: "pat@example.com",
      },
      email: {
        messageIdHeader: "<CAF1234@mail.example.com>",
        inReplyTo: null,
        references: [],
        subject: "Roof leak estimate",
        from: { address: "pat@example.com", name: "Pat Doe" },
        to: [{ address: "office@acmeroofing.example", name: null }],
        cc: [],
      },
    });
    expect(parsed.email?.subject).toBe("Roof leak estimate");
  });

  it.each([
    ["an empty provider message id", { externalMessageId: "" }],
    ["an unknown channel", { channel: "sms" }],
    ["a timestamp without an offset", { sentAt: "2026-11-11 18:30:00" }],
    [
      "an out-of-range location",
      { location: { latitude: 120, longitude: 0, name: null, address: null } },
    ],
    [
      "an attachment source we cannot fetch",
      {
        attachments: [
          {
            kind: "image",
            mimeType: null,
            fileName: null,
            sizeBytes: null,
            source: { type: "ftp" },
          },
        ],
      },
    ],
  ])("rejects %s", (_label, override) => {
    expect(NormalizedInboundMessage.safeParse({ ...textMessage, ...override }).success).toBe(false);
  });

  it("requires adapters to state every field, so nothing is silently dropped", () => {
    const { metadata: _metadata, ...withoutMetadata } = textMessage;
    expect(NormalizedInboundMessage.safeParse(withoutMetadata).success).toBe(false);
  });
});

describe("ParsedWebhook", () => {
  it("carries messages, delivery statuses and signals together", () => {
    const parsed = ParsedWebhook.parse({
      messages: [textMessage],
      statuses: [
        {
          channel: "whatsapp",
          externalAccountId: "106540352242922",
          externalMessageId: "wamid.OUT1",
          status: "delivered",
          occurredAt: "2026-11-11T18:31:00.000Z",
          error: null,
        },
      ],
      signals: [
        {
          type: "human_agent_replied",
          channel: "messenger",
          externalAccountId: "page-1",
          contactExternalId: "psid-1",
          externalMessageId: "m_echo_1",
          text: null,
          occurredAt: "2026-11-11T18:32:00.000Z",
        },
      ],
    });
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.statuses[0]?.status).toBe("delivered");
    expect(parsed.signals[0]?.type).toBe("human_agent_replied");
  });
});

describe("CHANNEL_CAPABILITIES", () => {
  const entries = Object.entries(CHANNEL_CAPABILITIES) as [string, ChannelCapabilities][];

  it("covers every channel", () => {
    expect(Object.keys(CHANNEL_CAPABILITIES).sort()).toEqual([...CHANNEL_IDS].sort());
  });

  it("is internally consistent", () => {
    for (const [channel, caps] of entries) {
      expect(caps.maxTextLength, channel).toBeGreaterThan(0);
      if (caps.format === "email") {
        expect(caps.quickReplies, channel).toBeNull();
        expect(caps.typingIndicator, channel).toBe(false);
        expect(caps.threading, channel).toBe("threads");
      }
      if (caps.messagingWindow.type === "rolling") {
        expect(caps.messagingWindow.hours, channel).toBeGreaterThan(0);
        if (caps.messagingWindow.outside === "human_agent_tag") {
          expect(caps.messagingWindow.humanAgentHours, channel).toBeGreaterThan(
            caps.messagingWindow.hours,
          );
        }
      }
    }
  });

  it("gives every Meta messaging channel a 24-hour window", () => {
    for (const channel of ["whatsapp", "instagram", "messenger"] as const) {
      expect(CHANNEL_CAPABILITIES[channel].messagingWindow).toMatchObject({
        type: "rolling",
        hours: 24,
      });
    }
  });
});
