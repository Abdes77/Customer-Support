"use client";

import { useEffect, useState } from "react";

import type { WidgetDemoLead } from "@repo/core";

import { ReportText } from "@/components/inbox/report-text";
import { cn } from "@/components/ui/cn";

/*
 * The demo page's "what the business sees" panel: the lead the assistant builds from this
 * visitor's own chat. It reads the chat's session token where the chat script keeps it
 * (localStorage, per widget key) and asks `/api/widget/v1/demo/lead`, which only answers for a
 * business whose public demo page is switched on.
 */

const FAST_MS = 2500;
const HIDDEN_MS = 10_000;

const BAND_STYLES: Readonly<Record<string, string>> = {
  hot: "bg-rose-100 text-rose-800 ring-rose-200",
  warm: "bg-amber-100 text-amber-900 ring-amber-200",
  cold: "bg-sky-100 text-sky-800 ring-sky-200",
};

const OUTCOMES: Readonly<Record<string, { readonly label: string; readonly text: string }>> = {
  book_meeting: {
    label: "Book a meeting",
    text: "This lead scores high enough to be booked straight into the calendar.",
  },
  contact_later: {
    label: "Team follows up",
    text: "The customer is told the team will be in touch, and the business gets the report.",
  },
  disqualify: {
    label: "Polite no",
    text: "Not a fit under this business's rules. The assistant says so kindly.",
  },
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  new: "New",
  qualifying: "Qualifying",
  qualified: "Qualified",
  meeting_requested: "Meeting requested",
  meeting_booked: "Meeting booked",
  handed_off: "Handed to a person",
  disqualified: "Not a fit",
};

function storageKey(widgetKey: string): string {
  return `hsrb-chat:${widgetKey}`;
}

function readToken(widgetKey: string): string | null {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey(widgetKey)) ?? "{}") as {
      token?: unknown;
    };
    return typeof stored.token === "string" ? stored.token : null;
  } catch {
    return null;
  }
}

