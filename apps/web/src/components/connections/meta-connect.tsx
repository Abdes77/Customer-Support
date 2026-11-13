"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/form";

import { postJson } from "./client";

/*
 * Meta's own dialogs in the browser (C16): WhatsApp Embedded Signup (C9) and Facebook Login
 * for Business (C10). Meta's JavaScript SDK opens the dialog and hands back a one-time code
 * (and, for WhatsApp, the chosen number's ids by `postMessage` from facebook.com); the code
 * goes to our route, which exchanges it on the server. No token ever reaches this page.
 */

interface FacebookSdk {
  init(options: { appId: string; version: string; xfbml: boolean; cookie: boolean }): void;
  login(
    callback: (response: { authResponse?: { code?: string } | null; status?: string }) => void,
    options: Record<string, unknown>,
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let sdk: Promise<FacebookSdk> | null = null;

function loadSdk(appId: string, version: string): Promise<FacebookSdk> {
  sdk ??= new Promise<FacebookSdk>((resolve, reject) => {
    const ready = () => {
      if (window.FB === undefined) {
        reject(new Error("sdk"));
        return;
      }
      window.FB.init({ appId, version, xfbml: false, cookie: false });
      resolve(window.FB);
    };
    if (window.FB !== undefined) {
      ready();
      return;
    }
    window.fbAsyncInit = ready;
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      sdk = null;
      reject(new Error("sdk"));
    };
    document.body.appendChild(script);
  });
  return sdk;
}

function login(fb: FacebookSdk, options: Record<string, unknown>): Promise<string | null> {
  return new Promise((resolve) => {
    fb.login((response) => resolve(response.authResponse?.code ?? null), options);
  });
}

export interface MetaConfig {
  readonly appId: string;
  readonly configId: string;
  readonly graphApiVersion: string;
}

/** WhatsApp Embedded Signup: the client picks or registers a number in Meta's dialog. */
export function WhatsAppSignupButton({
  businessId,
  config,
}: {
  readonly businessId: string;
  readonly config: MetaConfig;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const start = () =>
    startTransition(async () => {
      setError(null);
      let fb: FacebookSdk;
      try {
        fb = await loadSdk(config.appId, config.graphApiVersion);
      } catch {
        setError(
          "Meta's sign-in could not be loaded. Check that the browser can reach facebook.com.",
        );
        return;
      }
      // Embedded Signup reports the chosen account and number by postMessage.
      let ids: { waba: string; phone: string } | null = null;
      const onMessage = (event: MessageEvent) => {
        if (!/^https:\/\/([a-z0-9-]+\.)*facebook\.com$/.test(event.origin)) return;
        try {
          const data = (typeof event.data === "string" ? JSON.parse(event.data) : event.data) as {
            type?: string;
            event?: string;
            data?: { phone_number_id?: string; waba_id?: string };
          };
          if (
            data.type === "WA_EMBEDDED_SIGNUP" &&
            data.data?.phone_number_id &&
            data.data.waba_id
          ) {
            ids = { waba: data.data.waba_id, phone: data.data.phone_number_id };
          }
        } catch {
          // Not a message for us.
        }
      };
      window.addEventListener("message", onMessage);
      const code = await login(fb, {
        config_id: config.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
      });
      // The postMessage can arrive just after the dialog closes.
      await new Promise((resolve) => setTimeout(resolve, 500));
      window.removeEventListener("message", onMessage);
      const chosen = ids as { waba: string; phone: string } | null;
      if (code === null || chosen === null) {
        setError("The signup was not finished in Meta's window. Nothing was connected.");
        return;
      }
      const result = await postJson("/api/oauth/meta/whatsapp", {
        businessId,
        code,
        businessAccountId: chosen.waba,
        phoneNumberId: chosen.phone,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone("The number is connected.");
      router.refresh();
    });
  return (
    <div className="space-y-1">
      <Button size="sm" onClick={start} disabled={pending}>
        {pending ? "Waiting for Meta…" : "Connect a WhatsApp number"}
      </Button>
      {done !== null && (
        <p role="status" className="text-sm text-emerald-800">
          {done}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

interface PageChoice {
  readonly pageId: string;
  readonly name: string | null;
  readonly instagramUsername: string | null;
  readonly hasInstagram: boolean;
  readonly canMessage: boolean;
}

/** Facebook Login for Business: a Page for Messenger and its Instagram account. */
export function FacebookLoginButton({
  businessId,
  config,
}: {
  readonly businessId: string;
  readonly config: MetaConfig;
}) {
  const router = useRouter();
  const [messenger, setMessenger] = useState(true);
  const [instagram, setInstagram] = useState(true);
  const [pages, setPages] = useState<readonly PageChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const channels = [...(messenger ? ["messenger"] : []), ...(instagram ? ["instagram"] : [])];
  const run = (pageId: string | null) =>
    startTransition(async () => {
      setError(null);
      let fb: FacebookSdk;
      try {
        fb = await loadSdk(config.appId, config.graphApiVersion);
      } catch {
        setError(
          "Meta's sign-in could not be loaded. Check that the browser can reach facebook.com.",
        );
        return;
      }
      // A code works once: choosing a Page logs in again (DECISIONS 174).
      const code = await login(fb, {
        config_id: config.configId,
        response_type: "code",
        override_default_response_type: true,
      });
      if (code === null) {
        setError("The login was not finished in Meta's window. Nothing was connected.");
        return;
      }
      const result = await postJson("/api/oauth/meta/facebook", {
        businessId,
        code,
        channels,
        ...(pageId === null ? {} : { pageId }),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.data["outcome"] === "choose_page" && Array.isArray(result.data["pages"])) {
        setPages(result.data["pages"] as PageChoice[]);
        return;
      }
      setPages(null);
      setDone("Connected.");
      router.refresh();
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-4 text-sm text-slate-800">
        <label className="inline-flex items-center gap-2">
          <Checkbox checked={messenger} onChange={(event) => setMessenger(event.target.checked)} />
          Messenger
        </label>
        <label className="inline-flex items-center gap-2">
          <Checkbox checked={instagram} onChange={(event) => setInstagram(event.target.checked)} />
          Instagram
        </label>
      </div>
      <Button size="sm" onClick={() => run(null)} disabled={pending || channels.length === 0}>
        {pending ? "Waiting for Meta…" : "Connect with Facebook"}
      </Button>
      {pages !== null && (
        <div className="space-y-2 rounded-lg border border-slate-200 p-3">
          <p className="text-sm font-medium text-slate-900">
            The login shared several Pages. Choose one; Meta asks you to confirm once more.
          </p>
          <ul className="space-y-2">
            {pages.map((page) => (
              <li key={page.pageId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 break-words">
                  {page.name ?? page.pageId}
                  {page.instagramUsername !== null && ` (Instagram @${page.instagramUsername})`}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending || !page.canMessage}
                  onClick={() => run(page.pageId)}
                >
                  {page.canMessage ? "Use this Page" : "Your role cannot send messages"}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {done !== null && (
        <p role="status" className="text-sm text-emerald-800">
          {done}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
