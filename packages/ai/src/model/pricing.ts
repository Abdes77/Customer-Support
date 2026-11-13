import type { ModelUsage } from "./types";

/**
 * List prices of the Claude API in US dollars per million tokens, for the spend caps and
 * reports of later chunks. Source: the model table of the API reference as cached on
 * 2026-11-03; check the pricing page before relying on a figure for billing.
 *
 * Where the table gives no cache-read price, a tenth of the input price is used (the
 * general rule). A cache write is billed at 1.25 times the input price for the five-minute lifetime and
 * twice the input price for one hour. A `ModelCallRecord` does not say which lifetime was
 * written, so the estimate uses the five-minute rate.
 */
interface ModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
}

const PRICES: readonly (readonly [prefix: string, price: ModelPrice])[] = [
  ["claude-fable-5-2", { input: 8, output: 40, cacheRead: 0.2 }],
  ["claude-mythos-5-2", { input: 8, output: 40, cacheRead: 0.2 }],
  ["claude-fable-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-mythos-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-fable-5", { input: 10, output: 50, cacheRead: 1 }],
  ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2 }],
  ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-8", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-7", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4-6", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.1 }],
  ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-4-6", { input: 3, output: 15, cacheRead: 0.3 }],
  ["claude-haiku-5-5", { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  ["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1 }],
];

const CACHE_WRITE_FACTOR = 1.25;

/**
 * The estimated cost of one call in millionths of a US dollar, or null for a model without
 * a known price (the offline model, a model released after this table).
 */
export function estimateCostMicroUsd(model: string, usage: ModelUsage): number | null {
  // Longest prefix first: "claude-opus-5-5" must not be priced as "claude-opus-5".
  const price = [...PRICES]
    .sort((a, b) => b[0].length - a[0].length)
    .find(([prefix]) => model.startsWith(prefix))?.[1];
  if (price === undefined) return null;
  // Dollars per million tokens is the same number as micro-dollars per token.
  return Math.round(
    usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadInputTokens * price.cacheRead +
      usage.cacheCreationInputTokens * price.input * CACHE_WRITE_FACTOR,
  );
}
