import { type NextRequest, NextResponse } from "next/server";

import type { CookieJar, CookieOptions } from "./types";

/** What `await cookies()` from next/headers returns, as far as the jar needs it. */
interface NextCookieStore {
  getAll(): { name: string; value: string }[];
  set(name: string, value: string, options?: CookieOptions): unknown;
}

/**
 * The cookie store of a route handler, server action or server component. Server components
 * cannot set cookies (the response has started); a refresh attempted there is dropped, and
 * `proxy.ts` renews the session on the next request instead.
 */
export function jarFromCookieStore(store: NextCookieStore): CookieJar {
  return {
    getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
    set(name, value, options) {
      try {
        store.set(name, value, options);
      } catch {
        // Called while rendering a server component: nothing can be written here.
      }
    },
  };
}

/**
 * The request and response pair of `proxy.ts`. A cookie that is set goes onto the request
 * (so the page rendered next sees the renewed session) and onto the response (so the
 * browser stores it).
 */
export class ProxyCookieJar implements CookieJar {
  private current: NextResponse;
  private readonly changed: { name: string; value: string; options: CookieOptions }[] = [];
  private headers: Readonly<Record<string, string>> = {};

  constructor(private readonly request: NextRequest) {
    this.current = NextResponse.next({ request });
  }

  getAll(): { name: string; value: string }[] {
    return this.request.cookies.getAll().map(({ name, value }) => ({ name, value }));
  }

  set(name: string, value: string, options: CookieOptions): void {
    this.request.cookies.set(name, value);
    this.changed.push({ name, value, options });
    this.rebuild();
  }

  setHeaders(headers: Readonly<Record<string, string>>): void {
    this.headers = { ...this.headers, ...headers };
    this.rebuild();
  }

  /** The response to return from the proxy. */
  get response(): NextResponse {
    return this.current;
  }

  private rebuild(): void {
    // The response must be made again after the request cookies changed, or the page would
    // be rendered with the old ones.
    this.current = NextResponse.next({ request: this.request });
    for (const cookie of this.changed) {
      this.current.cookies.set(cookie.name, cookie.value, cookie.options);
    }
    for (const [name, value] of Object.entries(this.headers)) {
      this.current.headers.set(name, value);
    }
  }
}

/** A cookie jar in memory, for tests. */
export class MemoryCookieJar implements CookieJar {
  readonly cookies = new Map<string, { value: string; options: CookieOptions }>();

  constructor(initial: Readonly<Record<string, string>> = {}) {
    for (const [name, value] of Object.entries(initial)) {
      this.cookies.set(name, { value, options: {} });
    }
  }

  getAll(): { name: string; value: string }[] {
    return [...this.cookies.entries()]
      .filter(([, cookie]) => cookie.options.maxAge !== 0)
      .map(([name, cookie]) => ({ name, value: cookie.value }));
  }

  set(name: string, value: string, options: CookieOptions): void {
    this.cookies.set(name, { value, options });
  }

  get(name: string): string | undefined {
    return this.getAll().find((cookie) => cookie.name === name)?.value;
  }
}
