"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  calendarListAction,
  calendarSetAction,
  crmUpdateConfigAction,
  mappingPreviewAction,
  webhookRevealAction,
  webhookRotateAction,
} from "@/app/(admin)/_actions/connections";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";

import { JsonConnectForm } from "./client";

/*
 * Browser halves of the integrations page (C16). Every value shown came from the server's
 * views, which never hold a token or a key; a signing secret is fetched only when an agency
 * admin asks for it, held in this component's memory and dropped when it is hidden.
 */

function Message({ text, ok }: { readonly text: string | null; readonly ok: boolean }) {
  if (text === null) return null;
  return (
    <p
      role={ok ? "status" : "alert"}
      className={ok ? "text-sm text-emerald-800" : "text-sm text-red-700"}
    >
      {text}
    </p>
  );
}

/** Which calendars keep times from being offered, and which one meetings go into. */
export function CalendarPicker({
  businessId,
  connectionId,
  current,
}: {
  readonly businessId: string;
  readonly connectionId: string;
  readonly current: {
    readonly calendarIds: readonly string[];
    readonly bookingCalendarId: string;
  } | null;
}) {
  const router = useRouter();
  const [calendars, setCalendars] = useState<
    readonly { readonly id: string; readonly name: string; readonly primary: boolean }[] | null
  >(null);
  const [checked, setChecked] = useState<readonly string[]>(current?.calendarIds ?? []);
  const [booking, setBooking] = useState(current?.bookingCalendarId ?? "");
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [pending, startTransition] = useTransition();
  if (calendars === null) {
    return (
      <div className="space-y-1">
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await calendarListAction({ businessId, connectionId });
              if (result.ok) {
                setCalendars(result.value);
                if (checked.length === 0) {
                  const primary = result.value.find((calendar) => calendar.primary);
                  if (primary !== undefined) {
                    setChecked([primary.id]);
                    setBooking(primary.id);
                  }
                }
              } else setMessage({ text: result.error, ok: false });
            })
          }
        >
          Choose calendars
        </Button>
        <Message text={message?.text ?? null} ok={message?.ok ?? false} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <ul className="space-y-1 text-sm">
        {calendars.map((calendar) => (
          <li key={calendar.id}>
            <label className="inline-flex items-center gap-2">
              <Checkbox
                checked={checked.includes(calendar.id)}
                onChange={(event) =>
                  setChecked((list) =>
                    event.target.checked
                      ? [...list, calendar.id]
                      : list.filter((id) => id !== calendar.id),
                  )
                }
              />
              <span className="break-all">
                {calendar.name}
                {calendar.primary && " (main)"}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <Field label="Meetings go into" htmlFor={`booking-${connectionId}`}>
        <Select
          id={`booking-${connectionId}`}
          value={booking}
          onChange={(event) => setBooking(event.target.value)}
        >
          <option value="">Choose…</option>
          {calendars
            .filter((calendar) => checked.includes(calendar.id))
            .map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.name}
              </option>
            ))}
        </Select>
      </Field>
      <Button
        size="sm"
        disabled={pending || checked.length === 0 || booking === ""}
        onClick={() =>
          startTransition(async () => {
            const result = await calendarSetAction({
              businessId,
              connectionId,
              calendarIds: [...checked],
              bookingCalendarId: booking,
            });
            setMessage(
              result.ok ? { text: result.value, ok: true } : { text: result.error, ok: false },
            );
            if (result.ok) router.refresh();
          })
        }
      >
        Save calendars
      </Button>
      <Message text={message?.text ?? null} ok={message?.ok ?? false} />
    </div>
  );
}

/** A CRM connection's options (pipeline, booking provider...), as plain fields. */
export function CrmConfigForm({
  businessId,
  connectionId,
  config,
}: {
  readonly businessId: string;
  readonly connectionId: string;
  readonly config: Readonly<Record<string, string | number | boolean | null>>;
}) {
  const router = useRouter();
  const [values, setValues] = useState(config);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [pending, startTransition] = useTransition();
  const keys = Object.keys(config);
  if (keys.length === 0) return <p className="text-sm text-slate-500">This CRM has no options.</p>;
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await crmUpdateConfigAction({ businessId, connectionId, config: values });
          setMessage(
            result.ok ? { text: result.value, ok: true } : { text: result.error, ok: false },
          );
          if (result.ok) router.refresh();
        });
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {keys.map((key) => {
          const value = values[key];
          const id = `cfg-${connectionId}-${key}`;
          const label = key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
          return typeof value === "boolean" ? (
            <label key={key} className="inline-flex items-center gap-2 text-sm">
              <Checkbox
                checked={value}
                onChange={(event) => setValues({ ...values, [key]: event.target.checked })}
              />
              {label}
            </label>
          ) : (
            <Field key={key} label={label} htmlFor={id}>
              <Input
                id={id}
                value={value === null ? "" : String(value)}
                type={typeof value === "number" ? "number" : "text"}
                onChange={(event) =>
                  setValues({
                    ...values,
                    [key]:
                      typeof value === "number"
                        ? Number(event.target.value)
                        : event.target.value === "" && value === null
                          ? null
                          : event.target.value,
                  })
                }
              />
            </Field>
          );
        })}
      </div>
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        Save options
      </Button>
      <Message text={message?.text ?? null} ok={message?.ok ?? false} />
    </form>
  );
}

