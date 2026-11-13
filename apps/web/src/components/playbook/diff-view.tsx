import { formatPriceNorm, PLAYBOOK_SECTION_LABELS, type PlaybookSection } from "@repo/core";
import type { PlaybookDiff } from "@repo/knowledge";

/** One entry of a section as a line of text. */
export function entryText(section: PlaybookSection, entry: unknown): string {
  if (typeof entry === "string") return entry;
  const record = (entry ?? {}) as Record<string, unknown>;
  const text = (name: string) => (typeof record[name] === "string" ? record[name] : "");
  switch (section) {
    case "commonJobs":
      return `${text("name")}: ${text("scope")}`;
    case "customerLanguage":
      return `“${text("phrase")}”: ${text("meaning")}`;
    case "urgencySignals":
      return `[${text("level")}] ${text("signal")}`;
    case "qualificationQuestions":
      return `${text("question")} (${text("why")})`;
    case "objections":
      return `${text("objection")} → ${text("response")}`;
    case "priceNorms":
      try {
        return `${text("job")}: ${formatPriceNorm(record as never)}`;
      } catch {
        return text("job");
      }
    case "vocabulary":
      return `${text("term")}: ${text("definition")}`;
    case "sources":
      return `${text("title")} (${text("url")})`;
    case "seasonalPatterns":
    case "permitsAndRegulations":
      return String(entry);
  }
}

/** What changed between two versions, section by section, as text. */
export function DiffView({ diff }: { readonly diff: PlaybookDiff }) {
  if (diff.identical)
    return <p className="text-sm text-slate-600">The two versions are the same.</p>;
  return (
    <div className="space-y-4" data-testid="playbook-diff">
      {diff.sections
        .filter((section) => diff.changedSections.includes(section.section))
        .map((section) => (
          <section key={section.section} className="rounded-lg border border-slate-200 bg-white">
            <h3 className="border-b border-slate-100 px-4 py-2 font-medium text-slate-900">
              {PLAYBOOK_SECTION_LABELS[section.section]}
              {section.reordered && (
                <span className="ml-2 text-xs font-normal text-slate-500">(reordered)</span>
              )}
            </h3>
            <ul className="divide-y divide-slate-100 text-sm">
              {section.added.map((entry, index) => (
                <li key={`a${index}`} className="bg-emerald-50 px-4 py-2 text-emerald-950">
                  <span className="font-semibold">Added: </span>
                  {entryText(section.section, entry)}
                </li>
              ))}
              {section.removed.map((entry, index) => (
                <li key={`r${index}`} className="bg-red-50 px-4 py-2 text-red-950">
                  <span className="font-semibold">Removed: </span>
                  {entryText(section.section, entry)}
                </li>
              ))}
              {section.changed.map((change, index) => (
                <li key={`c${index}`} className="px-4 py-2">
                  <p className="text-red-900">
                    <span className="font-semibold">Before: </span>
                    {entryText(section.section, change.before)}
                  </p>
                  <p className="text-emerald-900">
                    <span className="font-semibold">After: </span>
                    {entryText(section.section, change.after)}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}
