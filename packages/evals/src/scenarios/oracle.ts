import { leadFieldCatalogue } from "@repo/ai";
import type { LeadFieldValue, RoutingOutcome } from "@repo/core";
import { SYSTEM_LEAD_FIELDS } from "@repo/core";
import { assessLead } from "@repo/leads";
import type { AppResolvedSettings } from "@repo/settings";

import type { CustomerTruth, PersonaInstance, Revealed } from "./types";

/**
 * The routing oracle: what the business's own rules (`assessLead`, the function production
 * routes with) decide for a customer whose true facts are known. The expected routing of a
 * scenario is computed, not written by hand, so it cannot drift from the scoring rules or
 * from a settings profile.
 *
 * A conversation does not record exactly the customer's facts: the bot may learn every fact
 * the persona is willing to give or only the ones the business requires, and it may or may
 * not notice a signal such as "comparing quotes". Each of those is a legitimate record of
 * the same customer, so the oracle evaluates all of them and returns every outcome the rules
 * give. For most scenarios that is a single outcome.
 */

type Fields = Record<string, LeadFieldValue>;

function field(key: string, value: LeadFieldValue["value"], now: string): LeadFieldValue {
  return { key, value, confidence: 1, evidence: null, updatedAt: now };
}

/** The lead fields a bot that learned `keys` from this customer would hold. */
export function fieldsFromTruth(
  truth: CustomerTruth,
  keys: readonly Revealed[],
  now: string,
): Fields {
  const fields: Fields = {};
  const add = (key: Revealed, value: LeadFieldValue["value"] | null | undefined) => {
    if (keys.includes(key) && value !== null && value !== undefined) {
      fields[key] = field(key, value, now);
    }
  };
  add("service_type", truth.job?.service);
  add("job_scope", truth.job === null ? null : truth.job.details.join("; "));
  add("service_area", truth.zip);
  add("timeline", truth.timeline);
  add("decision_maker", truth.role);
  add("property_type", truth.job?.propertyType);
  add("contact_name", truth.name);
  add("contact_phone", truth.phone);
  return fields;
}

function outcomeOf(
  settings: AppResolvedSettings,
  fields: Fields,
  now: string,
  photoCount = 0,
): RoutingOutcome | null {
  return (
    assessLead({ settings, facts: { fields, status: "new", photoCount }, now }).decision?.outcome ??
    null
  );
}

/** Every routing outcome the rules give for this customer, across the records a bot may keep. */
export function expectedRouting(
  settings: AppResolvedSettings,
  instance: PersonaInstance,
  spam: boolean,
  now: string,
): (RoutingOutcome | null)[] {
  if (instance.expect.routing === "any") return [];
  const outcomes = new Set<RoutingOutcome | null>();
  if (spam) {
    for (const category of ["spam", "solicitation"]) {
      outcomes.add(
        outcomeOf(
          settings,
          { [SYSTEM_LEAD_FIELDS.notAFit]: field(SYSTEM_LEAD_FIELDS.notAFit, category, now) },
          now,
        ),
      );
    }
    return [...outcomes];
  }

  const required = new Set(
    leadFieldCatalogue(settings.values)
      .filter((spec) => spec.group === "criterion" && spec.required)
      .map((spec) => spec.key),
  );
  const full = fieldsFromTruth(instance.truth, instance.revealed, now);
  const minimal = fieldsFromTruth(
    instance.truth,
    instance.revealed.filter(
      (key) => required.has(key) || (instance.volunteered ?? []).includes(key),
    ),
    now,
  );
  outcomes.add(outcomeOf(settings, full, now));
  outcomes.add(outcomeOf(settings, minimal, now));
  if (instance.truth.photo !== null) outcomes.add(outcomeOf(settings, full, now, 1));
  for (const signal of instance.possibleSignals) {
    outcomes.add(outcomeOf(settings, { ...full, [signal]: field(signal, true, now) }, now));
  }
  if (instance.expect.routing === "oracle_or_none") outcomes.add(null);
  return [...outcomes];
}
