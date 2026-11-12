import http from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isPublicAddress } from "./address";
import {
  createSafeFetcher,
  type ResolvedAddress,
  type SafeFetcherDeps,
  type Transport,
  UnsafeUrlError,
} from "./safe-fetch";

/*
 * Server-side request forgery (docs/ARCHITECTURE.md §3, "Threats"): the crawler fetches
 * addresses that users supply and that web pages link to. None of them may reach anything
 * but the public internet.
 */

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "169.254.0.1",
    "100.64.0.1", // carrier-grade NAT
    "100.127.255.255",
    "0.0.0.0",
    "0.1.2.3",
    "192.0.0.1",
    "192.0.2.10",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:a9fe:a9fe", // 169.254.169.254, mapped, in hex
    "::7f00:1", // IPv4-compatible loopback
    "64:ff9b::7f00:1", // NAT64 to loopback
    "64:ff9b::a00:1",
    "64:ff9b:1::1",
    "2002:7f00:1::1", // 6to4 to loopback
    "2002:c0a8:101::1", // 6to4 to 192.168.1.1
    "fc00::1",
    "fd12:3456:789a::1",
    "fe80::1",
    "febf::1",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    "2001::1",
    "100::1",
    "[::1]",
    "fe80::1%eth0",
    "",
    "localhost",
    "999.1.1.1",
    "1.2.3",
    "0x7f.0.0.1",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "169.253.1.1",
    "192.167.1.1",
    "198.17.255.255",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2a00:1450:4001:81b::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
    "[2606:4700:4700::1111]",
  ])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

const PUBLIC: ResolvedAddress = { address: "93.184.216.34", family: 4 };

/** A fetcher whose network is a function: no socket is opened. */
function fakeFetcher(
  hosts: Record<string, readonly ResolvedAddress[]>,
  pages: (
    url: URL,
    address: ResolvedAddress,
  ) => ReturnType<Transport> extends Promise<infer R> ? R : never,
  deps: Partial<SafeFetcherDeps> = {},
) {
  const connections: { url: string; address: string }[] = [];
  const lookups: string[] = [];
  const fetcher = createSafeFetcher({
    resolve: async (hostname) => {
      lookups.push(hostname);
      const found = hosts[hostname];
      if (found === undefined) throw new Error("ENOTFOUND");
      return found;
    },
    transport: async ({ url, address }) => {
      connections.push({ url: url.toString(), address: address.address });
      return pages(url, address);
    },
    ...deps,
  });
  return { fetcher, connections, lookups };
}

const page = (body = "<html>ok</html>") => ({
  status: 200,
  headers: { "content-type": "text/html" },
  body: new TextEncoder().encode(body),
});
const redirect = (location: string, status = 302) => ({
  status,
  headers: { location },
  body: new Uint8Array(),
});

async function reasonOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return "fetched";
  } catch (error) {
    if (error instanceof UnsafeUrlError) return error.reason;
    throw error;
  }
}

