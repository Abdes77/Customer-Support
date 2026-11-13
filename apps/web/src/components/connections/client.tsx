"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";

/*
 * Browser halves of the connection pages (C16). The account-proving flows post to the routes
 * C9 to C14 built (same-origin JSON; the routes check the session, the business and the role
 * again). Nothing secret comes back: a route answers the connection as the panel shows it.
 */

/** The errors the connect routes answer with, as sentences. */
function routeError(status: number, body: { error?: unknown; message?: unknown }): string {
  if (typeof body.message === "string" && body.message !== "") return body.message;
  if (status === 401) return "Your session has ended. Sign in again.";
  if (status === 403) return "You cannot connect accounts for this business.";
  if (status === 503) return "This is not set up on this deployment.";
  if (status === 409) return "This account is connected to another business.";
  return "That did not work. Try again, and check the server log if it keeps failing.";
}

export async function postJson(
  url: string,
  body: Record<string, unknown>,
): Promise<
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly error: string }
> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) return { ok: false, error: routeError(response.status, data) };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "The request could not be sent. Check your connection." };
  }
}

/** Starts an OAuth flow: the route answers the provider's address, the browser goes there. */
export function OAuthStartButton({
  endpoint,
  businessId,
  returnTo,
  children,
  testId,
}: {
  readonly endpoint: string;
  readonly businessId: string;
  readonly returnTo: string;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        data-testid={testId}
        onClick={() =>
          startTransition(async () => {
            const result = await postJson(endpoint, { businessId, returnTo });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            const url = result.data["authorizationUrl"];
            if (typeof url === "string" && url.startsWith("https://")) window.location.assign(url);
            else setError("The provider's address was not valid.");
          })
        }
      >
        {children}
      </Button>
      {error !== null && (
        <span role="alert" className="text-xs text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}

/** A form that posts its fields as JSON to a connect route, then re-renders the page. */
export function JsonConnectForm({
  endpoint,
  fixed,
  fields,
  submitLabel,
  build,
  testId,
}: {
  readonly endpoint: string;
  /** Values the server checks again (the business id). */
  readonly fixed: Record<string, unknown>;
  readonly fields: readonly {
    readonly name: string;
    readonly label: string;
    readonly type?: "text" | "password" | "email" | "number";
    readonly required?: boolean;
    readonly help?: string;
    readonly options?: readonly { readonly value: string; readonly label: string }[];
    readonly defaultValue?: string;
  }[];
  readonly submitLabel: string;
  /** Turns the form's values into the route's body (nested objects, numbers). */
  readonly build?: (values: Record<string, string>) => Record<string, unknown>;
  readonly testId?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const values: Record<string, string> = {};
    for (const field of fields) {
      const value = data.get(field.name);
      values[field.name] = typeof value === "string" ? value : "";
    }
    startTransition(async () => {
      const result = await postJson(endpoint, { ...fixed, ...(build?.(values) ?? values) });
      if (result.ok) {
        setError(null);
        setDone(true);
        form.reset();
        router.refresh();
      } else {
        setDone(false);
        setError(result.error);
      }
    });
  };
  return (
    <form onSubmit={onSubmit} className="space-y-3" data-testid={testId} autoComplete="off">
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => (
          <Field
            key={field.name}
            label={field.label}
            htmlFor={`${testId ?? "f"}-${field.name}`}
            help={field.help}
          >
            {field.options === undefined ? (
              <Input
                id={`${testId ?? "f"}-${field.name}`}
                name={field.name}
                type={field.type ?? "text"}
                required={field.required ?? false}
                defaultValue={field.defaultValue}
                autoComplete={field.type === "password" ? "new-password" : "off"}
              />
            ) : (
              <Select
                id={`${testId ?? "f"}-${field.name}`}
                name={field.name}
                defaultValue={field.defaultValue}
              >
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Checking…" : submitLabel}
        </Button>
        {done && (
          <span role="status" className="text-sm text-emerald-800">
            Connected.
          </span>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}

/** A read-only text the person copies (the website chat's snippet). */
export function CopyField({ value, label }: { readonly value: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-slate-800">{label}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <code
          className="block min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs break-all text-slate-800"
          data-testid="copy-value"
        >
          {value}
        </code>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void navigator.clipboard
              .writeText(value)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

/** The IMAP/SMTP inbox form (C11's `POST /api/channels/email/imap`). */
export function ImapConnectForm({ businessId }: { readonly businessId: string }) {
  return (
    <JsonConnectForm
      endpoint="/api/channels/email/imap"
      fixed={{ businessId }}
      testId="imap-form"
      submitLabel="Check and connect"
      fields={[
        { name: "address", label: "Inbox address", type: "email", required: true },
        { name: "displayName", label: "Sender name" },
        { name: "imapHost", label: "IMAP server", required: true },
        {
          name: "imapPort",
          label: "IMAP port",
          type: "number",
          defaultValue: "993",
          required: true,
        },
        { name: "smtpHost", label: "SMTP server", required: true },
        {
          name: "smtpPort",
          label: "SMTP port",
          type: "number",
          defaultValue: "465",
          required: true,
        },
        {
          name: "smtpSecurity",
          label: "SMTP security",
          options: [
            { value: "tls", label: "TLS (port 465)" },
            { value: "starttls", label: "STARTTLS (port 587)" },
          ],
        },
        { name: "username", label: "Login (usually the address)", required: true },
        { name: "imapPassword", label: "Password", type: "password", required: true },
        {
          name: "smtpPassword",
          label: "SMTP password",
          type: "password",
          help: "Leave empty when it is the same.",
        },
      ]}
      build={(values) => ({
        address: values["address"],
        displayName: values["displayName"] === "" ? null : values["displayName"],
        imap: {
          host: values["imapHost"],
          port: Number(values["imapPort"]),
          security: "tls",
          username: values["username"],
        },
        smtp: {
          host: values["smtpHost"],
          port: Number(values["smtpPort"]),
          security: values["smtpSecurity"],
          username: values["username"],
        },
        imapPassword: values["imapPassword"],
        smtpPassword: values["smtpPassword"] === "" ? null : values["smtpPassword"],
      })}
    />
  );
}
