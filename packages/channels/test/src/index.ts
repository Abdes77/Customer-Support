/**
 * @repo/channel-test (owner: C3)
 *
 * The "test" channel adapter: signed JSON webhooks, sends delivered to a pluggable transport.
 * Used by the dev chat page, the onboarding wizard's test chat (C15), the pipeline tests and
 * the end-to-end tests. It takes the same path through the pipeline as every real channel.
 */
export {
  createTestChannelAdapter,
  type TestChannelAdapter,
  type TestChannelAdapterOptions,
} from "./adapter";
export {
  MemoryTestTransport,
  type TestChannelTransport,
  type TestDelivery,
  type TestSignal,
} from "./transport";
export {
  buildTestWebhookRequest,
  signTestWebhook,
  TEST_SIGNATURE_HEADER,
  TEST_SIGNATURE_TOLERANCE_SECONDS,
  TEST_TIMESTAMP_HEADER,
  testAccountIdFor,
  TestWebhookBody,
  TestWebhookEvent,
  verifyTestWebhook,
} from "./webhook";