describe("the guarded fetcher: what it refuses before connecting", () => {
  const { fetcher, connections } = fakeFetcher({ "site.example.com": [PUBLIC] }, () => page());

  it.each([
    ["file:///etc/passwd", "scheme"],
    ["ftp://site.example.com/a", "scheme"],
    ["gopher://site.example.com/", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["data:text/html,<p>x</p>", "scheme"],
    ["not a url", "invalid_url"],
    ["//site.example.com/", "invalid_url"],
    ["https://admin:secret@site.example.com/", "credentials"],
    ["https://user@site.example.com/", "credentials"],
    ["https://site.example.com:8443/", "port"],
    ["http://site.example.com:22/", "port"],
    ["http://site.example.com:6379/", "port"],
    ["http://localhost/", "host"],
    ["http://LOCALHOST./", "host"],
    ["http://intranet/", "host"],
    ["http://db.internal/", "host"],
    ["http://printer.local/", "host"],
    ["http://app.localhost/", "host"],
    ["http://router.lan/", "host"],
    ["http://127.0.0.1/", "address"],
    ["http://127.1/", "address"], // short form of 127.0.0.1
    ["http://2130706433/", "address"], // the same address as one number
    ["http://0x7f000001/", "address"], // ... in hex
    ["http://017700000001/", "address"], // ... in octal
    ["http://0/", "address"],
    ["http://10.0.0.5/admin", "address"],
    ["http://192.168.0.1/", "address"],
    ["http://169.254.169.254/latest/meta-data/", "address"],
    ["http://[::1]/", "address"],
    ["http://[::ffff:127.0.0.1]/", "address"],
    ["http://[::ffff:a9fe:a9fe]/", "address"],
    ["http://[fd00::1]/", "address"],
    ["http://[fe80::1]/", "address"],
  ])("%s → %s", async (url, reason) => {
    expect(await reasonOf(fetcher.fetch(url))).toBe(reason);
  });

  it("opened no connection for any of them", () => {
    expect(connections).toEqual([]);
  });
});

describe("the guarded fetcher: names, addresses and redirects", () => {
  it("refuses a name that resolves to a private address, or to a mix of public and private", async () => {
    const { fetcher, connections } = fakeFetcher(
      {
        "inside.example.com": [{ address: "10.1.2.3", family: 4 }],
        "metadata.example.com": [{ address: "169.254.169.254", family: 4 }],
        "mixed.example.com": [PUBLIC, { address: "127.0.0.1", family: 4 }],
        "v6.example.com": [{ address: "fd00::5", family: 6 }],
        "mapped.example.com": [{ address: "::ffff:192.168.1.1", family: 6 }],
        "nothing.example.com": [],
      },
      () => page(),
    );
    for (const host of ["inside", "metadata", "mixed", "v6", "mapped"]) {
      expect(await reasonOf(fetcher.fetch(`https://${host}.example.com/`)), host).toBe("address");
    }
    expect(await reasonOf(fetcher.fetch("https://nothing.example.com/"))).toBe("dns");
    expect(await reasonOf(fetcher.fetch("https://unknown.example.com/"))).toBe("dns");
    expect(connections).toEqual([]);
  });

  it("counts the name lookup towards the time limit: a resolver that never answers times out", async () => {
    const fetcher = createSafeFetcher({
      resolve: () => new Promise(() => undefined),
      transport: async () => page(),
    });
    const started = Date.now();
    expect(await reasonOf(fetcher.fetch("https://slow-dns.example.com/", { timeoutMs: 200 }))).toBe(
      "timeout",
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("connects to exactly the address it checked, resolving the name once per hop", async () => {
    // A resolver that answers differently the second time (DNS rebinding).
    let answers = 0;
    const connections: string[] = [];
    const fetcher = createSafeFetcher({
      resolve: async () => {
        answers += 1;
        return answers === 1 ? [PUBLIC] : [{ address: "127.0.0.1", family: 4 }];
      },
      transport: async ({ address }) => {
        connections.push(address.address);
        return page();
      },
    });
    const response = await fetcher.fetch("https://rebind.example.com/");
    expect(response.status).toBe(200);
    expect(answers).toBe(1);
    expect(connections).toEqual([PUBLIC.address]);
    // The next fetch resolves again, gets the private address, and is refused.
    expect(await reasonOf(fetcher.fetch("https://rebind.example.com/"))).toBe("address");
    expect(connections).toHaveLength(1);
  });

  it("checks every redirect like a first request", async () => {
    const hosts = {
      "site.example.com": [PUBLIC],
      "www.site.example.com": [PUBLIC],
      "inside.example.com": [{ address: "10.0.0.8", family: 4 } as const],
    };
    const cases: [string, string][] = [
      ["http://127.0.0.1/admin", "redirect"],
      ["http://169.254.169.254/latest/meta-data/iam/", "redirect"],
      ["http://[::1]:80/", "redirect"],
      ["https://inside.example.com/", "redirect"],
      ["file:///etc/passwd", "redirect"],
      ["gopher://site.example.com/", "redirect"],
      ["https://site.example.com:8080/", "redirect"],
      ["https://user:pw@site.example.com/", "redirect"],
      ["//localhost/", "redirect"],
    ];
    for (const [location, reason] of cases) {
      const { fetcher, connections } = fakeFetcher(hosts, (url) =>
        url.pathname === "/start" ? redirect(location) : page("should never be fetched"),
      );
      expect(await reasonOf(fetcher.fetch("https://site.example.com/start")), location).toBe(
        reason,
      );
      // Only the first hop was ever connected to.
      expect(connections.map((entry) => entry.url)).toEqual(["https://site.example.com/start"]);
    }

    // A redirect without a destination, and a loop.
    const noWhere = fakeFetcher(hosts, () => ({
      status: 301,
      headers: {},
      body: new Uint8Array(),
    }));
    expect(await reasonOf(noWhere.fetcher.fetch("https://site.example.com/"))).toBe("redirect");
    const loop = fakeFetcher(hosts, (url) => redirect(`${url.pathname}x`));
    expect(await reasonOf(loop.fetcher.fetch("https://site.example.com/"))).toBe(
      "too_many_redirects",
    );
    expect(loop.connections).toHaveLength(6);
  });

  it("follows good redirects, relative ones included, and reports where it ended", async () => {
    const { fetcher, connections, lookups } = fakeFetcher(
      {
        "site.example.com": [PUBLIC],
        "www.site.example.com": [{ address: "93.184.216.35", family: 4 }],
      },
      (url) =>
        url.hostname === "site.example.com"
          ? redirect("https://www.site.example.com/home", 301)
          : url.pathname === "/home"
            ? redirect("../services?x=1#top", 307)
            : page("<p>Services</p>"),
    );
    const response = await fetcher.fetch("http://site.example.com/");
    expect(response.url).toBe("https://www.site.example.com/services?x=1");
    expect(response.text()).toBe("<p>Services</p>");
    expect(response.redirects).toEqual([
      "http://site.example.com/",
      "https://www.site.example.com/home",
    ]);
    expect(connections.map((entry) => entry.address)).toEqual([
      "93.184.216.34",
      "93.184.216.35",
      "93.184.216.35",
    ]);
    expect(lookups).toEqual(["site.example.com", "www.site.example.com", "www.site.example.com"]);
  });

  it("sends nothing but a plain GET: no cookies, no credentials", async () => {
    let seen: Readonly<Record<string, string>> = {};
    const fetcher = createSafeFetcher({
      resolve: async () => [PUBLIC],
      transport: async ({ headers }) => {
        seen = headers;
        return page();
      },
    });
    await fetcher.fetch("https://site.example.com/");
    expect(Object.keys(seen).sort()).toEqual([
      "accept",
      "accept-encoding",
      "accept-language",
      "user-agent",
    ]);
    expect(seen["user-agent"]).toContain("HomeServicesReplyBot");
  });
});

describe("the guarded fetcher over real sockets", () => {
  let server: http.Server;
  let port: number;
  const seenHosts: string[] = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      seenHosts.push(request.headers.host ?? "");
      const url = new URL(request.url ?? "/", "http://x");
      const html = { "content-type": "text/html; charset=utf-8" };
      switch (url.pathname) {
        case "/":
          response.writeHead(200, html).end("<html><body>Hello from the site</body></html>");
          return;
        case "/gzip":
          response
            .writeHead(200, { ...html, "content-encoding": "gzip" })
            .end(gzipSync("<p>compressed page</p>"));
          return;
        case "/brotli":
          response
            .writeHead(200, { ...html, "content-encoding": "br" })
            .end(brotliCompressSync("<p>brotli page</p>"));
          return;
        case "/bomb":
          // Small on the wire, huge once unpacked.
          response
            .writeHead(200, { ...html, "content-encoding": "gzip" })
            .end(gzipSync(Buffer.alloc(4 * 1024 * 1024, 97)));
          return;
        case "/big":
          response.writeHead(200, html).end(Buffer.alloc(300_000, 98));
          return;
        case "/pdf":
          response.writeHead(200, { "content-type": "application/pdf" }).end("%PDF-1.7");
          return;
        case "/slow":
          response.writeHead(200, html);
          response.write("<p>start");
          return; // never ends
        case "/to-loopback":
          response.writeHead(302, { location: "http://127.0.0.1:1/secret" }).end();
          return;
        case "/to-root":
          response.writeHead(301, { location: "/" }).end();
          return;
        case "/missing":
          response.writeHead(404, html).end("<p>not found</p>");
          return;
        default:
          response.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  /**
   * "business-site.example.com" resolves to the test server. Only this test widens the
   * address rule, and only for the loopback address the server listens on.
   */
  const fetcher = () =>
    createSafeFetcher({
      resolve: async (hostname) => {
        if (hostname !== "business-site.example.com") throw new Error("ENOTFOUND");
        return [{ address: "127.0.0.1", family: 4 }];
      },
      isAllowedAddress: (address) => address === "127.0.0.1" || isPublicAddress(address),
      extraPorts: [port],
    });
  const at = (path: string) => `http://business-site.example.com:${port}${path}`;

  it("fetches a page through the pinned address, with the site's own Host header", async () => {
    const response = await fetcher().fetch(at("/"));
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("text/html");
    expect(response.text()).toContain("Hello from the site");
    expect(seenHosts.at(-1)).toBe(`business-site.example.com:${port}`);
  });

  it("unpacks gzip and brotli, and stops a response that unpacks past the limit", async () => {
    expect((await fetcher().fetch(at("/gzip"))).text()).toBe("<p>compressed page</p>");
    expect((await fetcher().fetch(at("/brotli"))).text()).toBe("<p>brotli page</p>");
    expect(await reasonOf(fetcher().fetch(at("/bomb")))).toBe("too_large");
    expect(await reasonOf(fetcher().fetch(at("/big"), { maxBytes: 100_000 }))).toBe("too_large");
    expect((await fetcher().fetch(at("/big"), { maxBytes: 400_000 })).body.byteLength).toBe(
      300_000,
    );
  });

  it("refuses what is not a page, gives up on a server that never finishes, and reports statuses", async () => {
    expect(await reasonOf(fetcher().fetch(at("/pdf")))).toBe("content_type");
    expect(await reasonOf(fetcher().fetch(at("/slow"), { timeoutMs: 300 }))).toBe("timeout");
    expect((await fetcher().fetch(at("/missing"))).status).toBe(404);
    const followed = await fetcher().fetch(at("/to-root"));
    expect(followed.url).toBe(at("/"));
    expect(followed.redirects).toEqual([at("/to-root")]);
  });

  it("does not follow a redirect to another port or to a loopback address", async () => {
    expect(await reasonOf(fetcher().fetch(at("/to-loopback")))).toBe("redirect");
  });

  it("with the product's own rules, the very same server is out of reach", async () => {
    const strict = createSafeFetcher({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    expect(await reasonOf(strict.fetch(`http://business-site.example.com:${port}/`))).toBe("port");
    expect(await reasonOf(strict.fetch("http://business-site.example.com/"))).toBe("address");
    expect(await reasonOf(strict.fetch(`http://127.0.0.1:${port}/`))).toBe("port");
    expect(await reasonOf(createSafeFetcher().fetch("http://127.0.0.1/"))).toBe("address");
  });
});
