import type { WidgetRealtime } from "@repo/core";

/**
 * The smallest client for a Supabase Realtime broadcast channel (Phoenix protocol, JSON
 * serializer 1.0.0): join the visitor's topic, keep the socket alive, call `onPoke` for each
 * broadcast, reconnect with backoff. A poke carries no content; the widget then fetches.
 *
 * `connected()` is true only while the channel is joined: a refused join, a channel error or
 * a closed socket make it false, and the widget then polls at its normal pace. Nothing here
 * throws into the widget.
 */
export interface RealtimeHandle {
  readonly topic: string;
  readonly connected: () => boolean;
  readonly close: () => void;
}

/** A JWT (legacy anon key) can be the channel's access token; a publishable key cannot. */
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;

export function connectRealtime(config: WidgetRealtime, onPoke: () => void): RealtimeHandle {
  const url = `${config.url.replace(/^http/, "ws").replace(/\/+$/, "")}/realtime/v1/websocket?apikey=${encodeURIComponent(config.apiKey)}&vsn=1.0.0`;
  const topic = `realtime:${config.topic}`;
  let socket: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let ref = 0;
  let joinRef = "";
  let attempts = 0;
  let joined = false;
  let closed = false;

  const send = (event: string, payload: unknown, target = topic) => {
    ref += 1;
    if (event === "phx_join") joinRef = String(ref);
    if (socket?.readyState === 1) {
      socket.send(
        JSON.stringify({
          topic: target,
          event,
          payload,
          ref: String(ref),
          ...(target === topic ? { join_ref: joinRef } : {}),
        }),
      );
    }
  };

  const open = () => {
    if (closed) return;
    try {
      socket = new WebSocket(url);
    } catch {
      retry();
      return;
    }
    const current = socket;
    current.onopen = () => {
      send("phx_join", {
        config: {
          broadcast: { self: false, ack: false },
          presence: { key: "" },
          postgres_changes: [],
          private: false,
        },
        ...(JWT.test(config.apiKey) ? { access_token: config.apiKey } : {}),
      });
      clearInterval(heartbeat);
      heartbeat = setInterval(() => send("heartbeat", {}, "phoenix"), 25_000);
    };
    current.onmessage = (message: MessageEvent<string>) => {
      let data: {
        event?: string;
        topic?: string;
        ref?: string | null;
        payload?: { status?: string };
      };
      try {
        data = JSON.parse(message.data) as typeof data;
      } catch {
        return;
      }
      if (data.topic !== topic) return;
      if (data.event === "phx_reply" && data.ref === joinRef) {
        if (data.payload?.status === "ok") {
          joined = true;
          attempts = 0;
        } else {
          // Refused (private-only project, bad key...): poll, and try again later.
          joined = false;
          current.close();
        }
      } else if (data.event === "phx_error" || data.event === "phx_close") {
        joined = false;
        current.close();
      } else if (data.event === "broadcast") {
        onPoke();
      }
    };
    current.onclose = () => {
      if (socket !== current) return;
      joined = false;
      clearInterval(heartbeat);
      retry();
    };
  };

  const retry = () => {
    if (closed) return;
    attempts += 1;
    setTimeout(open, Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5)));
  };

  open();
  return {
    topic: config.topic,
    connected: () => joined,
    close: () => {
      closed = true;
      joined = false;
      clearInterval(heartbeat);
      socket?.close();
    },
  };
}
