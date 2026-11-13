import type { Metadata, Route } from "next";
import Link from "next/link";

import { agencyRoleOf, getDatabase, listLeads } from "@repo/db";
import type { DeliveryView } from "@repo/integrations";
import { loadSettings } from "@repo/settings/server";

import {
  calendarDisconnectAction,
  crmDisconnectAction,
  crmTestAction,
  deliveryRetryAction,
  webhookTestAction,
} from "@/app/(admin)/_actions/connections";
import { OAuthStartButton } from "@/components/connections/client";
import {
  CalendarPicker,
  CalendlyTokenForm,
  CrmConfigForm,
  CrmKeyForm,
  MappingPreview,
  WebhookSecret,
} from "@/components/connections/integrations-client";
import {
  ConnectionBadge,
  ConnectionError,
  NotOnThisDeployment,
} from "@/components/connections/status";
import { ReadinessBadge } from "@/components/business/status";
import { ActionButton } from "@/components/inbox/action-button";
import { formatDateTime } from "@/components/inbox/labels";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireBusinessPage } from "@/server/admin";
import { userDatabase } from "@/server/auth";
import { getHandoff } from "@/server/handoff";
import { getIntegrations } from "@/server/integrations";
import { getScheduling } from "@/server/scheduling";

export const metadata: Metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

const RESULTS: Readonly<Record<string, { tone: "success" | "warning" | "danger"; text: string }>> =
  {
    connected: { tone: "success", text: "Connected." },
    cancelled: { tone: "warning", text: "The sign-in was cancelled. Nothing was connected." },
    failed: { tone: "danger", text: "The connection could not be made. Try again." },
    in_use: { tone: "danger", text: "That account is connected to another business." },
  };

const CALENDAR_LABEL: Readonly<Record<string, string>> = {
  google_calendar: "Google Calendar",
  outlook_calendar: "Outlook Calendar",
  calendly: "Calendly",
};

function primitiveConfig(
  config: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      out[key] = value as string | number | boolean | null;
    }
  }
  return out;
}

