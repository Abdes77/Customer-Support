import type { ChannelCapabilities, MessagingWindowState } from "@repo/core";

const HOUR_MS = 3_600_000;

/**
 * Whether a free-form message may be sent now, from the channel's window policy and the time
 * the customer last wrote. A person's reply (`sentByHuman`) gets the extended human-agent
 * window where the platform has one (Messenger and Instagram: seven days with the tag).
 */
export function messagingWindow(
  capabilities: Pick<ChannelCapabilities, "messagingWindow">,
  lastInboundAt: Date | null,
  now: Date,
  sentByHuman = false,
): MessagingWindowState {
  const policy = capabilities.messagingWindow;
  if (policy.type === "none") return { open: true, closesAt: null };
  if (lastInboundAt === null) return { open: false, closesAt: null };
  const hours =
    sentByHuman && policy.outside === "human_agent_tag" && policy.humanAgentHours !== null
      ? policy.humanAgentHours
      : policy.hours;
  const closesAt = new Date(lastInboundAt.getTime() + hours * HOUR_MS);
  return { open: now.getTime() < closesAt.getTime(), closesAt: closesAt.toISOString() };
}
