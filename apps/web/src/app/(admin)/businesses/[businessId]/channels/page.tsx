import type { Metadata, Route } from "next";
import Link from "next/link";

import type { TemplateView, WhatsAppConnectionView } from "@repo/channel-whatsapp/server";
import { SUGGESTED_TEMPLATES } from "@repo/channel-whatsapp/server";
import { widgetEmbedInfo } from "@repo/channel-widget/server";
import { getEnv } from "@repo/core/env";
import { getDatabase } from "@repo/db";

import {
  emailDisconnectAction,
  emailSyncAction,
  metaDisconnectAction,
  whatsappAddSuggestedTemplateAction,
  whatsappDisconnectAction,
  whatsappSyncTemplatesAction,
  widgetEnableAction,
  widgetRotateAction,
  widgetSetUpAction,
} from "@/app/(admin)/_actions/connections";
import { CopyField, ImapConnectForm, OAuthStartButton } from "@/components/connections/client";
import { FacebookLoginButton, WhatsAppSignupButton } from "@/components/connections/meta-connect";
import {
  ConnectionBadge,
  ConnectionError,
  NotOnThisDeployment,
} from "@/components/connections/status";
import { ActionButton } from "@/components/inbox/action-button";
import { formatDateTime } from "@/components/inbox/labels";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { adminLogger, requireBusinessPage } from "@/server/admin";
import { getEmail } from "@/server/email";
import { getMetaPages } from "@/server/meta-pages";
import { getWhatsApp } from "@/server/whatsapp";

export const metadata: Metadata = { title: "Channels" };
export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

const EMAIL_RESULTS: Readonly<
  Record<string, { tone: "success" | "warning" | "danger"; text: string }>
> = {
  connected: { tone: "success", text: "The inbox is connected." },
  cancelled: { tone: "warning", text: "The sign-in was cancelled. Nothing was connected." },
  in_use: { tone: "danger", text: "That mailbox is connected to another business." },
  failed: { tone: "danger", text: "The inbox could not be connected. Try again." },
};

const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  gmail: "Gmail",
  microsoft: "Microsoft 365",
  imap: "IMAP/SMTP",
};

function Row({
  children,
  testId,
}: {
  readonly children: React.ReactNode;
  readonly testId?: string;
}) {
  return (
    <li
      className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between"
      data-testid={testId}
    >
      {children}
    </li>
  );
}

/**
 * A business's channels (C16): the website chat, WhatsApp, Messenger and Instagram, and email
 * inboxes, each with its stored state. Agency staff only. A channel this deployment has no
 * app or keys for says so and offers nothing to click.
 */
