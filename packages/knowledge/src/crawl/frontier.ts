/**
 * Which pages of a business's website the crawler visits, and in which order. The crawler
 * stays on the business's own host (with or without "www."), skips files and pages that
 * hold nothing about the business (carts, log-ins, tag archives), and visits the pages most
 * likely to state facts first: services, service area, about, financing, warranties,
 * reviews, FAQ, contact.
 */

const FILE_EXTENSION =
  /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|mp[34]|mov|avi|wmv|webm|zip|rar|gz|tar|7z|docx?|xlsx?|pptx?|csv|xml|json|rss|atom|css|js|map|woff2?|ttf|eot|exe|dmg|apk)$/i;

const SKIPPED_PATH =
  /\/(?:wp-admin|wp-login|wp-json|wp-content|wp-includes|cart|checkout|basket|login|log-in|signin|sign-in|signup|register|account|my-account|admin|search|feed|tag|tags|author|cdn-cgi|privacy|privacy-policy|terms|terms-of-service|cookie|cookies|sitemap|print|share)(?:\/|$)/i;

const PRIORITY: readonly (readonly [RegExp, number])[] = [
  [/service-?area|areas?-?(?:we-?)?serve|locations?|coverage|cities/i, 9],
  [/services?|what-we-do|repair|install|replace|maintenance/i, 8],
  [/about|our-(?:story|team|company)|who-we-are|why-(?:choose-)?us|meet/i, 8],
  [/financ|payment/i, 7],
  [/warrant|guarantee/i, 7],
  [/licen[sc]|insur|certif|accredit/i, 6],
  [/reviews?|testimonials?/i, 6],
  [/faqs?|questions/i, 6],
  [/contact|hours/i, 5],
  [/pricing|prices|specials?|offers?|coupons?/i, 5],
  [/brands?|products?|manufacturers?/i, 4],
  [/blog|news|articles?|posts?|press|careers?|jobs?|gallery|photos?|portfolio|projects?/i, -4],
];

const siteHost = (hostname: string) => hostname.toLowerCase().replace(/^www\./, "");

/** The key a page is remembered by: host and path, without "www.", a trailing slash or tracking. */
export function pageKey(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const params = [...url.searchParams.entries()]
    .filter(([name]) => !/^(?:utm_|fbclid$|gclid$|msclkid$|mc_|ref$|source$)/i.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.map(([name, value]) => `${name}=${value}`).join("&");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/index\.(?:html?|php|aspx?)$/i, "");
  return `${siteHost(url.hostname)}${path}${query.length > 0 ? `?${query}` : ""}`;
}

/** True when both addresses are on the same website. */
export function sameSite(a: string, b: string): boolean {
  try {
    return siteHost(new URL(a).hostname) === siteHost(new URL(b).hostname);
  } catch {
    return false;
  }
}

/** Whether a link found on the site is a page worth fetching. */
export function isCrawlable(raw: string, startUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (!sameSite(raw, startUrl)) return false;
  if (url.port.length > 0 && url.port !== new URL(startUrl).port) return false;
  if (FILE_EXTENSION.test(url.pathname) || SKIPPED_PATH.test(url.pathname)) return false;
  // A page reached only through several parameters is usually a filter or a calendar.
  if ([...url.searchParams.keys()].length > 2) return false;
  return url.pathname.split("/").length <= 7 && raw.length <= 300;
}

/** How promising a page is; higher first. The path decides, shallow pages win ties. */
export function pagePriority(raw: string): number {
  let path: string;
  try {
    path = new URL(raw).pathname;
  } catch {
    return -100;
  }
  let score = 0;
  for (const [pattern, weight] of PRIORITY) {
    if (pattern.test(path)) score = score === 0 ? weight : Math.max(score, weight);
  }
  const depth = path.split("/").filter((part) => part.length > 0).length;
  return score - depth * 0.5;
}

export interface Frontier {
  /** The next page to visit, or null when there is none or the budget is spent. */
  next(): string | null;
  /** Adds the links of a visited page. */
  add(links: readonly string[]): void;
  readonly visited: number;
}

/**
 * The crawl order. Deterministic: the same pages and links give the same order, which a
 * durable job needs when it replays its steps.
 */
export function createFrontier(startUrl: string, maxPages: number): Frontier {
  const seen = new Set<string>();
  const queue: { url: string; priority: number; order: number }[] = [];
  let visited = 0;
  let order = 0;
  const push = (url: string, priority: number) => {
    const key = pageKey(url);
    if (key === null || seen.has(key)) return;
    seen.add(key);
    queue.push({ url, priority, order: order++ });
  };
  // The start page comes first whatever its path.
  push(startUrl, Number.POSITIVE_INFINITY);
  return {
    next() {
      if (visited >= maxPages || queue.length === 0) return null;
      queue.sort((a, b) => b.priority - a.priority || a.order - b.order);
      const entry = queue.shift();
      if (entry === undefined) return null;
      visited += 1;
      return entry.url;
    },
    add(links) {
      for (const link of links) {
        if (isCrawlable(link, startUrl)) push(link, pagePriority(link));
      }
    },
    get visited() {
      return visited;
    },
  };
}
