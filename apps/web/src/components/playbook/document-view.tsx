import {
  formatPriceNorm,
  PLAYBOOK_SECTION_LABELS,
  PLAYBOOK_SECTIONS,
  type PlaybookDocument,
  type PlaybookSection,
} from "@repo/core";

import { Badge } from "@/components/ui/badge";

/*
 * A playbook document, read only. Every text came from a model or a person and is rendered
 * as text. Source links open in a new tab without the referrer and only for http(s).
 */

function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function SectionBody({
  document,
  section,
}: {
  readonly document: PlaybookDocument;
  readonly section: PlaybookSection;
}) {
  switch (section) {
    case "commonJobs":
      return (
        <dl className="space-y-2">
          {document.commonJobs.map((entry, index) => (
            <div key={index}>
              <dt className="font-medium text-slate-900">{entry.name}</dt>
              <dd className="text-slate-700">{entry.scope}</dd>
            </div>
          ))}
        </dl>
      );
    case "customerLanguage":
      return (
        <dl className="space-y-2">
          {document.customerLanguage.map((entry, index) => (
            <div key={index}>
              <dt className="font-medium text-slate-900">“{entry.phrase}”</dt>
              <dd className="text-slate-700">{entry.meaning}</dd>
            </div>
          ))}
        </dl>
      );
    case "urgencySignals":
      return (
        <ul className="space-y-1.5">
          {document.urgencySignals.map((entry, index) => (
            <li key={index} className="flex items-start gap-2">
              <Badge
                tone={
                  entry.level === "emergency"
                    ? "red"
                    : entry.level === "urgent"
                      ? "amber"
                      : "neutral"
                }
              >
                {entry.level}
              </Badge>
              <span className="text-slate-700">{entry.signal}</span>
            </li>
          ))}
        </ul>
      );
    case "qualificationQuestions":
      return (
        <ol className="list-decimal space-y-2 pl-5">
          {document.qualificationQuestions.map((entry, index) => (
            <li key={index}>
              <p className="font-medium text-slate-900">{entry.question}</p>
              <p className="text-slate-700">{entry.why}</p>
            </li>
          ))}
        </ol>
      );
    case "objections":
      return (
        <dl className="space-y-2">
          {document.objections.map((entry, index) => (
            <div key={index}>
              <dt className="font-medium text-slate-900">{entry.objection}</dt>
              <dd className="text-slate-700">{entry.response}</dd>
            </div>
          ))}
        </dl>
      );
    case "seasonalPatterns":
    case "permitsAndRegulations":
      return (
        <ul className="list-disc space-y-1 pl-5 text-slate-700">
          {document[section].map((entry, index) => (
            <li key={index}>{entry}</li>
          ))}
        </ul>
      );
    case "priceNorms":
      return (
        <ul className="space-y-1.5">
          {document.priceNorms.map((entry, index) => (
            <li key={index}>
              <span className="font-medium text-slate-900">{entry.job}:</span>{" "}
              <span className="text-slate-700">{formatPriceNorm(entry)}</span>
              {entry.notes !== null && (
                <span className="block text-xs text-slate-500">{entry.notes}</span>
              )}
            </li>
          ))}
        </ul>
      );
    case "vocabulary":
      return (
        <dl className="grid gap-2 sm:grid-cols-2">
          {document.vocabulary.map((entry, index) => (
            <div key={index}>
              <dt className="font-medium text-slate-900">{entry.term}</dt>
              <dd className="text-slate-700">{entry.definition}</dd>
            </div>
          ))}
        </dl>
      );
    case "sources":
      return (
        <ul className="space-y-1">
          {document.sources.map((entry, index) => {
            const href = safeHref(entry.url);
            return (
              <li key={index} className="break-words">
                {href === null ? (
                  <span>{entry.title}</span>
                ) : (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-blue-700 underline-offset-2 hover:underline"
                  >
                    {entry.title}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      );
  }
}

export function PlaybookDocumentView({
  document,
  overridden = [],
  sections = PLAYBOOK_SECTIONS,
}: {
  readonly document: PlaybookDocument;
  readonly overridden?: readonly PlaybookSection[];
  readonly sections?: readonly PlaybookSection[];
}) {
  return (
    <div className="space-y-3">
      {sections.map((section) => (
        <details
          key={section}
          className="group rounded-lg border border-slate-200 bg-white"
          open={section === "commonJobs" || section === "qualificationQuestions"}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
            <span className="font-medium text-slate-900">
              {PLAYBOOK_SECTION_LABELS[section]}{" "}
              <span className="font-normal text-slate-500">({document[section].length})</span>
            </span>
            <span className="flex items-center gap-2">
              {overridden.includes(section) && (
                <Badge tone="violet">This business&apos;s own</Badge>
              )}
              <span aria-hidden="true" className="text-slate-400 group-open:rotate-90">
                ›
              </span>
            </span>
          </summary>
          <div className="border-t border-slate-100 px-4 py-3 text-sm">
            {document[section].length === 0 ? (
              <p className="text-slate-500">Nothing in this section.</p>
            ) : (
              <SectionBody document={document} section={section} />
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
