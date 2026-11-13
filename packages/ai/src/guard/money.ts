/**
 * Dollar amounts in text, for the rule that the bot never states a price it was not given.
 * Recognized: "$1,200", "$ 85", "$1.5k", "$2 million", "1,200 dollars", "300 bucks",
 * "450 USD". Percentages, phone numbers, ZIP codes and years are not money.
 */

const MULTIPLIERS: Readonly<Record<string, number>> = {
  k: 1_000,
  thousand: 1_000,
  grand: 1_000,
  m: 1_000_000,
  million: 1_000_000,
};

const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const SCALE = String.raw`(?:\s?(k|thousand|grand|m|million)\b)?`;
/** What follows "$5" in "$5-7k" or "$5 to 7 thousand": the scale belongs to both ends. */
const SCALED_RANGE_TAIL = new RegExp(
  String.raw`^\s?(?:-|–|to)\s?(?:${NUMBER})\s?(?:k|thousand|grand|m|million)\b`,
  "i",
);
const PATTERNS = [
  // $1,200 · $1.5k · $ 85 · $5-10k is read as two amounts by the range pattern below.
  new RegExp(String.raw`\$\s?(${NUMBER})${SCALE}`, "gi"),
  // the second half of "$5,000-$7,000" has its own "$"; "$5-7k" does not:
  new RegExp(String.raw`\$\s?(?:${NUMBER})\s?(?:-|–|to)\s?(${NUMBER})${SCALE}`, "gi"),
  new RegExp(String.raw`(${NUMBER})${SCALE}\s?(?:dollars|bucks|usd)\b`, "gi"),
];

function toNumber(digits: string, scale: string | undefined): number {
  const base = Number(digits.replaceAll(",", ""));
  return base * (scale === undefined ? 1 : (MULTIPLIERS[scale.toLowerCase()] ?? 1));
}

/** Every dollar amount in the text, as numbers. */
export function moneyAmounts(text: string): number[] {
  const found: number[] = [];
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const digits = match[1];
      if (digits === undefined) continue;
      // "$5-7k" is $5,000 to $7,000, not $5: the range pattern below reads both ends.
      if (
        pattern === PATTERNS[0] &&
        match[2] === undefined &&
        SCALED_RANGE_TAIL.test(text.slice(match.index + match[0].length))
      ) {
        continue;
      }
      const amount = toNumber(digits, match[2]);
      if (Number.isFinite(amount)) found.push(amount);
      // "$5-7k": the scale belongs to both ends.
      if (pattern === PATTERNS[1] && match[2] !== undefined) {
        const first = /\$\s?(\d[\d,]*(?:\.\d+)?)/.exec(match[0])?.[1];
        if (first !== undefined) found.push(toNumber(first, match[2]));
      }
    }
  }
  return [...new Set(found)];
}

/** The amounts in `text` that are not among the allowed ones. */
export function unknownAmounts(text: string, allowed: ReadonlySet<number>): number[] {
  return moneyAmounts(text).filter((amount) => !allowed.has(amount));
}

const WHITESPACE = /\s/;

/**
 * The sentences of a text, each with its trailing whitespace, so that joining them gives the
 * text back. A period inside a number ("$1,200.50") or a domain does not end a sentence.
 */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    const ends =
      char === "\n" ||
      ((char === "." || char === "!" || char === "?") && (next === "" || WHITESPACE.test(next)));
    if (!ends) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < text.length && WHITESPACE.test(text.charAt(end))) end += 1;
    out.push(text.slice(start, end));
    start = end;
    index = end;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}
