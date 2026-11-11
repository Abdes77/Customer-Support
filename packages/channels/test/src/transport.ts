import { randomUUID } from "node:crypto";

import type {
  ConversationId,
  IsoDateTime,
  OutboundMessage,
  SendFailure,
  SendResult,
} from "@repo/core";

/**
 * Where the test channel "delivers" what the bot sends. There is no provider behind the test
 * channel, so delivery is a call to a transport. The default keeps deliveries in memory
 * (the dev chat page reads replies from the database, not from here); tests inject one to
 * inspect deliveries and to make sends fail.
 */
export interface TestDelivery {
  readonly externalMessageId: string;
  readonly connectionId: string;
  readonly conversationId: ConversationId;
  readonly recipientExternalId: string;
  readonly message: OutboundMessage;
  readonly idempotencyKey: string;
  readonly sentByHuman: boolean;
  readonly deliveredAt: IsoDateTime;
}

export interface TestSignal {
  readonly type: "typing_on" | "typing_off" | "read";
  readonly conversationId: ConversationId;
  readonly externalMessageId: string | null;
  readonly at: IsoDateTime;
}

export interface TestChannelTransport {
  deliver(delivery: Omit<TestDelivery, "externalMessageId" | "deliveredAt">): Promise<SendResult>;
  signal(signal: TestSignal): Promise<void>;
  /** Bytes of a media item the "provider" holds, for `fetchAttachment`. */
  fetchMedia(mediaId: string): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }>;
}

const MAX_KEPT = 1000;

/**
 * In-memory transport. Idempotent like a provider that accepts idempotency keys: a second
 * delivery with the same key returns the first one's id and is not recorded again.
 */
export class MemoryTestTransport implements TestChannelTransport {
  readonly deliveries: TestDelivery[] = [];
  readonly signals: TestSignal[] = [];
  readonly media = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  /** Every call to `deliver`, including duplicates and failures. */
  attempts = 0;
  private readonly byKey = new Map<string, string>();
  private readonly failures: SendFailure[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** The next `count` deliveries fail with `failure` (default: a retryable 503). */
  failNext(count: number, failure: Partial<SendFailure> = {}): void {
    for (let index = 0; index < count; index += 1) {
      this.failures.push({
        code: "503",
        message: "Test channel unavailable",
        retryable: true,
        retryAfterSeconds: null,
        windowClosed: false,
        ...failure,
      });
    }
  }

  async deliver(
    delivery: Omit<TestDelivery, "externalMessageId" | "deliveredAt">,
  ): Promise<SendResult> {
    this.attempts += 1;
    const failure = this.failures.shift();
    if (failure !== undefined) return { ok: false, error: failure };
    const deliveredAt = this.now().toISOString();
    const known = this.byKey.get(delivery.idempotencyKey);
    if (known !== undefined) return { ok: true, externalMessageId: known, sentAt: deliveredAt };
    const externalMessageId = `test-out-${randomUUID()}`;
    this.byKey.set(delivery.idempotencyKey, externalMessageId);
    this.deliveries.push({ ...delivery, externalMessageId, deliveredAt });
    if (this.deliveries.length > MAX_KEPT)
      this.deliveries.splice(0, this.deliveries.length - MAX_KEPT);
    return { ok: true, externalMessageId, sentAt: deliveredAt };
  }

  async signal(signal: TestSignal): Promise<void> {
    this.signals.push(signal);
    if (this.signals.length > MAX_KEPT) this.signals.splice(0, this.signals.length - MAX_KEPT);
  }

  async fetchMedia(mediaId: string) {
    const item = this.media.get(mediaId);
    if (item === undefined) throw new Error(`Unknown test media: ${mediaId}`);
    return item;
  }

  /** Texts delivered to one conversation, in delivery order. */
  textsFor(conversationId: string): string[] {
    return this.deliveries
      .filter((delivery) => delivery.conversationId === conversationId)
      .map((delivery) =>
        delivery.message.kind === "text" || delivery.message.kind === "email"
          ? delivery.message.text
          : `[${delivery.message.kind}]`,
      );
  }
}
