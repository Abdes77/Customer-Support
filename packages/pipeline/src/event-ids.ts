/**
 * Deterministic event ids. The job platform drops a second event with the same id for 24
 * hours, so emitting twice for the same fact (a retried webhook, a retried step) starts one
 * run. Ids are derived from the entity, never from the clock, except where a deliberate
 * second run is wanted (the sweeper's re-emit of a stuck send).
 */
export const receivedEventId = (messageId: string) => `msg-received-${messageId}`;
export const sendEventId = (messageId: string) => `msg-send-${messageId}`;
export const sendSweepEventId = (messageId: string, minute: number) =>
  `msg-send-${messageId}-sweep-${minute}`;
export const sendFailedEventId = (messageId: string) => `msg-send-failed-${messageId}`;
export const takeoverStartedEventId = (lockId: string) => `takeover-started-${lockId}`;