/** What one lead would look like in the CRM with the mapping in force. */
export function MappingPreview({
  businessId,
  provider,
  leads,
}: {
  readonly businessId: string;
  readonly provider: string;
  readonly leads: readonly { readonly id: string; readonly label: string }[];
}) {
  const [leadId, setLeadId] = useState(leads[0]?.id ?? "");
  const [preview, setPreview] = useState<{
    fields: Readonly<Record<string, string>>;
    ignored: readonly string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (leads.length === 0) {
    return (
      <p className="text-sm text-slate-500">A preview needs a lead; this business has none yet.</p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label="Preview with lead" htmlFor={`preview-${provider}`} className="flex-1">
          <Select
            id={`preview-${provider}`}
            value={leadId}
            onChange={(event) => setLeadId(event.target.value)}
          >
            {leads.map((lead) => (
              <option key={lead.id} value={lead.id}>
                {lead.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          variant="secondary"
          size="sm"
          disabled={pending || leadId === ""}
          onClick={() =>
            startTransition(async () => {
              const result = await mappingPreviewAction({ businessId, provider, leadId });
              if (result.ok) {
                setPreview(result.value);
                setError(null);
              } else setError(result.error);
            })
          }
        >
          Preview
        </Button>
      </div>
      {preview !== null && (
        <dl
          className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]"
          data-testid="mapping-preview"
        >
          {Object.entries(preview.fields).map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="font-mono text-xs text-slate-500">{key}</dt>
              <dd className="break-words text-slate-900">{value}</dd>
            </div>
          ))}
          {preview.ignored.length > 0 && (
            <p className="text-xs text-slate-500 sm:col-span-2">
              Not sent: {preview.ignored.join(", ")}
            </p>
          )}
        </dl>
      )}
      <Message text={error} ok={false} />
    </div>
  );
}

/** Shows or replaces a webhook's signing secret (agency admins; audited on the server). */
export function WebhookSecret({
  businessId,
  scope,
  name,
}: {
  readonly businessId: string;
  readonly scope: "business" | "agency";
  readonly name: string;
}) {
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (rotate: boolean) =>
    startTransition(async () => {
      if (rotate && !window.confirm("Replace the secret? The receiver must be given the new one."))
        return;
      const result = rotate
        ? await webhookRotateAction({ businessId, scope, name })
        : await webhookRevealAction({ businessId, scope, name });
      if (result.ok) {
        setSecret(result.value);
        setError(null);
      } else setError(result.error);
    });
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        {secret === null ? (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(false)}>
            Show secret
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setSecret(null)}>
            Hide secret
          </Button>
        )}
        <Button size="sm" variant="danger" disabled={pending} onClick={() => run(true)}>
          Replace secret
        </Button>
      </div>
      {secret !== null && (
        <code
          className="block rounded bg-slate-100 px-2 py-1 font-mono text-xs break-all"
          data-testid="webhook-secret"
        >
          {secret}
        </code>
      )}
      <Message text={error} ok={false} />
    </div>
  );
}

/** Connects a CRM with its key or client credentials (C14's key route). */
export function CrmKeyForm({
  businessId,
  provider,
  fields,
}: {
  readonly businessId: string;
  readonly provider: string;
  readonly fields: readonly {
    readonly key: string;
    readonly label: string;
    readonly secret: boolean;
  }[];
}) {
  return (
    <JsonConnectForm
      endpoint={`/api/integrations/crm/${provider}`}
      fixed={{ businessId }}
      testId={`crm-key-${provider}`}
      submitLabel="Check and connect"
      fields={fields.map((field) => ({
        name: field.key,
        label: field.label,
        type: field.secret ? ("password" as const) : ("text" as const),
        required: true,
      }))}
      build={(values) => ({ fields: values })}
    />
  );
}

/** Connects Calendly with a personal access token (C12's token route). */
export function CalendlyTokenForm({ businessId }: { readonly businessId: string }) {
  return (
    <JsonConnectForm
      endpoint="/api/integrations/calendly/token"
      fixed={{ businessId }}
      testId="calendly-token"
      submitLabel="Check and connect"
      fields={[
        {
          name: "token",
          label: "Calendly personal access token",
          type: "password",
          required: true,
        },
      ]}
    />
  );
}
