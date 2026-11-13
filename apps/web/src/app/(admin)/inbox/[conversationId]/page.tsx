import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  agencyRoleOf,
  type ConversationDetail,
  findVisibleConversation,
  getConversationDetail,
  getDatabase,
  listAgencyStaff,
  markConversationRead,
} from "@repo/db";

import {
  acknowledgeEscalationAction,
  cancelFollowUpsAction,
  releaseAction,
  takeOverAction,
} from "@/app/(admin)/_actions/inbox";
import { ActionButton } from "@/components/inbox/action-button";
import {
  AUTHOR_LABELS,
  channelLabel,
  formatDateTime,
  LeadStatusBadge,
  ROUTING_LABELS,
  ScoreBadge,
} from "@/components/inbox/labels";
import { LiveRefresh } from "@/components/inbox/live-refresh";
import { AssignForm, NotesPanel } from "@/components/inbox/notes";
import { ReplyBox } from "@/components/inbox/reply-box";
import { ReportText } from "@/components/inbox/report-text";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { adminLogger } from "@/server/admin";
import { requireAccess, userDatabase } from "@/server/auth";
import { getHandoff } from "@/server/handoff";
import { businessPermissions } from "@/server/portal";

export const metadata: Metadata = { title: "Conversation" };
export const dynamic = "force-dynamic";

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "Not known";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value.replaceAll("_", " ");
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function criterionLabel(key: string): string {
  const text = key.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const TAKEOVER_SOURCE: Readonly<Record<string, string>> = {
  admin_panel: "in the admin panel",
  provider_inbox: "from the channel's own inbox",
  rule: "by the bot's handoff rules",
};

const STATUS_WORDS: Readonly<Record<string, string>> = {
  queued: "Queued",
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
  superseded: "Not sent",
};

function Messages({ detail }: { readonly detail: ConversationDetail }) {
  if (detail.messages.length === 0) {
    return <p className="text-sm text-slate-500">No messages yet.</p>;
  }
  return (
    <ol className="space-y-3" aria-label="Messages">
      {detail.messages.map((message) => {
        const inbound = message.direction === "inbound";
        const human = message.author === "human_agent";
        return (
          <li
            key={message.id}
            data-testid="message"
            data-author={message.author}
            className={cn("flex flex-col", inbound ? "items-start" : "items-end")}
          >
            <div
              className={cn(
                "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm shadow-sm",
                inbound
                  ? "rounded-bl-sm border border-slate-200 bg-white text-slate-900"
                  : human
                    ? "rounded-br-sm bg-emerald-700 text-white"
                    : "rounded-br-sm bg-blue-700 text-white",
                message.status === "superseded" && "opacity-60",
              )}
            >
              {message.text !== null && (
                <p className="break-words whitespace-pre-wrap">{message.text}</p>
              )}
              {message.attachments.length > 0 && (
                <ul className="mt-2 space-y-2">
                  {message.attachments.map((attachment) => (
                    <li key={attachment.id}>
                      {attachment.stored ? (
                        attachment.kind === "image" ? (
                          <a
                            href={`/api/inbox/attachments/${attachment.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element -- served by our own authorized route */}
                            <img
                              src={`/api/inbox/attachments/${attachment.id}`}
                              alt={attachment.fileName ?? "Photo from the customer"}
                              className="max-h-48 rounded-md border border-slate-200 bg-white"
                            />
                          </a>
                        ) : (
                          <a
                            href={`/api/inbox/attachments/${attachment.id}`}
                            className="underline"
                            rel="noopener noreferrer"
                          >
                            {attachment.fileName ?? `${attachment.kind} file`}
                          </a>
                        )
                      ) : (
                        <span className="italic">
                          {attachment.fileName ?? `A ${attachment.kind}`} (not available)
                        </span>
                      )}
                      {attachment.analysis !== null && (
                        <p className="mt-1 text-xs opacity-80">
                          Bot&apos;s look: {attachment.analysis}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="mt-1 px-1 text-xs text-slate-500">
              {inbound
                ? "Customer"
                : human
                  ? `${message.authorUserName ?? "Team"}`
                  : (AUTHOR_LABELS[message.author] ?? message.author)}
              {" · "}
              {formatDateTime(message.sentAt ?? message.createdAt)}
              {!inbound && ` · ${STATUS_WORDS[message.status] ?? message.status}`}
              {message.errorMessage !== null && ` · ${message.errorMessage}`}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One conversation (C16): the messages, the lead panel, human takeover with a reply box,
 * release back to the bot, and (agency staff) assignment, internal notes, emergencies and
 * follow-ups. A conversation the person may not see is "not found", whatever the reason.
 */
export default async function ConversationPage({
  params,
}: {
  readonly params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const session = await requireAccess(`/inbox/${encodeURIComponent(conversationId)}`);
  const found = await userDatabase(session.user).run((ctx) =>
    findVisibleConversation(ctx, conversationId),
  );
  if (found === null) notFound();
  const tenant = { agencyId: found.agencyId, businessId: found.businessId };
  const permissions = await businessPermissions(session, tenant);
  if (!permissions.viewConversations) notFound();
  const detail = await userDatabase(session.user).run((ctx) =>
    getConversationDetail(ctx, found.id, {
      reports: permissions.viewReports,
      notes: permissions.staff,
    }),
  );
  if (detail === null) notFound();

  if (detail.unreadCount > 0) {
    await getDatabase()
      .forBusiness(tenant.businessId, { agencyId: tenant.agencyId })
      .run((ctx) => markConversationRead(ctx, detail.id))
      .catch((error: unknown) => adminLogger.warn("inbox.mark_read_failed", { error }));
  }

  const handoff = getHandoff();
  const takeover = await handoff.takeoverState(tenant, detail.id);
  const staffExtras = permissions.staff
    ? await Promise.all([
        handoff.listEscalations(tenant, { limit: 50 }),
        handoff.listFollowUps(tenant, detail.id),
        userDatabase(session.user).run((ctx) => listAgencyStaff(ctx, tenant.agencyId)),
      ])
    : null;
  const escalations = staffExtras?.[0].filter((item) => item.conversationId === detail.id) ?? [];
  const followUps = staffExtras?.[1] ?? [];
  const team = staffExtras?.[2] ?? [];
  const isAdmin = agencyRoleOf(session.access, tenant.agencyId) === "agency_admin";
  const holder = takeover.active && takeover.userId === session.user.id;
  const label = channelLabel(detail.channel);
  const plannedFollowUps = followUps.filter((item) => item.status === "scheduled");

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm">
            <Link href={"/inbox"} className="font-medium text-blue-700 hover:underline">
              ← Inbox
            </Link>
          </p>
          <h1 className="mt-1 text-2xl font-semibold break-words text-slate-900">
            {detail.contact.name ?? "Unknown customer"}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <span>{label}</span>
            <span>· {detail.businessName}</span>
            {detail.subject !== null && <span className="break-all">· {detail.subject}</span>}
            {detail.status === "closed" && <Badge>Closed</Badge>}
            {detail.contact.optedOut && <Badge tone="red">Opted out</Badge>}
          </p>
        </div>
        <LiveRefresh
          channel={`conversation:${detail.id}`}
          pollSeconds={4}
          tables={[
            { table: "messages", filter: `conversation_id=eq.${detail.id}` },
            { table: "takeover_locks", filter: `conversation_id=eq.${detail.id}` },
            { table: "conversations", filter: `id=eq.${detail.id}` },
          ]}
        />
      </div>

      {escalations.some((item) => item.status === "active") && (
        <Callout tone="danger" title="Emergency in progress">
          The escalation chain is calling the business&apos;s contacts. Acknowledge it below once
          someone is handling it.
        </Callout>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader
              title="Takeover"
              description={
                takeover.active ? (
                  <span data-testid="takeover-state">
                    {holder
                      ? "You hold this conversation. The bot stays silent until you release it."
                      : takeover.userId === null
                        ? `The bot handed this conversation over ${TAKEOVER_SOURCE[takeover.source ?? ""] ?? ""}. Nobody holds it yet.`
                        : `${detail.takeover.userName ?? "A team member"} holds this conversation. The bot stays silent.`}
                    {takeover.releasesAt !== null &&
                      ` If nobody writes, the bot takes it back at ${formatDateTime(takeover.releasesAt)}.`}
                  </span>
                ) : (
                  <span data-testid="takeover-state">The bot is answering this conversation.</span>
                )
              }
              actions={
                permissions.reply ? (
                  <>
                    {!holder && (takeover.userId === null || !takeover.active) && (
                      <ActionButton
                        action={takeOverAction}
                        input={{ conversationId: detail.id }}
                        variant="primary"
                        showResult={false}
                      >
                        Take over
                      </ActionButton>
                    )}
                    {takeover.active && (holder || permissions.staff) && (
                      <ActionButton
                        action={releaseAction}
                        input={{ conversationId: detail.id }}
                        showResult={false}
                      >
                        Release to the bot
                      </ActionButton>
                    )}
                  </>
                ) : undefined
              }
            />
            {holder && (
              <CardBody>
                <ReplyBox conversationId={detail.id} channelLabel={label} />
              </CardBody>
            )}
          </Card>

          <Card>
            <CardHeader title="Messages" />
            <CardBody className="bg-slate-50">
              <Messages detail={detail} />
            </CardBody>
          </Card>
        </div>

        <aside className="min-w-0 space-y-4" aria-label="Lead and details">
          <Card>
            <CardHeader title="Customer" />
            <CardBody>
              <dl className="space-y-1 text-sm">
                {(
                  [
                    ["Name", detail.contact.name],
                    ["Phone", detail.contact.phone],
                    ["Email", detail.contact.email],
                    ["Address", detail.contact.address],
                  ] as const
                ).map(([term, value]) =>
                  value === null ? null : (
                    <div key={term} className="flex gap-2">
                      <dt className="w-16 shrink-0 text-slate-500">{term}</dt>
                      <dd className="min-w-0 break-words text-slate-900">{value}</dd>
                    </div>
                  ),
                )}
              </dl>
            </CardBody>
          </Card>

          <Card data-testid="lead-panel">
            <CardHeader
              title="Lead"
              actions={
                detail.lead === null ? undefined : (
                  <>
                    <ScoreBadge score={detail.lead.score} band={detail.lead.band} />
                    <LeadStatusBadge status={detail.lead.status} />
                  </>
                )
              }
            />
            <CardBody className="space-y-4">
              {detail.lead === null ? (
                <p className="text-sm text-slate-500">No lead yet.</p>
              ) : (
                <>
                  {detail.lead.routingOutcome !== null && (
                    <p className="text-sm text-slate-700">
                      Routing:{" "}
                      <strong>
                        {ROUTING_LABELS[
                          detail.lead.routingOutcome as keyof typeof ROUTING_LABELS
                        ] ?? detail.lead.routingOutcome}
                      </strong>
                    </p>
                  )}
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">Criteria</h3>
                    {detail.lead.fields.length === 0 ? (
                      <p className="text-sm text-slate-500">Nothing known yet.</p>
                    ) : (
                      <dl className="mt-1 space-y-2 text-sm">
                        {detail.lead.fields.map((field) => (
                          <div key={field.key}>
                            <dt className="text-slate-500">{criterionLabel(field.key)}</dt>
                            <dd className="break-words text-slate-900">
                              {valueText(field.value)}{" "}
                              <span className="text-xs text-slate-500">
                                ({Math.round(field.confidence * 100)}% sure)
                              </span>
                              {field.evidence !== null && (
                                <span className="block text-xs text-slate-500 italic">
                                  “{field.evidence}”
                                </span>
                              )}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                  {permissions.viewReports && (
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900">Report</h3>
                      {detail.lead.report === null ? (
                        <p className="text-sm text-slate-500">No report yet.</p>
                      ) : (
                        <div className="mt-1 text-sm text-slate-800">
                          <p className="font-medium break-words">{detail.lead.report.summary}</p>
                          <div className="mt-2">
                            <ReportText markdown={detail.lead.report.markdown} />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {detail.lead.routing.length > 0 && (
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900">Routing history</h3>
                      <ul className="mt-1 space-y-1 text-xs text-slate-600">
                        {detail.lead.routing.map((decision, index) => (
                          <li key={index}>
                            {formatDateTime(decision.decidedAt)}:{" "}
                            {ROUTING_LABELS[decision.outcome as keyof typeof ROUTING_LABELS] ??
                              decision.outcome}{" "}
                            at {Math.round(decision.score)} ({decision.band})
                            {decision.reasons.length > 0 && ` · ${decision.reasons.join("; ")}`}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
              {detail.bookings.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">Meetings</h3>
                  <ul className="mt-1 space-y-1 text-sm text-slate-700">
                    {detail.bookings.map((booking) => (
                      <li key={booking.id}>
                        {booking.startsAt === null ? "Link sent" : formatDateTime(booking.startsAt)}{" "}
                        · {booking.status}
                        {booking.title !== null && (
                          <span className="block text-xs">{booking.title}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardBody>
          </Card>

          {permissions.staff && (
            <>
              <Card>
                <CardHeader title="Team" />
                <CardBody className="space-y-4">
                  <AssignForm
                    conversationId={detail.id}
                    assignedUserId={detail.assignedUserId}
                    staff={team.map((person) => ({ id: person.id, name: person.name }))}
                  />
                  <div>
                    <h3 className="mb-2 text-sm font-semibold text-slate-900">Internal notes</h3>
                    <NotesPanel
                      conversationId={detail.id}
                      currentUserId={session.user.id}
                      isAdmin={isAdmin}
                      notes={detail.notes.map((note) => ({
                        ...note,
                        when: formatDateTime(note.createdAt),
                      }))}
                    />
                  </div>
                </CardBody>
              </Card>

              {escalations.length > 0 && (
                <Card>
                  <CardHeader title="Emergencies" />
                  <CardBody className="space-y-3">
                    {escalations.map((item) => (
                      <div key={item.id} className="text-sm">
                        <p className="font-medium text-slate-900">
                          {criterionLabel(item.emergencyClass)}{" "}
                          <Badge tone={item.status === "active" ? "red" : "neutral"}>
                            {item.status}
                          </Badge>
                        </p>
                        <p className="text-xs text-slate-600">
                          Started {formatDateTime(item.startedAt)}
                          {item.acknowledgedAt !== null &&
                            ` · acknowledged ${formatDateTime(item.acknowledgedAt)}${item.acknowledgedBy === null ? "" : ` by ${item.acknowledgedBy}`}`}
                        </p>
                        {item.alerts.length > 0 && (
                          <ul className="mt-1 text-xs text-slate-600">
                            {item.alerts.map((alert) => (
                              <li key={alert.id}>
                                {alert.contactName ?? "Contact"} by {alert.channel}: {alert.status}
                              </li>
                            ))}
                          </ul>
                        )}
                        {item.status === "active" && (
                          <div className="mt-2">
                            <ActionButton
                              action={acknowledgeEscalationAction}
                              input={{ conversationId: detail.id, escalationId: item.id }}
                              variant="danger"
                            >
                              Acknowledge
                            </ActionButton>
                          </div>
                        )}
                      </div>
                    ))}
                  </CardBody>
                </Card>
              )}

              <Card>
                <CardHeader title="Follow-ups" />
                <CardBody className="space-y-2 text-sm">
                  {plannedFollowUps.length === 0 ? (
                    <p className="text-slate-500">None planned.</p>
                  ) : (
                    <>
                      <ul className="space-y-1 text-slate-700">
                        {plannedFollowUps.map((item) => (
                          <li key={item.id}>
                            {formatDateTime(item.runAt)}
                            {item.nudge !== null && ` · nudge ${item.nudge}`}
                          </li>
                        ))}
                      </ul>
                      <ActionButton
                        action={cancelFollowUpsAction}
                        input={{ conversationId: detail.id }}
                      >
                        Stop follow-ups
                      </ActionButton>
                    </>
                  )}
                </CardBody>
              </Card>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
