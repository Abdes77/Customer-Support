/**
 * Splits a reply into parts no longer than `maxLength` (the channel's `maxTextLength`),
 * preferring, in order: paragraph breaks, line breaks, sentence ends, spaces, and only then a
 * hard cut. Parts are trimmed and never empty; joining them with a space or a newline gives
 * back the same words in the same order.
 */
export function splitText(text: string, maxLength: number): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError(`maxLength must be a positive integer, got ${maxLength}`);
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= maxLength) return [trimmed];

  const parts: string[] = [];
  let rest = trimmed;
  while (rest.length > maxLength) {
    const cut = findCut(rest, maxLength);
    const head = rest.slice(0, cut).trim();
    if (head.length > 0) parts.push(head);
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/** Where to cut `text` so that the head fits in `maxLength`. Always in 1..maxLength. */
function findCut(text: string, maxLength: number): number {
  const window = text.slice(0, maxLength + 1);
  // Do not accept a break so early that the part would be tiny: at least a third of the room.
  const minimum = Math.floor(maxLength / 3);

  const candidates: RegExp[] = [
    /\n\s*\n/g, // paragraph
    /\n/g, // line
    /[.!?…](?=["')\]]*\s)["')\]]*/g, // sentence end, keeping closing quotes with it
    /[;:,](?=\s)/g, // clause
    /\s/g, // word
  ];
  for (const pattern of candidates) {
    let best = -1;
    for (const match of window.matchAll(pattern)) {
      const end = match.index + match[0].length;
      // A whitespace break cuts before the whitespace; punctuation keeps its mark.
      const at = /^\s+$/.test(match[0]) ? match.index : end;
      if (at <= maxLength && at >= minimum) best = at;
    }
    if (best > 0) return best;
  }
  // Hard cut, but never between the two halves of a surrogate pair (an emoji).
  const code = text.charCodeAt(maxLength - 1);
  return code >= 0xd800 && code <= 0xdbff && maxLength > 1 ? maxLength - 1 : maxLength;
}
