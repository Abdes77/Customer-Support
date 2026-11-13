/** Test helpers of `@repo/integrations`: fakes of the CRMs, a local webhook receiver, a sample payload. */
export {
  type CannedFailure,
  createFakeCrms,
  type FakeCrms,
  type RecordedRequest,
} from "./fake-crms";
export { sampleLeadPayload } from "./payload";
export { type ReceivedWebhook, startWebhookReceiver, type WebhookReceiver } from "./receiver";