export default async function ChannelsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ businessId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { businessId } = await params;
  const page = await requireBusinessPage(businessId, {
    staffOnly: true,
    next: `/businesses/${businessId}/channels`,
  });
  const { tenant } = page;
  const query = await searchParams;
  const appUrl = getEnv().APP_URL ?? "http://localhost:3000";
  const here = `/businesses/${tenant.businessId}/channels`;

  const widget = await getDatabase()
    .forBusiness(tenant.businessId, { agencyId: tenant.agencyId })
    .run((ctx) => widgetEmbedInfo(ctx, { appUrl }));

  const whatsapp = getWhatsApp();
  const numbers: WhatsAppConnectionView[] = whatsapp === null ? [] : await whatsapp.list(tenant);
  const templates = new Map<string, TemplateView[]>();
  if (whatsapp !== null) {
    for (const number of numbers) {
      templates.set(
        number.connectionId,
        await whatsapp.templates.list(tenant, number.connectionId).catch((error: unknown) => {
          adminLogger.warn("channels.templates_failed", { error });
          return [];
        }),
      );
    }
  }
  const meta = getMetaPages();
  const pages = meta === null ? [] : await meta.list(tenant);
  const email = getEmail();
  const inboxes = await email.list(tenant);
  const emailAvailable = email.availability();
  const emailResult = EMAIL_RESULTS[first(query["email"]) ?? ""];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Channels</h1>
        <p className="mt-1 text-sm text-slate-600">
          Where customers reach the bot. Each shows its stored state; an error shows the reason the
          provider gave.
        </p>
      </div>

      <Card data-testid="channel-widget">
        <CardHeader
          title="Website chat"
          description="A chat bubble on the business's website: one script tag."
          actions={
            widget.status === null ? (
              <ActionButton
                action={widgetSetUpAction}
                input={{ businessId: tenant.businessId }}
                variant="primary"
              >
                Set up the website chat
              </ActionButton>
            ) : (
              <>
                <ConnectionBadge status={widget.status} lastError={null} />
              </>
            )
          }
        />
        <CardBody className="space-y-4">
          {widget.snippet === null ? (
            <p className="text-sm text-slate-600">Not set up yet.</p>
          ) : (
            <>
              <CopyField
                label="Paste this before </body> on every page of the website"
                value={widget.snippet}
              />
              {widget.needsOrigins ? (
                <Callout tone="warning" title="No website is allowed yet">
                  The chat shows nothing until the website&apos;s address is added to{" "}
                  <Link
                    href={`/businesses/${tenant.businessId}/settings?q=allowed_origins` as Route}
                    className="font-medium underline"
                  >
                    the allowed websites
                  </Link>
                  .
                </Callout>
              ) : (
                <div className="text-sm text-slate-700">
                  <p className="font-medium text-slate-800">Allowed websites</p>
                  <ul className="mt-1 list-inside list-disc">
                    {widget.allowedOrigins.map((origin) => (
                      <li key={origin} className="break-all">
                        {origin}
                      </li>
                    ))}
                  </ul>
                  <Link
                    href={`/businesses/${tenant.businessId}/settings?q=allowed_origins` as Route}
                    className="mt-1 inline-block text-blue-700 underline"
                  >
                    Change the allowed websites
                  </Link>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  action={widgetEnableAction}
                  input={{ businessId: tenant.businessId, enabled: widget.status !== "active" }}
                >
                  {widget.status === "active" ? "Turn the chat off" : "Turn the chat on"}
                </ActionButton>
                <ActionButton
                  action={widgetRotateAction}
                  input={{ businessId: tenant.businessId }}
                  confirm="The current snippet stops working at once. Replace the key?"
                >
                  Replace the key
                </ActionButton>
              </div>
            </>
          )}
        </CardBody>
      </Card>

      <Card data-testid="channel-whatsapp">
        <CardHeader
          title="WhatsApp"
          description="A WhatsApp Business number through Meta's Cloud API."
        />
        <CardBody className="space-y-4">
          {whatsapp === null ? (
            <NotOnThisDeployment
              what="WhatsApp"
              variables={["META_APP_ID", "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN"]}
              todo="step 10"
            />
          ) : (
            <>
              {numbers.length === 0 ? (
                <p className="text-sm text-slate-600">No number connected.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {numbers.map((number) => {
                    const list = templates.get(number.connectionId) ?? [];
                    const missing = SUGGESTED_TEMPLATES.filter(
                      (suggestion) => !list.some((template) => template.name === suggestion.name),
                    );
                    return (
                      <Row key={number.connectionId} testId="whatsapp-number">
                        <div className="min-w-0 text-sm">
                          <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                            {number.displayPhoneNumber ?? number.phoneNumberId}
                            <ConnectionBadge status={number.status} lastError={number.lastError} />
                          </p>
                          {number.verifiedName !== null && (
                            <p className="text-slate-600">{number.verifiedName}</p>
                          )}
                          <p className="text-xs text-slate-500">
                            Templates: {number.templates.approved} approved,{" "}
                            {number.templates.pending} waiting for Meta
                            {number.connectedAt !== null &&
                              ` · connected ${formatDateTime(number.connectedAt)}`}
                          </p>
                          <ConnectionError message={number.lastError} />
                          {list.length > 0 && (
                            <ul className="mt-2 space-y-1 text-xs text-slate-600">
                              {list.map((template) => (
                                <li key={template.id}>
                                  <span className="font-mono">{template.name}</span> ·{" "}
                                  {template.status}
                                  {template.purpose !== null &&
                                    ` · ${template.purpose.replaceAll("_", " ")}`}
                                  {template.rejectionReason !== null &&
                                    ` · ${template.rejectionReason}`}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        {number.status !== "disabled" && (
                          <div className="flex flex-wrap gap-2">
                            <ActionButton
                              action={whatsappSyncTemplatesAction}
                              input={{
                                businessId: tenant.businessId,
                                connectionId: number.connectionId,
                              }}
                            >
                              Sync templates
                            </ActionButton>
                            {missing.map((suggestion) => (
                              <ActionButton
                                key={suggestion.name}
                                action={whatsappAddSuggestedTemplateAction}
                                input={{
                                  businessId: tenant.businessId,
                                  connectionId: number.connectionId,
                                  name: suggestion.name,
                                }}
                              >
                                Add “{suggestion.name.replaceAll("_", " ")}”
                              </ActionButton>
                            ))}
                            <ActionButton
                              action={whatsappDisconnectAction}
                              input={{
                                businessId: tenant.businessId,
                                connectionId: number.connectionId,
                              }}
                              variant="danger"
                              confirm="Disconnect this number? The bot stops reading and answering it."
                            >
                              Disconnect
                            </ActionButton>
                          </div>
                        )}
                      </Row>
                    );
                  })}
                </ul>
              )}
              {whatsapp.signupConfig() === null ? (
                <NotOnThisDeployment
                  what="WhatsApp Embedded Signup"
                  variables={["META_WHATSAPP_SIGNUP_CONFIG_ID"]}
                  todo="step 10"
                />
              ) : (
                <WhatsAppSignupButton
                  businessId={tenant.businessId}
                  config={whatsapp.signupConfig()!}
                />
              )}
            </>
          )}
        </CardBody>
      </Card>

      <Card data-testid="channel-meta">
        <CardHeader
          title="Messenger and Instagram"
          description="A Facebook Page and its Instagram professional account."
        />
        <CardBody className="space-y-4">
          {meta === null ? (
            <NotOnThisDeployment
              what="Messenger and Instagram"
              variables={["META_APP_ID", "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN"]}
              todo="step 10"
            />
          ) : (
            <>
              {pages.length === 0 ? (
                <p className="text-sm text-slate-600">No Page or Instagram account connected.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {pages.map((item) => (
                    <Row key={item.connectionId} testId="meta-connection">
                      <div className="min-w-0 text-sm">
                        <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                          {item.channel === "instagram"
                            ? `Instagram @${item.instagramUsername ?? item.instagramAccountId ?? ""}`
                            : `Messenger: ${item.pageName ?? item.pageId}`}
                          <ConnectionBadge status={item.status} lastError={item.lastError} />
                        </p>
                        {item.connectedAt !== null && (
                          <p className="text-xs text-slate-500">
                            Connected {formatDateTime(item.connectedAt)}
                          </p>
                        )}
                        <ConnectionError message={item.lastError} />
                      </div>
                      {item.status !== "disabled" && (
                        <ActionButton
                          action={metaDisconnectAction}
                          input={{ businessId: tenant.businessId, connectionId: item.connectionId }}
                          variant="danger"
                          confirm="Disconnect? The bot stops reading and answering it."
                        >
                          Disconnect
                        </ActionButton>
                      )}
                    </Row>
                  ))}
                </ul>
              )}
              {meta.loginConfig() === null ? (
                <NotOnThisDeployment
                  what="Facebook Login for Business"
                  variables={["META_LOGIN_CONFIG_ID"]}
                  todo="step 10"
                />
              ) : (
                <FacebookLoginButton businessId={tenant.businessId} config={meta.loginConfig()!} />
              )}
            </>
          )}
        </CardBody>
      </Card>

      <Card data-testid="channel-email">
        <CardHeader
          title="Email"
          description="Gmail, Microsoft 365 or any IMAP/SMTP inbox on the business's domain."
        />
        <CardBody className="space-y-4">
          {emailResult !== undefined && (
            <Callout tone={emailResult.tone}>{emailResult.text}</Callout>
          )}
          {inboxes.length === 0 ? (
            <p className="text-sm text-slate-600">No inbox connected.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {inboxes.map((inbox) => (
                <Row key={inbox.connectionId} testId="email-inbox">
                  <div className="min-w-0 text-sm">
                    <p className="flex flex-wrap items-center gap-2 font-medium break-all text-slate-900">
                      {inbox.address}
                      <ConnectionBadge status={inbox.status} lastError={inbox.lastError} />
                      <Badge>{PROVIDER_LABEL[inbox.provider] ?? inbox.provider}</Badge>
                    </p>
                    <p className="text-xs text-slate-500">
                      {inbox.delivery === "push"
                        ? "New mail is pushed to us"
                        : "Checked every minute"}
                      {inbox.lastSyncAt !== null &&
                        ` · last read ${formatDateTime(inbox.lastSyncAt)}`}
                      {inbox.imap !== null && ` · IMAP ${inbox.imap.host}:${inbox.imap.port}`}
                    </p>
                    <ConnectionError message={inbox.lastError} />
                  </div>
                  {inbox.status !== "disabled" && (
                    <div className="flex flex-wrap gap-2">
                      <ActionButton
                        action={emailSyncAction}
                        input={{ businessId: tenant.businessId, connectionId: inbox.connectionId }}
                      >
                        Read now
                      </ActionButton>
                      <ActionButton
                        action={emailDisconnectAction}
                        input={{ businessId: tenant.businessId, connectionId: inbox.connectionId }}
                        variant="danger"
                        confirm="Disconnect this inbox? Its stored credentials are deleted."
                      >
                        Disconnect
                      </ActionButton>
                    </div>
                  )}
                </Row>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            {emailAvailable.gmail ? (
              <OAuthStartButton
                endpoint="/api/oauth/email/google"
                businessId={tenant.businessId}
                returnTo={here}
              >
                Connect Gmail
              </OAuthStartButton>
            ) : null}
            {emailAvailable.microsoft ? (
              <OAuthStartButton
                endpoint="/api/oauth/email/microsoft"
                businessId={tenant.businessId}
                returnTo={here}
              >
                Connect Microsoft 365
              </OAuthStartButton>
            ) : null}
          </div>
          {!emailAvailable.gmail && !emailAvailable.microsoft && (
            <NotOnThisDeployment
              what="Gmail and Microsoft 365 sign-in"
              variables={["GOOGLE_CLIENT_ID", "MICROSOFT_CLIENT_ID"]}
              todo="steps 11 and 12"
            />
          )}
          <details className="rounded-lg border border-slate-200 px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium text-slate-900">
              Connect an IMAP/SMTP inbox
            </summary>
            <p className="mt-2 text-sm text-slate-600">
              Both logins are tried before anything is saved. The passwords are stored encrypted and
              never shown again.
            </p>
            <div className="mt-3">
              <ImapConnectForm businessId={tenant.businessId} />
            </div>
          </details>
        </CardBody>
      </Card>
    </div>
  );
}
