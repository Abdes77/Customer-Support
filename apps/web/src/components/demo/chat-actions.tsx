"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

/*
 * Buttons on the demo page that drive the chat: the chat script listens for two events on
 * the document (`hsrb-chat:open`, `hsrb-chat:send`), which any page it is embedded on may
 * send.
 */

/**
 * Tells the chat script what the visitor asked for. A click can come before the script has
 * run (it loads on its own): the request then waits in `window.hsrbChatQueue`, which the
 * script reads when it starts.
 */
function tellChat(name: "hsrb-chat:open" | "hsrb-chat:send", detail?: string): void {
  const page = window as unknown as { hsrbChatListening?: boolean; hsrbChatQueue?: unknown[] };
  if (page.hsrbChatListening === true) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
  } else {
    (page.hsrbChatQueue ??= []).push([name, detail]);
  }
}

function openChat(): void {
  tellChat("hsrb-chat:open");
}

function sendToChat(text: string): void {
  tellChat("hsrb-chat:send", text);
}

export function OpenChatButton({
  children,
  ...attributes
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "type"> & {
  readonly children: ReactNode;
}) {
  return (
    <button type="button" onClick={openChat} {...attributes}>
      {children}
    </button>
  );
}

/** Sample questions: one click opens the chat and sends the line as the visitor. */
export function PromptChips({ prompts }: { readonly prompts: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {prompts.map((prompt) => (
        <li key={prompt}>
          <button
            type="button"
            onClick={() => sendToChat(prompt)}
            className="rounded-full border border-slate-300 bg-white px-3.5 py-1.5 text-left text-sm text-slate-700 shadow-sm transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:outline-none"
          >
            “{prompt}”
          </button>
        </li>
      ))}
    </ul>
  );
}
