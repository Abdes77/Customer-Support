"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";

import type { ActionResult } from "@/server/admin/result";
import { Button, type ButtonVariant } from "@/components/ui/button";

/**
 * A button that runs one server action with a fixed input, shows its answer (or its error)
 * and re-renders the page. The input holds ids only; the server decides what is allowed.
 */
export function ActionButton<T>({
  action,
  input,
  children,
  variant = "secondary",
  confirm,
  showResult = true,
  testId,
}: {
  readonly action: (input: unknown) => Promise<ActionResult<T>>;
  readonly input: Record<string, unknown>;
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  /** Asked before running, for actions that are hard to undo. */
  readonly confirm?: string;
  readonly showResult?: boolean;
  readonly testId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        variant={variant}
        size="sm"
        disabled={pending}
        data-testid={testId}
        onClick={() => {
          if (confirm !== undefined && !window.confirm(confirm)) return;
          startTransition(async () => {
            try {
              const result = await action(input);
              if (result.ok) {
                setMessage(
                  showResult && typeof result.value === "string"
                    ? { ok: true, text: result.value }
                    : null,
                );
                router.refresh();
              } else {
                setMessage({ ok: false, text: result.error });
              }
            } catch {
              setMessage({
                ok: false,
                text: "That could not be sent. Check your connection and try again.",
              });
            }
          });
        }}
      >
        {children}
      </Button>
      {message !== null && (
        <span
          role={message.ok ? "status" : "alert"}
          className={message.ok ? "text-xs text-emerald-800" : "text-xs text-red-700"}
        >
          {message.text}
        </span>
      )}
    </span>
  );
}
