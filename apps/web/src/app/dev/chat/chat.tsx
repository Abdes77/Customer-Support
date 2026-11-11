"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

import type { TestChatMessage, TestChatView } from "@repo/channel-test/server";

import { loadTestConversation, sendTestMessage } from "./actions";

const EMPTY: TestChatView = { conversationId: null, messages: [] };
const POLL_MS = 1500;

function bubbleClass(message: TestChatMessage): string {
  const base = "max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm shadow-sm";
  if (message.author === "customer") return `${base} self-end bg-blue-700 text-white`;
  if (message.author === "human_agent") return `${base} self-start bg-emerald-100 text-emerald-950`;
  return `${base} self-start bg-slate-100 text-slate-900`;
}

const AUTHOR_LABEL: Readonly<Record<TestChatMessage["author"], string>> = {
  customer: "You (as the customer)",
  bot: "Bot",
  human_agent: "Person at the business",
};

/**
 * The chat itself: sends messages through the test channel and polls the conversation.
 * Replies arrive through the real pipeline, so they appear after the business's reply wait.
 */
export function DevChat(props: {
  readonly businessId: string;
  readonly visitorId: string;
  readonly available: boolean;
}) {
  const { businessId, visitorId, available } = props;
  const [chat, setChat] = useState<TestChatView>(EMPTY);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const view = await loadTestConversation({ businessId, visitorId });
        if (active) setChat(view);
      } catch {
        // The next poll tries again.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [businessId, visitorId]);

  const count = chat.messages.length;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [count]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (text.trim().length === 0 || sending) return;
    setSending(true);
    try {
      const result = await sendTestMessage({ businessId, visitorId, text });
      if (result.ok) {
        setText("");
        setError(null);
        setChat(await loadTestConversation({ businessId, visitorId }));
      } else {
        setError(result.error);
      }
    } catch {
      setError("The message could not be sent. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="flex min-h-[60vh] flex-col rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4" aria-live="polite">
        {chat.messages.length === 0 ? (
          <p className="m-auto text-sm text-slate-500">
            Write as a customer would. The bot answers through the same pipeline as every channel.
          </p>
        ) : (
          chat.messages.map((message) => (
            <div key={message.id} className="flex flex-col">
              <span
                className={`mb-0.5 text-xs text-slate-500 ${message.author === "customer" ? "self-end" : "self-start"}`}
              >
                {AUTHOR_LABEL[message.author]}
                {message.author !== "customer" && message.status !== "sent"
                  ? ` · ${message.status}`
                  : ""}
              </span>
              <p
                className={`${bubbleClass(message)} ${message.status === "superseded" || message.status === "failed" ? "opacity-50 line-through" : ""}`}
              >
                {message.text ?? "(no text)"}
              </p>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
      <form
        onSubmit={(event) => void onSubmit(event)}
        className="flex gap-2 border-t border-slate-200 p-3"
      >
        <label className="sr-only" htmlFor="dev-chat-text">
          Message
        </label>
        <input
          id="dev-chat-text"
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-base outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
          value={text}
          maxLength={2000}
          onChange={(event) => setText(event.target.value)}
          placeholder={available ? "Type a message…" : "The test channel is not available"}
          disabled={!available || sending}
          autoComplete="off"
        />
        <button
          type="submit"
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
          disabled={!available || sending || text.trim().length === 0}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
      {error === null ? null : (
        <p role="alert" className="px-3 pb-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
