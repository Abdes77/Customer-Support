import type { ReactNode } from "react";

/**
 * A lead report (C5 writes it as simple Markdown: "## heading", "- item", "**bold**") shown as
 * plain React text: headings, paragraphs and lists, never as HTML, so nothing in it can run.
 */
export function ReportText({ markdown }: { readonly markdown: string }) {
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  const clean = (line: string) => line.replaceAll("**", "").trim();
  const flush = () => {
    if (items.length > 0) {
      blocks.push(
        <ul key={`l${blocks.length}`} className="list-inside list-disc">
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>,
      );
      items = [];
    }
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("- ") || line.startsWith("* ")) {
      items.push(clean(line.slice(2)));
      continue;
    }
    flush();
    if (line === "") continue;
    if (line.startsWith("#")) {
      blocks.push(
        <p key={`h${blocks.length}`} className="font-semibold text-slate-800">
          {clean(line.replace(/^#+\s*/, ""))}
        </p>,
      );
    } else {
      blocks.push(<p key={`p${blocks.length}`}>{clean(line)}</p>);
    }
  }
  flush();
  return <div className="space-y-1.5 text-xs break-words text-slate-700">{blocks}</div>;
}
