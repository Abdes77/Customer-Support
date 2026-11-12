import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectRealtime } from "./realtime";

/** A stand-in for the browser's WebSocket that records what the client sends. */
class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  join(): Record<string, unknown> {
    const join = this.sent.find((message) => message["event"] === "phx_join");
    if (join === undefined) throw new Error("no join sent");
    return join;
  }
}

const TOPIC = "widget-0123456789abcdef0123456789abcdef01234567";
const config = (apiKey: string) => ({ url: "https://abc.supabase.co", apiKey, topic: TOPIC });
const latest = () => FakeSocket.all.at(-1)!;

describe("the Realtime client", () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("joins the visitor's public broadcast topic and pokes on a broadcast", () => {
    const pokes = vi.fn();
    const handle = connectRealtime(config("aaa.bbb.ccc"), pokes);
    const socket = latest();
    expect(socket.url).toBe(
      "wss://abc.supabase.co/realtime/v1/websocket?apikey=aaa.bbb.ccc&vsn=1.0.0",
    );
    socket.open();
    const join = socket.join();
    expect(join).toMatchObject({
      topic: `realtime:${TOPIC}`,
      payload: { config: { private: false }, access_token: "aaa.bbb.ccc" },
    });
    expect(join["join_ref"]).toBe(join["ref"]);
    expect(handle.connected()).toBe(false);

    socket.receive({
      topic: `realtime:${TOPIC}`,
      event: "phx_reply",
      ref: join["ref"],
      payload: { status: "ok", response: {} },
    });
    expect(handle.connected()).toBe(true);
    socket.receive({
      topic: `realtime:${TOPIC}`,
      event: "broadcast",
      ref: null,
      payload: { type: "broadcast", event: "poke", payload: { kind: "message" } },
    });
    expect(pokes).toHaveBeenCalledTimes(1);
    // Another topic is not ours.
    socket.receive({ topic: "realtime:other", event: "broadcast", payload: {} });
    expect(pokes).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(25_000);
    expect(socket.sent.at(-1)).toMatchObject({ topic: "phoenix", event: "heartbeat" });
    handle.close();
    expect(handle.connected()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("does not send a publishable key as an access token", () => {
    connectRealtime(config("sb_publishable_abc123"), () => undefined);
    latest().open();
    expect(latest().join()["payload"]).not.toHaveProperty("access_token");
  });

  it("falls back (not connected) on a refused join or a channel error, and reconnects", () => {
    const handle = connectRealtime(config("aaa.bbb.ccc"), () => undefined);
    const first = latest();
    first.open();
    first.receive({
      topic: `realtime:${TOPIC}`,
      event: "phx_reply",
      ref: first.join()["ref"],
      payload: { status: "error", response: { reason: "Unauthorized" } },
    });
    expect(handle.connected()).toBe(false);
    expect(first.readyState).toBe(3);
    vi.advanceTimersByTime(30_000);
    const second = latest();
    expect(second).not.toBe(first);
    second.open();
    second.receive({
      topic: `realtime:${TOPIC}`,
      event: "phx_reply",
      ref: second.join()["ref"],
      payload: { status: "ok" },
    });
    expect(handle.connected()).toBe(true);

    second.receive({ topic: `realtime:${TOPIC}`, event: "phx_error", payload: {} });
    expect(handle.connected()).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(latest()).not.toBe(second);
    handle.close();
  });

  it("never throws when the socket cannot be created", () => {
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          throw new Error("blocked by the page's content security policy");
        }
      },
    );
    const handle = connectRealtime(config("aaa.bbb.ccc"), () => undefined);
    expect(handle.connected()).toBe(false);
    vi.advanceTimersByTime(60_000);
    handle.close();
  });
});
