import type { AppSettings } from "@repo/settings";
import { US_STATE_CODES } from "@repo/settings";

import { words } from "./text";

/**
 * Is the job inside the service area? Worked out from the location the conversation recorded
 * (a ZIP code, a city, an address) and the `qualification.service_area.*` settings.
 *
 * - `inside` / `outside`: settled by a ZIP code, a state or a listed place.
 * - `no_restriction`: nothing is configured, every location is accepted.
 * - `unverified`: the location cannot be checked from what is configured. That happens with
 *   a service radius (there is no ZIP-code geography in the product) and with a place name
 *   that matches none of the listed places while ZIP codes decide. The team confirms; the
 *   lead is not booked directly on an unverified location.
 */
export type AreaVerdict = "inside" | "outside" | "no_restriction" | "unverified";

export interface AreaCheck {
  readonly verdict: AreaVerdict;
  /** Why, in words for the report; never repeats the customer's text. */
  readonly why: string;
  readonly zip: string | null;
  readonly state: string | null;
}

const STATE_NAMES: Readonly<Record<string, string>> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

/** Words after a number or a name that make it part of a street ("12345 Main St", "Texas Ave"). */
const STREET_WORDS = new Set([
  "st",
  "street",
  "ave",
  "av",
  "avenue",
  "blvd",
  "boulevard",
  "rd",
  "road",
  "dr",
  "drive",
  "ln",
  "lane",
  "way",
  "ct",
  "court",
  "pl",
  "place",
  "pkwy",
  "parkway",
  "hwy",
  "highway",
  "ter",
  "terrace",
  "cir",
  "circle",
  "trl",
  "trail",
  "sq",
  "square",
  "loop",
  "pike",
  "township",
  "twp",
  "county",
]);

/** Places named after a state that lie in another one. */
const STATE_LOOKALIKES = ["kansas city", "nevada city", "virginia city", "michigan city"];

/**
 * The last five-digit group (ZIP or ZIP+4) in the text. A five-digit house number at the start
 * of an address ("12345 Main St, Austin") is not a ZIP code.
 */
export function zipIn(text: string): string | null {
  const trimmed = text.trim();
  // "12345 Research Blvd ...": a street word within the next few words.
  const houseNumber =
    /^\d{5}\s+[A-Za-z]/.test(trimmed) &&
    trimmed
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .slice(1, 6)
      .some((word) => STREET_WORDS.has(word));
  const matches = [...trimmed.matchAll(/(?<![\d-])(\d{5})(?:-\d{4})?(?!\d)/g)].filter(
    (match) => !(houseNumber && match.index === 0),
  );
  return matches.at(-1)?.[1] ?? null;
}

/**
 * A US state named in the text: its code at the end (", TX", "TX 78704"), otherwise the last
 * full state name that is not part of a street or a place name ("Washington Ave", "Kansas
 * City").
 */
export function stateIn(text: string): string | null {
  const trimmed = text.trim();
  // After a comma in any case (", tx 78704"); after a space only in capitals ("Austin TX"),
  // so that "Oak Ct 78704" is not Connecticut.
  const code =
    /,\s*([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/.exec(trimmed)?.[1]?.toUpperCase() ??
    /\s([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/.exec(trimmed)?.[1];
  if (code !== undefined && (US_STATE_CODES as readonly string[]).includes(code)) return code;

  const tokens = trimmed
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
  const joined = (from: number, count: number) => tokens.slice(from, from + count).join(" ");
  const matches: { readonly start: number; readonly end: number; readonly code: string }[] = [];
  for (const [name, stateCode] of Object.entries(STATE_NAMES)) {
    const size = name.split(" ").length;
    for (let start = 0; start + size <= tokens.length; start += 1) {
      if (joined(start, size) !== name) continue;
      if (STREET_WORDS.has(tokens[start + size] ?? "")) continue;
      if (STATE_LOOKALIKES.some((place) => joined(start, place.split(" ").length) === place)) {
        continue;
      }
      matches.push({ start, end: start + size, code: stateCode });
    }
  }
  // A name inside a longer one ("virginia" in "west virginia") does not count; the last wins.
  const whole = matches.filter(
    (match) =>
      !matches.some(
        (other) =>
          other !== match &&
          other.start <= match.start &&
          other.end >= match.end &&
          other.end - other.start > match.end - match.start,
      ),
  );
  whole.sort((a, b) => a.start - b.start);
  return whole.at(-1)?.code ?? null;
}

function placeIn(text: string, places: readonly string[]): boolean {
  const have = ` ${words(text).join(" ")} `;
  return places.some((place) => {
    const wanted = words(place).join(" ");
    return wanted.length > 0 && have.includes(` ${wanted} `);
  });
}

export function checkServiceArea(location: string, values: AppSettings): AreaCheck {
  const zips = values["qualification.service_area.zip_codes"];
  const excluded = values["qualification.service_area.excluded_zip_codes"];
  const radius = values["qualification.service_area.radius_miles"];
  const cities = values["qualification.service_area.cities"];
  const states = values["qualification.service_area.states"];
  const zip = zipIn(location);
  const state = stateIn(location);
  const result = (verdict: AreaVerdict, why: string): AreaCheck => ({ verdict, why, zip, state });

  if (zip !== null && excluded.includes(zip))
    return result("outside", "The ZIP code is one the business does not serve.");
  if (states.length > 0 && state !== null && !states.includes(state)) {
    return result("outside", `The job is in ${state}, outside the states served.`);
  }
  if (zip !== null && zips.includes(zip))
    return result("inside", "The ZIP code is one the business serves.");
  if (cities.length > 0 && placeIn(location, cities)) {
    return result("inside", "The place is one the business serves.");
  }
  if (zips.length === 0 && radius === null && cities.length === 0) {
    if (states.length === 0)
      return result("no_restriction", "No service area is set: every location is accepted.");
    return state === null
      ? result("unverified", "The state could not be told from the location.")
      : result("inside", `The job is in ${state}, a state the business serves.`);
  }
  if (radius !== null) {
    return result(
      "unverified",
      `The location could not be checked against the ${radius}-mile service radius.`,
    );
  }
  if (zip !== null && zips.length > 0) {
    return result("outside", "The ZIP code is not one the business serves.");
  }
  if (zip === null && zips.length > 0) {
    return result("unverified", "No ZIP code was given to check against the ZIP codes served.");
  }
  // Only places are listed and none matched. A bare ZIP code cannot be told apart.
  if (words(location.replaceAll(/\d+/g, " ")).length === 0) {
    return result("unverified", "Only a ZIP code was given; the business lists places it serves.");
  }
  return result("outside", "The place is not one the business serves.");
}