function Deliveries({
  businessId,
  deliveries,
}: {
  readonly businessId: string;
  readonly deliveries: readonly DeliveryView[];
}) {
  if (deliveries.length === 0) return <p className="text-sm text-slate-500">Nothing sent yet.</p>;
  return (
    <ul className="divide-y divide-slate-100 text-sm" aria-label="Deliveries">
      {deliveries.map((delivery) => (
        <li
          key={delivery.id}
          className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:justify-between"
        >
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{delivery.event}</span>
              <Badge
                tone={
                  delivery.status === "succeeded"
                    ? "green"
                    : delivery.status === "failed"
                      ? "red"
                      : "amber"
                }
              >
                {delivery.status}
              </Badge>
              <span className="text-xs text-slate-500">
                {formatDateTime(delivery.occurredAt)} · {delivery.attempts} attempt
                {delivery.attempts === 1 ? "" : "s"}
              </span>
            </p>
            {delivery.errorMessage !== null && (
              <p className="text-xs break-words text-red-800">{delivery.errorMessage}</p>
            )}
            {delivery.externalUrl !== null && delivery.externalUrl.startsWith("https://") && (
              <a
                href={delivery.externalUrl}
                className="text-xs text-blue-700 underline"
                rel="noopener noreferrer nofollow"
                target="_blank"
              >
                Open in the CRM
              </a>
            )}
          </div>
          {delivery.status === "failed" && (
            <ActionButton
              action={deliveryRetryAction}
              input={{ businessId, deliveryId: delivery.id }}
            >
              Retry
            </ActionButton>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * A business's integrations (C16): calendars and Calendly (C12), CRMs with their field mapping
 * and delivery log (C14), outgoing webhooks, and where alerts go (C13). Agency staff only;
 * signing secrets are shown to agency admins on request.
 */
export default async function IntegrationsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ businessId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;
  const page = await requireBusinessPage(businessId, {
    staffOnly: true,
    next: `/businesses/${businessId}/integrations`,
  });
  const { tenant } = page;
  const query = await searchParams;
  const here = `/businesses/${tenant.businessId}/integrations`;
  const isAdmin = agencyRoleOf(page.access, tenant.agencyId) === "agency_admin";

  const scheduling = getScheduling();
  const calendarAvailability = scheduling.availability();
  const calendars = await scheduling.list(tenant);
  const integrations = getIntegrations();
  const catalogue = integrations.catalogue();
  const crmConnections = await integrations.list(tenant);
  const deliveries = await integrations.deliveries(tenant, { limit: 100 });
  const webhooks = await integrations.webhookTargets(tenant);
  const readiness = await getHandoff().readiness(tenant);
  const settings = await getDatabase()
    .forBusiness(tenant.businessId, { agencyId: tenant.agencyId })
    .run((ctx) => loadSettings(ctx, tenant));
  const recentLeads = (
    await userDatabase(page.user).run((ctx) =>
      listLeads(ctx, { businessIds: [tenant.businessId], includeReports: false, limit: 20 }),
    )
  ).rows.map((lead) => ({
    id: lead.id,
    label: `${lead.contactName ?? "Unknown customer"} · ${Math.round(lead.score)}`,
  }));
  const calendarResult = RESULTS[first(query["calendar"]) ?? ""];
  const crmResult = RESULTS[first(query["crm"]) ?? ""];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Integrations</h1>
        <p className="mt-1 text-sm text-slate-600">
          Where meetings are booked, where leads are sent and who is alerted. Each shows its stored
          state; an error shows the reason the service gave.
        </p>
      </div>

      <Card data-testid="integration-calendars">
        <CardHeader
          title="Calendars"
          description="Meetings are offered from free time and booked into the calendar."
        />
        <CardBody className="space-y-4">
          {calendarResult !== undefined && (
            <Callout tone={calendarResult.tone}>{calendarResult.text}</Callout>
          )}
          {calendars.length === 0 ? (
            <p className="text-sm text-slate-600">No calendar connected.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {calendars.map((connection) => (
                <li
                  key={connection.id}
                  className="space-y-2 py-3"
                  data-testid="calendar-connection"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 text-sm">
                      <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                        {CALENDAR_LABEL[connection.provider] ?? connection.provider}
                        <ConnectionBadge
                          status={connection.status}
                          lastError={connection.lastError}
                        />
                      </p>
                      {connection.account !== null && (
                        <p className="break-all text-slate-600">{connection.account}</p>
                      )}
                      {connection.connectedAt !== null && (
                        <p className="text-xs text-slate-500">
                          Connected {formatDateTime(connection.connectedAt)}
                        </p>
                      )}
                      <ConnectionError message={connection.lastError} />
                    </div>
                    {connection.status !== "disabled" && (
                      <ActionButton
                        action={calendarDisconnectAction}
                        input={{ businessId: tenant.businessId, connectionId: connection.id }}
                        variant="danger"
                        confirm="Disconnect this calendar? The bot stops offering times from it."
                      >
                        Disconnect
                      </ActionButton>
                    )}
                  </div>
                  {connection.status === "active" && connection.provider !== "calendly" && (
                    <CalendarPicker
                      businessId={tenant.businessId}
                      connectionId={connection.id}
                      current={connection.calendars}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            {calendarAvailability.google && (
              <OAuthStartButton
                endpoint="/api/oauth/calendar/google"
                businessId={tenant.businessId}
                returnTo={here}
              >
                Connect Google Calendar
              </OAuthStartButton>
            )}
            {calendarAvailability.microsoft && (
              <OAuthStartButton
                endpoint="/api/oauth/calendar/microsoft"
                businessId={tenant.businessId}
                returnTo={here}
              >
                Connect Outlook Calendar
              </OAuthStartButton>
            )}
            {calendarAvailability.calendlyOAuth && (
              <OAuthStartButton
                endpoint="/api/oauth/calendar/calendly"
                businessId={tenant.businessId}
                returnTo={here}
              >
                Connect Calendly
              </OAuthStartButton>
            )}
          </div>
          {!calendarAvailability.google && !calendarAvailability.microsoft && (
            <NotOnThisDeployment
              what="Google and Outlook calendar sign-in"
              variables={["GOOGLE_CLIENT_ID", "MICROSOFT_CLIENT_ID"]}
              todo="steps 11 and 12"
            />
          )}
          {calendarAvailability.calendlyToken && (
            <details className="rounded-lg border border-slate-200 px-4 py-3">
              <summary className="cursor-pointer text-sm font-medium text-slate-900">
                Connect Calendly with a personal access token
              </summary>
              <div className="mt-3">
                <CalendlyTokenForm businessId={tenant.businessId} />
              </div>
            </details>
          )}
        </CardBody>
      </Card>

      <Card data-testid="integration-crms">
        <CardHeader
          title="CRMs"
          description="Every lead and its report go to the CRM, with the field mapping below."
        />
        <CardBody className="space-y-4">
          {crmResult !== undefined && <Callout tone={crmResult.tone}>{crmResult.text}</Callout>}
          <ul className="divide-y divide-slate-100">
            {catalogue.map((crm) => {
              const connection = crmConnections.find(
                (item) => item.provider === crm.id && item.status !== "disabled",
              );
              const stored = settings.values[`integrations.field_mapping.${crm.id}`] as
                readonly { source: string; target: string; transform?: string }[] | undefined;
              const mapping =
                stored !== undefined && stored.length > 0 ? stored : crm.defaultFieldMapping;
              return (
                <li key={crm.id} className="space-y-3 py-4" data-testid={`crm-${crm.id}`}>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 text-sm">
                      <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                        {crm.displayName}
                        {connection === undefined ? (
                          <Badge>Not connected</Badge>
                        ) : (
                          <ConnectionBadge
                            status={connection.status}
                            lastError={connection.lastError}
                          />
                        )}
                      </p>
                      {connection?.account != null && (
                        <p className="break-all text-slate-600">{connection.account}</p>
                      )}
                      {connection?.lastSyncedAt != null && (
                        <p className="text-xs text-slate-500">
                          Last sent {formatDateTime(connection.lastSyncedAt)}
                        </p>
                      )}
                      <ConnectionError message={connection?.lastError ?? null} />
                    </div>
                    {connection !== undefined && (
                      <div className="flex flex-wrap gap-2">
                        <ActionButton
                          action={crmTestAction}
                          input={{ businessId: tenant.businessId, connectionId: connection.id }}
                        >
                          Test
                        </ActionButton>
                        <ActionButton
                          action={crmDisconnectAction}
                          input={{ businessId: tenant.businessId, connectionId: connection.id }}
                          variant="danger"
                          confirm={`Disconnect ${crm.displayName}? Leads stop going to it.`}
                        >
                          Disconnect
                        </ActionButton>
                      </div>
                    )}
                  </div>
                  {connection === undefined ? (
                    <div className="space-y-3">
                      {crm.oauth ? (
                        <OAuthStartButton
                          endpoint={`/api/oauth/crm/${crm.id}`}
                          businessId={tenant.businessId}
                          returnTo={here}
                        >
                          Connect {crm.displayName}
                        </OAuthStartButton>
                      ) : null}
                      {crm.keyFields.length > 0 ? (
                        <details className="rounded-lg border border-slate-200 px-4 py-3">
                          <summary className="cursor-pointer text-sm font-medium text-slate-900">
                            Connect with {crm.keyFields.length === 1 ? "a key" : "its keys"}
                          </summary>
                          <div className="mt-3">
                            <CrmKeyForm
                              businessId={tenant.businessId}
                              provider={crm.id}
                              fields={crm.keyFields}
                            />
                          </div>
                        </details>
                      ) : !crm.oauth ? (
                        <p className="text-sm text-slate-600">
                          {crm.displayName} connects through its OAuth app, which is not set up on
                          this deployment (docs/HUMAN_TODO.md, step 15).
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      <details className="rounded-lg border border-slate-200 px-4 py-3">
                        <summary className="cursor-pointer text-sm font-medium text-slate-900">
                          Options
                        </summary>
                        <div className="mt-3">
                          <CrmConfigForm
                            businessId={tenant.businessId}
                            connectionId={connection.id}
                            config={primitiveConfig(connection.config)}
                          />
                        </div>
                      </details>
                      <details className="rounded-lg border border-slate-200 px-4 py-3">
                        <summary className="cursor-pointer text-sm font-medium text-slate-900">
                          Sent leads (
                          {deliveries.filter((item) => item.connectionId === connection.id).length})
                        </summary>
                        <div className="mt-3">
                          <Deliveries
                            businessId={tenant.businessId}
                            deliveries={deliveries
                              .filter((item) => item.connectionId === connection.id)
                              .slice(0, 20)}
                          />
                        </div>
                      </details>
                    </>
                  )}
                  <details className="rounded-lg border border-slate-200 px-4 py-3">
                    <summary className="cursor-pointer text-sm font-medium text-slate-900">
                      Field mapping (
                      {stored !== undefined && stored.length > 0
                        ? "set for this business"
                        : "standard"}
                      )
                    </summary>
                    <div className="mt-3 space-y-3">
                      <div className="overflow-x-auto">
                        <table className="min-w-full text-left text-sm">
                          <thead className="text-xs text-slate-500">
                            <tr>
                              <th className="py-1 pr-4 font-medium">Our field</th>
                              <th className="py-1 pr-4 font-medium">{crm.displayName} field</th>
                              <th className="py-1 font-medium">As</th>
                            </tr>
                          </thead>
                          <tbody>
                            {mapping.map((row) => (
                              <tr
                                key={`${row.source}-${row.target}`}
                                className="border-t border-slate-100"
                              >
                                <td className="py-1 pr-4 font-mono text-xs">{row.source}</td>
                                <td className="py-1 pr-4 font-mono text-xs">{row.target}</td>
                                <td className="py-1 text-xs text-slate-600">
                                  {row.transform ?? "as it is"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <Link
                        href={`/businesses/${tenant.businessId}/settings?q=field_mapping` as Route}
                        className="text-sm text-blue-700 underline"
                      >
                        Change the mapping
                      </Link>
                      <MappingPreview
                        businessId={tenant.businessId}
                        provider={crm.id}
                        leads={recentLeads}
                      />
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        </CardBody>
      </Card>

      <Card data-testid="integration-webhooks">
        <CardHeader
          title="Webhooks"
          description="Signed requests to Zapier, Make or any address, set on the Settings tab."
          actions={
            <Link
              href={`/businesses/${tenant.businessId}/settings?q=webhooks` as Route}
              className="text-sm text-blue-700 underline"
            >
              Edit webhooks
            </Link>
          }
        />
        <CardBody>
          {webhooks.length === 0 ? (
            <p className="text-sm text-slate-600">No webhook set up.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {webhooks.map((target) => (
                <li
                  key={`${target.scope}:${target.name}`}
                  className="space-y-2 py-3"
                  data-testid="webhook-target"
                >
                  <div className="text-sm">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                      {target.name}
                      <Badge>{target.scope === "agency" ? "Agency-wide" : "This business"}</Badge>
                      {!target.active && <Badge>Paused</Badge>}
                      {target.lastError !== null && <Badge tone="red">Error</Badge>}
                    </p>
                    <p className="break-all text-slate-600">{target.url}</p>
                    <p className="text-xs text-slate-500">
                      {target.events.join(", ")}
                      {target.lastDeliveredAt !== null &&
                        ` · last sent ${formatDateTime(target.lastDeliveredAt)}`}
                      {target.secretHint !== null && ` · secret ${target.secretHint}`}
                    </p>
                    <ConnectionError message={target.lastError} />
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    <ActionButton
                      action={webhookTestAction}
                      input={{
                        businessId: tenant.businessId,
                        scope: target.scope,
                        name: target.name,
                      }}
                    >
                      Send a test
                    </ActionButton>
                    {isAdmin && (
                      <WebhookSecret
                        businessId={tenant.businessId}
                        scope={target.scope}
                        name={target.name}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card data-testid="integration-alerts">
        <CardHeader
          title="Alerts"
          description="Who hears about new leads and emergencies, by email, text message, call or WhatsApp."
          actions={<ReadinessBadge ready={readiness.ready} enabled={readiness.enabled} />}
        />
        <CardBody className="space-y-2 text-sm text-slate-700">
          <p>
            {readiness.alertRecipients} alert recipient{readiness.alertRecipients === 1 ? "" : "s"},{" "}
            {readiness.businessContacts} emergency contact
            {readiness.businessContacts === 1 ? "" : "s"} and {readiness.fallbackContacts} agency
            fallback contact{readiness.fallbackContacts === 1 ? "" : "s"}.
          </p>
          <Link
            href={`/businesses/${tenant.businessId}/alerts` as Route}
            className="text-blue-700 underline"
          >
            Manage alert contacts
          </Link>
        </CardBody>
      </Card>
    </div>
  );
}
