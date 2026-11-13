import type {
  WidgetConfig,
  WidgetError,
  WidgetMessage,
  WidgetMessages,
  WidgetProfileField,
  WidgetProfileResult,
  WidgetSession,
} from "@repo/core";

import { connectRealtime, type RealtimeHandle } from "./realtime";
import { STYLES } from "./styles";

/*
 * The website chat, as one script tag on the business's site:
 *
 *   <script src="https://app.example.com/api/widget/v1/widget.js" data-key="wpk_..." async></script>
 *
 * It talks only to the app it was loaded from, with no cookies: the visitor's session token
 * travels in a header and is kept in localStorage per widget key. Everything is drawn inside
 * a shadow root, and every piece of text from the server is set with textContent, never as
 * HTML. On load it makes one small request (the configuration); the conversation is fetched
 * only for a returning visitor or once the chat is opened.
 */

const ICON_CHAT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_SEND =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>';
const ICON_PHOTO =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>';

const FIELD_LABELS: Record<WidgetProfileField, [string, string, string]> = {
  name: ["Your name", "text", "name"],
  phone: ["Phone number", "tel", "tel"],
  email: ["Email address", "email", "email"],
};

const FAST_POLL_MS = 1500;
const OPEN_POLL_MS = 6000;
const LIVE_POLL_MS = 20000;
const AWAIT_REPLY_MS = 90_000;
/**
 * Photos above this are redrawn as a JPEG of at most SHRINK_TO_PX on the long side before
 * they are sent: serverless hosts refuse request bodies over 4.5 MB (Vercel), and the model
 * looks at photos at a smaller size anyway.
 */
const SHRINK_ABOVE_BYTES = 4 * 1024 * 1024;
const SHRINK_TO_PX = 2048;

interface Stored {
  token?: string;
  open?: boolean;
  autoOpened?: boolean;
  teaserClosed?: boolean;
  seen?: string;
}

interface Shown {
  readonly id: string;
  readonly clientId: string | null;
  readonly from: WidgetMessage["from"];
  readonly text: string | null;
  readonly photos: readonly { readonly url: string; readonly name: string | null }[];
  readonly quickReplies: readonly string[];
  state: "sent" | "pending" | "failed";
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: WidgetError | null,
  ) {
    super(body?.message ?? `Request failed (${status})`);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "class") node.className = value;
    else node.setAttribute(name, value);
  }
  for (const child of children) if (child !== null) node.append(child);
  return node;
}

function iconButton(className: string, label: string, svg: string): HTMLButtonElement {
  const button = el("button", { class: className, type: "button", "aria-label": label });
  // Fixed markup from this file, never from the server.
  button.innerHTML = svg;
  return button;
}

/** Text with http(s) links made clickable, built from text nodes only. */
function linkified(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g)) {
    const index = match.index;
    fragment.append(text.slice(last, index));
    const link = el("a", { href: match[0], target: "_blank", rel: "noopener noreferrer nofollow" });
    link.textContent = match[0];
    fragment.append(link);
    last = index + match[0].length;
  }
  fragment.append(text.slice(last));
  return fragment;
}

