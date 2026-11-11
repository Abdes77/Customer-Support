import { EVENT_CATALOG, type EventName, type EventPayload, ValidationError } from "@repo/core";

/**
 * An event on its way to the job platform. `id` makes sending idempotent: Inngest drops a
 * second event with the same id for 24 hours, and so does the local runner. Derive it from
 * the entity the event is about (`msg-received-<messageId>`), never from the clock.
 */
export interface JobEvent<TName extends EventName = EventName> {
  readonly name: TName;
  readonly id: string;
  readonly data: EventPayload<TName>;
}

/** Any event, for lists that mix event names. */
export type AnyJobEvent = { [TName in EventName]: JobEvent<TName> }[EventName];

/** Sends events to whichever runner executes the jobs. */
export interface EventSender {
  send(events: readonly AnyJobEvent[]): Promise<void>;
}

/**
 * Builds an event and checks its payload against the catalogue, so a bad payload fails where
 * it is created rather than in a job run later. Payloads carry ids and classifications only.
 */
export function jobEvent<TName extends EventName>(
  name: TName,
  id: string,
  data: EventPayload<TName>,
): JobEvent<TName> {
  const parsed = EVENT_CATALOG[name].safeParse(data);
  if (!parsed.success) {
    throw new ValidationError(`Invalid payload for event ${name}.`, {
      details: { issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
    });
  }
  if (id.length === 0 || id.length > 200) {
    throw new ValidationError("An event id must be 1 to 200 characters.");
  }
  return { name, id, data: parsed.data as EventPayload<TName> };
}

/** An `EventSender` that keeps what it is given, for tests. */
export class RecordingEventSender implements EventSender {
  readonly sent: AnyJobEvent[] = [];
  /** When set, the next `send` throws this error once (to test emit failures). */
  failNext: Error | null = null;

  async send(events: readonly AnyJobEvent[]): Promise<void> {
    if (this.failNext !== null) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    this.sent.push(...events);
  }

  named<TName extends EventName>(name: TName): JobEvent<TName>[] {
    return this.sent.filter((event): event is JobEvent<TName> & AnyJobEvent => event.name === name);
  }
}
