/**
 * robots.txt, as far as a small, polite crawler needs it (RFC 9309): the group for our user
 * agent or else the group for `*`, `Allow` and `Disallow` with `*` and `$`, and the longest
 * matching rule wins (`Allow` on a tie).
 */

export interface RobotsRules {
  /** False when the site could not tell us its rules and has to be treated as closed. */
  readonly available: boolean;
  readonly rules: readonly { readonly allow: boolean; readonly pattern: string }[];
}

export const ALLOW_ALL: RobotsRules = { available: true, rules: [] };
export const DISALLOW_ALL: RobotsRules = {
  available: false,
  rules: [{ allow: false, pattern: "/" }],
};

/** The token robots.txt files address us by. */
export const ROBOTS_AGENT = "homeservicesreplybot";

const MAX_RULES = 500;

export function parseRobots(text: string, agent = ROBOTS_AGENT): RobotsRules {
  interface Group {
    agents: string[];
    rules: { allow: boolean; pattern: string }[];
  }
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r\n?|\n/).slice(0, 5000)) {
    const line = raw.replace(/#.*$/, "").trim();
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (current === null || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === null) continue;
    if ((field === "allow" || field === "disallow") && current.rules.length < MAX_RULES) {
      // "Disallow:" with nothing after it allows everything: no rule.
      if (value.length > 0) current.rules.push({ allow: field === "allow", pattern: value });
    }
  }
  const mine = groups.filter((group) =>
    group.agents.some((name) => name !== "*" && agent.includes(name)),
  );
  const chosen = mine.length > 0 ? mine : groups.filter((group) => group.agents.includes("*"));
  return { available: true, rules: chosen.flatMap((group) => group.rules) };
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  // "*" matches any run of characters; everything else is literal.
  const parts = body.split("*");
  let position = 0;
  for (const [index, part] of parts.entries()) {
    if (index === 0) {
      if (!path.startsWith(part)) return false;
      position = part.length;
      continue;
    }
    const found = path.indexOf(part, position);
    if (found === -1) return false;
    position = found + part.length;
  }
  if (!anchored) return true;
  const last = parts.at(-1) ?? "";
  return parts.length === 1 ? path.length === body.length : path.endsWith(last);
}

/** Whether the rules let us fetch this path (with its query string). */
export function robotsAllow(rules: RobotsRules, pathWithQuery: string): boolean {
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of rules.rules) {
    if (!matches(rule.pattern, pathWithQuery)) continue;
    const length = rule.pattern.length;
    if (best === null || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length };
    }
  }
  return best === null ? true : best.allow;
}