function Empty({ botName }: { readonly botName: string }) {
  return (
    <div className="space-y-3 text-sm text-slate-300">
      <p>
        Chat with {botName} the way a customer would. While you talk, this panel fills in with what
        the business receives:
      </p>
      <ul className="space-y-2">
        {[
          ["A score from 0 to 100", "weighted by what this business cares about"],
          ["Every answer", "with the customer's own words as evidence"],
          ["The next step", "book now, call back, or a polite no"],
          ["A written report", "ready for whoever picks up the phone"],
        ].map(([title, text]) => (
          <li key={title} className="flex gap-2">
            <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-emerald-400" />
            <span>
              <span className="font-medium text-white">{title}</span>, {text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Score({ lead }: { readonly lead: WidgetDemoLead }) {
  const score = lead.score ?? 0;
  const band = lead.band?.toLowerCase() ?? "";
  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <p className="text-5xl font-semibold tracking-tight text-white tabular-nums">
          <span data-testid="demo-score">{score}</span>
          <span className="text-lg font-normal text-slate-400"> / 100</span>
        </p>
        <div className="flex flex-col items-end gap-1 pb-1">
          {lead.band === null ? null : (
            <span
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset",
                BAND_STYLES[band] ?? "bg-slate-100 text-slate-800 ring-slate-200",
              )}
            >
              {lead.band.charAt(0).toUpperCase() + lead.band.slice(1)} lead
            </span>
          )}
          {lead.status === null ? null : (
            <span className="text-xs text-slate-400">
              {STATUS_LABELS[lead.status] ?? lead.status}
            </span>
          )}
        </div>
      </div>
      <div
        className="mt-3 h-2 overflow-hidden rounded-full bg-slate-700"
        role="progressbar"
        aria-label="Lead score"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
      >
        <div
          className="h-full rounded-full bg-emerald-400 transition-[width] duration-700"
          style={{ width: `${Math.max(2, Math.min(100, score))}%` }}
        />
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="border-t border-slate-700/70 pt-4">
      <h3 className="mb-2 text-xs font-semibold tracking-wider text-slate-400 uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Lead({ lead }: { readonly lead: WidgetDemoLead }) {
  const outcome = lead.routingOutcome === null ? null : OUTCOMES[lead.routingOutcome];
  return (
    <div className="space-y-4">
      <Score lead={lead} />

      {outcome === null || outcome === undefined ? null : (
        <Section title="Next step">
          <p className="text-sm font-semibold text-white" data-testid="demo-outcome">
            {outcome.label}
          </p>
          <p className="mt-0.5 text-sm text-slate-300">{outcome.text}</p>
          {lead.routingReasons.length === 0 ? null : (
            <ul className="mt-2 list-inside list-disc space-y-0.5 text-xs text-slate-400">
              {lead.routingReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section title="Learned so far">
        {lead.fields.length === 0 ? (
          <p className="text-sm text-slate-400">Nothing yet. Keep chatting.</p>
        ) : (
          <dl className="space-y-2.5" data-testid="demo-fields">
            {lead.fields.map((field) => (
              <div key={field.key}>
                <dt className="text-xs text-slate-400">{field.label}</dt>
                <dd className="text-sm font-medium break-words text-white">{field.value}</dd>
                {field.evidence === null ? null : (
                  <dd className="mt-0.5 text-xs break-words text-slate-400 italic">
                    “{field.evidence}”
                  </dd>
                )}
              </div>
            ))}
          </dl>
        )}
      </Section>

      {lead.open.length === 0 ? null : (
        <Section title="Still finding out">
          <ul className="flex flex-wrap gap-1.5">
            {lead.open.map((label) => (
              <li
                key={label}
                className="rounded-full border border-slate-600 px-2 py-0.5 text-xs text-slate-300"
              >
                {label}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {lead.report === null ? null : (
        <Section title="Report for the business">
          <p className="text-sm text-slate-200">{lead.report.summary}</p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-medium text-emerald-300 hover:text-emerald-200">
              Read the full report
            </summary>
            <div className="mt-2 rounded-md bg-white p-3">
              <ReportText markdown={lead.report.markdown} />
            </div>
          </details>
        </Section>
      )}
    </div>
  );
}

export function LeadPanel({
  widgetKey,
  botName,
}: {
  readonly widgetKey: string;
  readonly botName: string;
}) {
  const [lead, setLead] = useState<WidgetDemoLead | null>(null);
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const token = readToken(widgetKey);
      setHasSession(token !== null);
      if (token === null) {
        setLead(null);
      } else {
        try {
          const response = await fetch("/api/widget/v1/demo/lead", {
            headers: { authorization: `Bearer ${token}` },
            cache: "no-store",
          });
          if (stopped) return;
          if (response.ok) setLead((await response.json()) as WidgetDemoLead);
          else if (response.status === 401 || response.status === 404) setLead(null);
        } catch {
          // Offline for a moment: keep what is shown and try again.
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), document.hidden ? HIDDEN_MS : FAST_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [widgetKey]);

  const startOver = () => {
    try {
      localStorage.removeItem(storageKey(widgetKey));
    } catch {
      // Storage is unavailable: a reload starts a fresh chat anyway.
    }
    window.location.reload();
  };

  return (
    <div
      className="rounded-2xl bg-slate-900 p-5 text-white shadow-xl ring-1 ring-slate-800"
      data-testid="demo-lead-panel"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-wider text-emerald-400 uppercase">
            Behind the scenes
          </p>
          <h2 className="text-lg font-semibold">What the business sees</h2>
        </div>
        <span className="mt-1 inline-flex items-center gap-1.5 text-xs text-slate-400">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
          </span>
          Live
        </span>
      </div>

      {lead?.started === true ? <Lead lead={lead} /> : <Empty botName={botName} />}

      {hasSession && lead?.started === true ? (
        <button
          type="button"
          onClick={startOver}
          className="mt-5 w-full rounded-md border border-slate-600 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:outline-none"
        >
          Start over as a new customer
        </button>
      ) : null}
    </div>
  );
}
