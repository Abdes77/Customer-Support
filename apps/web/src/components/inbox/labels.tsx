import type { ChannelId, LeadStatus, RoutingOutcome } from "@repo/core";

import { Badge, type BadgeTone } from "@/components/ui/badge";

/** Plain names for the vocabularies the operational screens show (C16). */

export const CHANNEL_LABELS: Readonly<Record<ChannelId, string>> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
  widget: "Website chat",
  email: "Email",
  test: "Test chat",
};

export const LEAD_STATUS_LABELS: Readonly<Record<LeadStatus, string>> = {
  new: "New",
  qualifying: "Qualifying",
  qualified: "Qualified",
  meeting_requested: "Meeting requested",
  meeting_booked: "Meeting booked",
  handed_off: "Handed off",
  disqualified: "Not a fit",
};

const LEAD_STATUS_TONES: Readonly<Record<LeadStatus, BadgeTone>> = {
  new: "neutral",
  qualifying: "blue",
  qualified: "green",
  meeting_requested: "violet",
  meeting_booked: "green",
  handed_off: "amber",
  disqualified: "neutral",
};

export const ROUTING_LABELS: Readonly<Record<RoutingOutcome, string>> = {
  book_meeting: "Book a meeting",
  contact_later: "We'll contact you",
  disqualify: "Polite no",
};

export const AUTHOR_LABELS: Readonly<Record<string, string>> = {
  customer: "Customer",
  bot: "Bot",
  human_agent: "Team",
  system: "System",
};

export function channelLabel(channel: string): string {
  return (CHANNEL_LABELS as Record<string, string>)[channel] ?? channel;
}

export function LeadStatusBadge({ status }: { readonly status: string | null }) {
  if (status === null) return null;
  const known = status as LeadStatus;
  return (
    <Badge tone={LEAD_STATUS_TONES[known] ?? "neutral"}>
      {LEAD_STATUS_LABELS[known] ?? status}
    </Badge>
  );
}

export function ScoreBadge({
  score,
  band,
}: {
  readonly score: number | null;
  readonly band?: string | null;
}) {
  if (score === null) return null;
  const tone: BadgeTone = score >= 70 ? "green" : score >= 40 ? "amber" : "neutral";
  return (
    <Badge tone={tone}>
      {Math.round(score)}
      {band != null && band !== "" ? ` · ${band}` : ""}
    </Badge>
  );
}

const dateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

/** A date and time the same on the server and in the browser (UTC, stated). */
export function formatDateTime(iso: string | null): string {
  if (iso === null) return "";
  return dateTime.format(new Date(iso));
}

/** "3 min ago", "2 h ago", "5 d ago" from a fixed `now`. */
export function ago(iso: string | null, now: number): string {
  if (iso === null) return "";
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** The server's clock for "… ago" labels, read once per render of a list. */
export function currentTime(): number {
  return Date.now();
}
