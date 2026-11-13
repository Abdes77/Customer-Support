import { Badge, type BadgeTone } from "@/components/ui/badge";

/**
 * The stored state of a connection, said plainly (C16). Only what is stored is shown: a
 * connection is "Connected" because its row says active, never because a page guessed.
 */
const STATES: Readonly<Record<string, { label: string; tone: BadgeTone }>> = {
  active: { label: "Connected", tone: "green" },
  pending: { label: "Waiting to finish", tone: "amber" },
  error: { label: "Error", tone: "red" },
  revoked: { label: "Needs reconnecting", tone: "red" },
  disabled: { label: "Disconnected", tone: "neutral" },
};

/** True when the stored error says the account must be connected again. */
export function needsReconnect(status: string, lastError: string | null): boolean {
  return (
    status === "revoked" ||
    (status === "error" &&
      lastError !== null &&
      /connect it again|reconnect|refused the app/i.test(lastError))
  );
}

export function ConnectionBadge({
  status,
  lastError,
}: {
  readonly status: string;
  readonly lastError: string | null;
}) {
  if (needsReconnect(status, lastError)) {
    return (
      <Badge tone="red" className="connection-status">
        Needs reconnecting
      </Badge>
    );
  }
  const state = STATES[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={state.tone}>{state.label}</Badge>;
}

/** The stored reason of an error, as text. */
export function ConnectionError({ message }: { readonly message: string | null }) {
  if (message === null || message === "") return null;
  return (
    <p className="mt-1 text-sm break-words text-red-800" data-testid="connection-error">
      {message}
    </p>
  );
}

/** A section that this deployment cannot offer: what is missing, and where it is explained. */
export function NotOnThisDeployment({
  what,
  variables,
  todo,
}: {
  readonly what: string;
  readonly variables: readonly string[];
  readonly todo: string;
}) {
  return (
    <div
      className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700"
      data-testid="not-configured"
    >
      <p className="font-medium text-slate-900">{what} is not set up on this deployment.</p>
      <p className="mt-1">
        It needs{" "}
        {variables.map((name, index) => (
          <span key={name}>
            {index > 0 && (index === variables.length - 1 ? " and " : ", ")}
            <code className="rounded bg-white px-1 text-xs">{name}</code>
          </span>
        ))}
        . The steps are in docs/HUMAN_TODO.md ({todo}). Nothing here is connected until then.
      </p>
    </div>
  );
}
