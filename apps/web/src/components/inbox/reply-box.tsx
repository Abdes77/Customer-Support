"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { sendReplyAction, typingAction } from "@/app/(admin)/_actions/inbox";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form";

const TYPING_EVERY_MS = 30_000;

function newKey(): string {
  return crypto.randomUUID();
}

/**
 * The reply box of a conversation the person holds (C16). The reply goes through the
 * conversation's own channel by the pipeline's send path. Each draft carries a key, so a
 * double click or a retried request sends the reply once; while the person types, the
 * takeover's idle clock is moved forward (at most every 30 s) so the bot does not take the
 * conversation back in the middle of a reply.
 */
export function ReplyBox({
  conversationId,
  channelLabel,
}: {
  readonly conversationId: string;
  readonly channelLabel: string;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [key, setKey] = useState(newKey);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const lastTyping = useRef(0);

  const onType = (value: string) => {
    setText(value);
    setSent(null);
    const now = Date.now();
    if (value.trim() !== "" && now - lastTyping.current > TYPING_EVERY_MS) {
      lastTyping.current = now;
      void typingAction({ conversationId }).catch(() => undefined);
    }
  };

  const submit = () => {
    if (text.trim() === "" || pending) return;
    startTransition(async () => {
      try {
        const result = await sendReplyAction({ conversationId, text, key });
        if (result.ok) {
          setText("");
          setKey(newKey());
          setError(null);
          setSent(
            result.value.duplicate
              ? "This reply had already been sent; it was not sent again."
              : `Sent through ${channelLabel}.`,
          );
          router.refresh();
        } else {
          setError(result.error);
        }
      } catch {
        // The same key is kept: sending again cannot send the reply twice.
        setError("The reply could not be sent. Check your connection and send it again.");
      }
    });
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor="reply" className="text-sm font-medium text-slate-800">
        Reply to the customer
      </label>
      <Textarea
        id="reply"
        name="reply"
        value={text}
        // The draft cannot change while it is being sent: its key stands for this text.
        readOnly={pending}
        maxLength={4000}
        rows={3}
        placeholder={`Write a reply. It goes out through ${channelLabel}.`}
        onChange={(event) => onType(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || text.trim() === ""}>
          {pending ? "Sending…" : "Send reply"}
        </Button>
        <span className="text-xs text-slate-500">{text.length} / 4,000</span>
        {sent !== null && (
          <span role="status" className="text-sm text-emerald-800">
            {sent}
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
