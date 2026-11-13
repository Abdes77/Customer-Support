"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { publicEnv } from "@/env.public";

/**
 * Keeps a server-rendered screen up to date (C16). With Supabase configured, the browser
 * subscribes to Realtime changes of the named tables (row-level security decides which rows
 * it hears about) and re-renders the page when one arrives; without it, or when the
 * subscription fails, it re-renders on a timer. Re-rendering asks the server again, so what
 * appears is authorized there like the first render. Paused while the tab is hidden.
 */
export interface LiveTable {
  readonly table: "conversations" | "messages" | "takeover_locks" | "internal_notes" | "leads";
  /** A Realtime filter such as `conversation_id=eq.<uuid>`; none for the whole table. */
  readonly filter?: string;
}

export function LiveRefresh({
  tables,
  pollSeconds,
  channel,
}: {
  readonly tables: readonly LiveTable[];
  readonly pollSeconds: number;
  /** A name for the subscription, unique per screen. */
  readonly channel: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"realtime" | "polling">("polling");
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tablesKey = JSON.stringify(tables);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;

    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      if (pending.current !== null) return;
      pending.current = setTimeout(() => {
        pending.current = null;
        router.refresh();
      }, 400);
    };
    const poll = (seconds: number) => {
      if (timer !== null) clearInterval(timer);
      timer = setInterval(refresh, seconds * 1000);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    poll(pollSeconds);
    const url = publicEnv.supabaseUrl;
    const key = publicEnv.supabaseAnonKey;
    if (url !== undefined && url !== "" && key !== undefined && key !== "") {
      void (async () => {
        try {
          const { createBrowserClient } = await import("@supabase/ssr");
          if (cancelled) return;
          const client = createBrowserClient(url, key);
          const { data } = await client.auth.getSession();
          if (cancelled) return;
          if (data.session !== null) await client.realtime.setAuth(data.session.access_token);
          let live = client.channel(`admin:${channel}`);
          for (const item of JSON.parse(tablesKey) as LiveTable[]) {
            live = live.on(
              "postgres_changes",
              {
                event: "*",
                schema: "public",
                table: item.table,
                ...(item.filter === undefined ? {} : { filter: item.filter }),
              },
              refresh,
            );
          }
          live.subscribe((state) => {
            const status = String(state);
            if (cancelled) return;
            if (status === "SUBSCRIBED") {
              setMode("realtime");
              // A slow safety net: a missed event is picked up within a minute.
              poll(60);
            } else if (
              status === "CHANNEL_ERROR" ||
              status === "TIMED_OUT" ||
              status === "CLOSED"
            ) {
              setMode("polling");
              poll(pollSeconds);
            }
          });
          unsubscribe = () => {
            void client.removeChannel(live);
          };
        } catch {
          // Realtime is an improvement; polling keeps the screen current without it.
          setMode("polling");
        }
      })();
    }

    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
      if (pending.current !== null) clearTimeout(pending.current);
      pending.current = null;
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe?.();
    };
  }, [router, pollSeconds, channel, tablesKey]);

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500" data-live={mode}>
      <span
        aria-hidden="true"
        className={
          mode === "realtime"
            ? "size-2 rounded-full bg-emerald-500"
            : "size-2 rounded-full bg-slate-400"
        }
      />
      {mode === "realtime" ? "Live" : `Updates every ${pollSeconds} s`}
    </span>
  );
}