/** A large photo redrawn smaller as a JPEG; the file itself when it is small or cannot be drawn. */
async function shrink(file: File): Promise<Blob> {
  if (file.size <= SHRINK_ABOVE_BYTES) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, SHRINK_TO_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.85);
    });
    return blob !== null && blob.size < file.size ? blob : file;
  } catch {
    // A type this browser cannot draw (HEIC outside Safari): the server decides.
    return file;
  }
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function boot(script: HTMLScriptElement): void {
  const key = script.dataset["key"] ?? "";
  const api = `${new URL(script.src).origin}/api/widget/v1`;
  const storageKey = `hsrb-chat:${key}`;
  const flag = `__hsrbChat_${key}`;
  const globals = window as unknown as Record<string, unknown>;
  if (key === "" || globals[flag] === true) return;
  globals[flag] = true;

  const load = (): Stored => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Stored;
    } catch {
      return {};
    }
  };
  const save = (patch: Partial<Stored>) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ ...load(), ...patch }));
    } catch {
      // Private mode or storage disabled: the chat still works for this page view.
    }
  };

  let token: string | null = load().token ?? null;

  async function call<T>(
    path: string,
    init: { method?: string; json?: unknown; form?: FormData; auth?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.auth === true && token !== null) headers["authorization"] = `Bearer ${token}`;
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form !== undefined) {
      body = init.form;
    }
    const response = await fetch(`${api}${path}`, {
      method: init.method ?? "GET",
      headers,
      body,
      credentials: "omit",
      mode: "cors",
    });
    const data = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw new ApiError(response.status, data as WidgetError | null);
    return data as T;
  }

  void call<WidgetConfig>(`/config?key=${encodeURIComponent(key)}`).then(
    (config) => render(config),
    (error: unknown) => {
      console.warn(
        "Chat widget: not shown.",
        error instanceof ApiError && error.status === 403
          ? "This website is not on the business's list of allowed sites."
          : error,
      );
    },
  );

  function render(config: WidgetConfig): void {
    const host = el("div", { id: `hsrb-chat-${key}` });
    // Inherited styles of the page (font, letter-spacing...) stop at the host element.
    host.style.cssText = "all:initial";
    const shadow = host.attachShadow({ mode: "open" });
    host.style.setProperty("--p", config.appearance.primaryColor);
    host.style.setProperty("--op", config.appearance.textColor);
    shadow.append(el("style", {}, STYLES));

    const left = config.appearance.position === "bottom_left";
    const root = el("div", { class: left ? "root left" : "root" });
    const mobile = window.matchMedia("(max-width: 640px)");

    // --- closed state: bubble and teaser ---------------------------------------------------
    const bubble = iconButton("bubble", `Chat with ${config.businessName}`, ICON_CHAT);
    bubble.setAttribute("aria-expanded", "false");
    const badge = el("span", { class: "badge", hidden: "" });
    bubble.append(badge);
    const teaserClose = el("button", { class: "x", type: "button", "aria-label": "Dismiss" }, "×");
    const teaser = el(
      "div",
      { class: "teaser", hidden: "" },
      config.appearance.teaser,
      teaserClose,
    );

    // --- panel -------------------------------------------------------------------------------
    const avatar = el("div", { class: "avatar", "aria-hidden": "true" });
    const logo = config.appearance.logoUrl;
    if (logo !== null && /^https?:\/\//.test(logo)) {
      avatar.append(el("img", { src: logo, alt: "" }));
    } else {
      avatar.textContent = (config.botName || config.businessName).charAt(0).toUpperCase();
    }
    const close = iconButton("icon", "Close chat", ICON_CLOSE);
    const head = el(
      "div",
      { class: "head" },
      avatar,
      el(
        "div",
        { class: "titles" },
        el("div", { class: "title" }, config.appearance.title),
        config.appearance.subtitle === ""
          ? null
          : el("div", { class: "subtitle" }, config.appearance.subtitle),
      ),
      close,
    );
    const notice =
      config.hours.notice === null ? null : el("div", { class: "notice" }, config.hours.notice);
    const log = el("div", { class: "log", role: "log", "aria-live": "polite" });
    const typing = el(
      "div",
      { class: "typing", hidden: "", "aria-label": `${config.botName || "We"} is typing` },
      el("i"),
      el("i"),
      el("i"),
    );
    const chips = el("div", { class: "chips", hidden: "" });
    const errorLine = el("div", { class: "error", role: "alert", hidden: "" });

    const textarea = el("textarea", {
      rows: "1",
      placeholder: "Type your message…",
      "aria-label": "Message",
      maxlength: String(config.maxTextLength),
    });
    const send = iconButton("send", "Send", ICON_SEND);
    const fileInput = el("input", {
      type: "file",
      accept: "image/*",
      class: "sr",
      tabindex: "-1",
      "aria-hidden": "true",
    });
    const attach = config.photos.enabled ? iconButton("icon", "Send a photo", ICON_PHOTO) : null;
    const compose = el(
      "form",
      { class: "compose" },
      attach,
      config.photos.enabled ? fileInput : null,
      textarea,
      send,
    );

    let privacy: HTMLElement | null = null;
    if (config.privacy.text !== "") {
      privacy = el("div", { class: "privacy" });
      if (config.privacy.url !== null && /^https?:\/\//.test(config.privacy.url)) {
        const link = el("a", {
          href: config.privacy.url,
          target: "_blank",
          rel: "noopener noreferrer",
        });
        link.textContent = config.privacy.text;
        privacy.append(link);
      } else {
        privacy.textContent = config.privacy.text;
      }
    }

    const form = el("form", { class: "form", hidden: "" });
    const panel = el(
      "div",
      { class: "panel", role: "dialog", "aria-label": config.appearance.title, hidden: "" },
      head,
      notice,
      log,
      chips,
      errorLine,
      form,
      compose,
      privacy,
    );

    root.append(panel, teaser, bubble);
    shadow.append(root);
    document.body.append(host);

    // --- state ---------------------------------------------------------------------------------
    const shown = new Map<string, Shown>();
    let cursor: string | null = null;
    let session: WidgetSession | null = null;
    let starting: Promise<WidgetSession | null> | null = null;
    let realtime: RealtimeHandle | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let awaitingUntil = 0;
    let serverTyping = false;
    let fetching = false;
    let refetch = false;
    let unread = 0;
    let isOpen = false;
    let bodyOverflow: string | null = null;

    const greeting = el("div", { class: "msg bot" });
    greeting.append(linkified(config.greeting));
    if (config.greeting !== "") log.append(greeting);

    function showError(message: string | null): void {
      errorLine.textContent = message ?? "";
      errorLine.hidden = message === null;
    }

    function scrollDown(): void {
      log.scrollTop = log.scrollHeight;
    }

    function draw(): void {
      for (const node of Array.from(log.children)) if (node !== greeting) node.remove();
      let lastFrom: Shown["from"] | null = null;
      let last: Shown | null = null;
      for (const message of shown.values()) {
        if (message.from === "team" && lastFrom !== "team") {
          log.append(el("div", { class: "who" }, `${config.businessName} team`));
        }
        const bubbleClass = message.from === "visitor" ? "visitor" : "bot";
        const node = el("div", {
          class: `msg ${bubbleClass}${message.text === null ? " photo" : ""}${message.state === "sent" ? "" : ` ${message.state}`}`,
          "data-from": message.from,
        });
        for (const photo of message.photos) {
          node.append(el("img", { src: photo.url, alt: photo.name ?? "Photo" }));
        }
        if (message.text !== null) node.append(linkified(message.text));
        log.append(node);
        lastFrom = message.from;
        last = message;
      }
      const isTyping = serverTyping || Date.now() < awaitingUntil;
      typing.hidden = !isTyping;
      log.append(typing);

      chips.replaceChildren();
      const options = last !== null && last.from !== "visitor" ? last.quickReplies : [];
      for (const option of options) {
        const chip = el("button", { class: "chip", type: "button" }, option);
        chip.addEventListener("click", () => void sendText(option));
        chips.append(chip);
      }
      chips.hidden = options.length === 0;
      scrollDown();
    }

    function drawProfileForm(): void {
      const needs = session?.needsProfile ?? [];
      form.hidden = needs.length === 0;
      compose.hidden = needs.length > 0;
      if (needs.length === 0) return;
      form.replaceChildren(el("p", {}, "Before we start, how can we reach you?"));
      for (const field of needs) {
        const [label, type, autocomplete] = FIELD_LABELS[field];
        form.append(
          el(
            "label",
            {},
            label,
            el("input", { name: field, type, autocomplete, required: "", maxlength: "120" }),
          ),
        );
      }
      form.append(el("button", { class: "primary", type: "submit" }, "Start chat"));
    }

    function remember(messages: readonly WidgetMessage[]): number {
      let fresh = 0;
      for (const message of messages) {
        if (message.clientId !== null) shown.delete(`local:${message.clientId}`);
        if (!shown.has(message.id)) {
          fresh += message.from === "visitor" ? 0 : 1;
          if (message.from !== "visitor") awaitingUntil = 0;
        }
        shown.set(message.id, { ...message, state: "sent" });
      }
      return fresh;
    }

    async function startSession(): Promise<WidgetSession | null> {
      starting ??= (async () => {
        try {
          const started = await call<WidgetSession>("/session", {
            method: "POST",
            json: { key, token },
          });
          session = started;
          token = started.token;
          save({ token });
          if (!started.resumed) {
            shown.clear();
            cursor = null;
          }
          // Each session has its own topic: follow it when a new session replaces an old one.
          // Realtime only speeds things up; if it cannot start, the widget polls.
          if (realtime !== null && realtime.topic !== started.realtime?.topic) {
            realtime.close();
            realtime = null;
          }
          if (started.realtime !== null && realtime === null) {
            try {
              realtime = connectRealtime(started.realtime, () => void poll());
            } catch {
              realtime = null;
            }
          }
          drawProfileForm();
          return started;
        } catch (error) {
          showError(
            error instanceof ApiError && error.body !== null
              ? error.body.message
              : "The chat could not connect. Please try again.",
          );
          return null;
        } finally {
          starting = null;
        }
      })();
      return starting;
    }

    function schedule(): void {
      clearTimeout(timer);
      if (session === null || document.hidden) return;
      const waiting = serverTyping || Date.now() < awaitingUntil;
      const live = realtime?.connected() === true;
      if (!isOpen && !live && !waiting) return;
      const delay = waiting ? FAST_POLL_MS : live ? LIVE_POLL_MS : OPEN_POLL_MS;
      timer = setTimeout(() => void poll(), delay);
    }

    async function poll(): Promise<void> {
      if (session === null) return;
      if (fetching) {
        refetch = true;
        return;
      }
      fetching = true;
      try {
        const first = cursor === null;
        const query = cursor === null ? "" : `?after=${encodeURIComponent(cursor)}`;
        const page = await call<WidgetMessages>(`/messages${query}`, { auth: true });
        cursor = page.cursor === "" ? cursor : page.cursor;
        serverTyping = page.typing;
        const fresh = remember(page.messages);
        // History restored on page load is not news; replies that arrive while closed are.
        if (fresh > 0 && !isOpen && !first) {
          unread += fresh;
          badge.textContent = String(unread);
          badge.hidden = false;
        }
        draw();
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          // The session ended (expired or revoked): start a fresh one next time.
          token = null;
          session = null;
          save({ token: undefined });
        } else if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          // The site was taken off the list or the chat switched off: stop asking.
          session = null;
        }
      } finally {
        fetching = false;
        if (refetch) {
          refetch = false;
          void poll();
        } else {
          schedule();
        }
      }
    }

    async function ensureSession(): Promise<WidgetSession | null> {
      return session ?? (await startSession());
    }

    /** The session, when the visitor may write now; otherwise shows why not. */
    async function readyToWrite(): Promise<boolean> {
      const ready = await ensureSession();
      if (ready === null) return false;
      if (ready.needsProfile.length > 0) {
        drawProfileForm();
        showError("Please fill in your details first.");
        return false;
      }
      return true;
    }

    async function post(local: Shown, body: { json?: unknown; form?: FormData }): Promise<void> {
      try {
        await call("/messages", { method: "POST", auth: true, ...body });
        local.state = "sent";
        showError(null);
        awaitingUntil = Date.now() + AWAIT_REPLY_MS;
      } catch (error) {
        local.state = "failed";
        showError(
          error instanceof ApiError && error.body !== null
            ? error.body.message
            : error instanceof ApiError && error.status === 413
              ? // Refused by the hosting platform before it reached the app.
                "That photo is too large. Please send a smaller one."
              : "Your message could not be sent. Please try again.",
        );
        if (error instanceof ApiError && error.status === 401) {
          token = null;
          session = null;
          save({ token: undefined });
        }
      }
      draw();
      void poll();
    }

    async function sendText(raw: string): Promise<void> {
      const text = raw.trim();
      if (text === "") return;
      if (!(await readyToWrite())) {
        textarea.value = text;
        return;
      }
      const clientId = randomId();
      const local: Shown = {
        id: `local:${clientId}`,
        clientId,
        from: "visitor",
        text,
        photos: [],
        quickReplies: [],
        state: "pending",
      };
      shown.set(local.id, local);
      draw();
      await post(local, { json: { id: clientId, text } });
    }

    async function sendPhoto(file: File): Promise<void> {
      if (!file.type.startsWith("image/")) {
        showError("Please choose a photo.");
        return;
      }
      const upload = await shrink(file);
      if (upload.size > config.photos.maxBytes) {
        showError(
          `That photo is too large. Please send one under ${Math.floor(config.photos.maxBytes / 1048576)} MB.`,
        );
        return;
      }
      if (!(await readyToWrite())) return;
      const clientId = randomId();
      const local: Shown = {
        id: `local:${clientId}`,
        clientId,
        from: "visitor",
        text: null,
        photos: [{ url: URL.createObjectURL(upload), name: file.name }],
        quickReplies: [],
        state: "pending",
      };
      shown.set(local.id, local);
      draw();
      const data = new FormData();
      data.append("id", clientId);
      data.append("photo", upload, file.name);
      await post(local, { form: data });
    }

    function setOpen(open: boolean): void {
      isOpen = open;
      panel.hidden = !open;
      bubble.setAttribute("aria-expanded", String(open));
      root.classList.toggle("open", open);
      save({ open });
      if (mobile.matches) {
        // A full-screen chat on a phone: keep the page behind it from scrolling.
        if (open && bodyOverflow === null) {
          bodyOverflow = document.body.style.overflow;
          document.body.style.overflow = "hidden";
        } else if (!open && bodyOverflow !== null) {
          document.body.style.overflow = bodyOverflow;
          bodyOverflow = null;
        }
      }
      if (open) {
        teaser.hidden = true;
        unread = 0;
        badge.hidden = true;
        void ensureSession().then((ready) => {
          if (ready !== null) void poll();
        });
        scrollDown();
        if (!mobile.matches) textarea.focus();
      } else {
        schedule();
        bubble.focus();
      }
    }

    // --- events --------------------------------------------------------------------------------
    bubble.addEventListener("click", () => setOpen(!isOpen));
    close.addEventListener("click", () => setOpen(false));
    teaser.addEventListener("click", (event) => {
      if (event.target === teaserClose) {
        teaser.hidden = true;
        save({ teaserClosed: true });
      } else {
        setOpen(true);
      }
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && isOpen) setOpen(false);
    });
    compose.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = textarea.value;
      textarea.value = "";
      textarea.style.height = "";
      void sendText(text);
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        compose.requestSubmit();
      }
    });
    textarea.addEventListener("input", () => {
      textarea.style.height = "";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    });
    send.type = "submit";
    attach?.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (file !== undefined) void sendPhoto(file);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values: Record<string, string> = {};
      for (const input of Array.from(form.querySelectorAll("input"))) {
        values[input.name] = input.value.trim();
      }
      void (async () => {
        const ready = await ensureSession();
        if (ready === null) return;
        try {
          const result = await call<WidgetProfileResult>("/profile", {
            method: "POST",
            auth: true,
            json: values,
          });
          session = { ...ready, needsProfile: result.needsProfile };
          showError(null);
          drawProfileForm();
          if (result.needsProfile.length === 0) textarea.focus();
        } catch (error) {
          showError(
            error instanceof ApiError && error.body !== null
              ? error.body.message
              : "Your details could not be saved. Please try again.",
          );
        }
      })();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && session !== null) void poll();
      else schedule();
    });

    // --- start -----------------------------------------------------------------------------
    const stored = load();
    if (config.appearance.teaser !== "" && stored.teaserClosed !== true && stored.open !== true) {
      setTimeout(() => {
        if (!isOpen) teaser.hidden = false;
      }, 1500);
    }
    if (stored.token !== undefined) {
      // A returning visitor: restore the conversation (and the open chat, if it was open).
      void startSession().then((ready) => {
        if (ready === null) return;
        if (stored.open === true) setOpen(true);
        else void poll();
      });
    } else if (stored.open === true) {
      setOpen(true);
    }
    const autoOpen = config.appearance.autoOpenSeconds;
    if (
      autoOpen !== null &&
      stored.autoOpened !== true &&
      stored.open !== true &&
      !mobile.matches
    ) {
      setTimeout(() => {
        if (!isOpen && load().autoOpened !== true) {
          save({ autoOpened: true });
          setOpen(true);
        }
      }, autoOpen * 1000);
    }
  }
}

const current =
  (document.currentScript as HTMLScriptElement | null) ??
  document.querySelector<HTMLScriptElement>("script[data-key][src*='/api/widget/']");
if (current !== null) {
  const start = () => boot(current);
  if (document.body === null) document.addEventListener("DOMContentLoaded", start);
  else start();
}
