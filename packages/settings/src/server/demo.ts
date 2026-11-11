import type { Database } from "@repo/db";
import { DEMO } from "@repo/db/seed";

import type { AppSettings } from "../registry";
import { sameHoursOn } from "../fields";
import type { ScopeTarget } from "../target";
import { applySegmentPreset } from "./presets";
import { applySettingChanges } from "./store";

/*
 * Demo settings for the demo agency of `@repo/db/seed` (`pnpm db:seed` runs both). They
 * give every screen something real to show: an agency-wide house style, segment starting
 * values, and two businesses that differ where businesses do.
 */

const ACTOR = { type: "system", label: "seed" } as const;

const AGENCY: Partial<AppSettings> = {
  "persona.role_title": "customer care assistant",
  "voice.banned_phrases": ["unfortunately", "per our policy"],
  "alerts.agency_recipients": [
    {
      name: DEMO.users.agencyAdmin.fullName,
      email: DEMO.users.agencyAdmin.email,
      phone: "",
      channels: ["email"],
      events: ["emergency", "send_failed"],
      active: true,
    },
  ],
};

const SUMMIT_ROOFING: Partial<AppSettings> = {
  "persona.bot_name": "Riley",
  "hours.weekly": {
    ...sameHoursOn(["monday", "tuesday", "wednesday", "thursday", "friday"], "07:30", "17:00"),
    saturday: [{ open: "08:00", close: "12:00" }],
  },
  "qualification.service_area.zip_codes": [
    "80214",
    "80215",
    "80226",
    "80227",
    "80228",
    "80232",
    "80401",
  ],
  "qualification.service_area.states": ["CO"],
  "pricing.estimate_policy": "free",
  "routing.contact_later_timeframe": "by the end of the next business day",
  "alerts.recipients": [
    {
      name: DEMO.users.clientOwner.fullName,
      email: DEMO.users.clientOwner.email,
      phone: "+13035550101",
      channels: ["email", "sms"],
      events: [],
      active: true,
    },
  ],
  "emergency.escalation_chain": [
    {
      name: DEMO.users.clientOwner.fullName,
      phone: "+13035550101",
      email: DEMO.users.clientOwner.email,
      alert_by: ["sms"],
    },
  ],
};

const EVERGREEN_HVAC: Partial<AppSettings> = {
  "persona.bot_name": "Jamie",
  "voice.tone": "empathetic",
  // The option from the spec that tells every lead "we'll contact you".
  "routing.mode": "always_contact_later",
  "emergency.service_level": "around_the_clock",
  "emergency.customer_instruction": "both",
  "emergency.phone": "+16125550199",
  "qualification.service_area.radius_miles": 25,
  "qualification.service_area.center_zip": "55408",
  "hours.weekly": sameHoursOn(
    ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
    "07:00",
    "18:00",
  ),
};

function changes(values: Partial<AppSettings>) {
  return Object.entries(values).map(([key, value]) => ({ key, value }));
}

/**
 * Writes the demo settings through the store. Run it after `seedDemoData`, which recreates
 * the demo agency (and with it removes every earlier setting), so running both again starts
 * clean. Returns the number of overrides written.
 */
export async function seedDemoSettings(db: Database): Promise<{ readonly written: number }> {
  const { agencyId } = DEMO;
  return db.forAgency(agencyId).run(async (ctx) => {
    const results = [
      await applySettingChanges(ctx, {
        target: { scope: "global", agencyId },
        changes: changes(AGENCY),
        actor: ACTOR,
        note: "Demo data",
      }),
      await applySegmentPreset(ctx, {
        segmentId: DEMO.segments.roofing,
        slug: "roofing",
        actor: ACTOR,
      }),
      await applySegmentPreset(ctx, { segmentId: DEMO.segments.hvac, slug: "hvac", actor: ACTOR }),
    ];
    const businesses: [ScopeTarget, Partial<AppSettings>][] = [
      [{ scope: "business", agencyId, businessId: DEMO.businesses.roofing }, SUMMIT_ROOFING],
      [{ scope: "business", agencyId, businessId: DEMO.businesses.hvac }, EVERGREEN_HVAC],
    ];
    for (const [target, values] of businesses) {
      results.push(
        await applySettingChanges(ctx, {
          target,
          changes: changes(values),
          actor: ACTOR,
          note: "Demo data",
        }),
      );
    }
    return {
      written: results
        .flatMap((result) => result.applied)
        .filter((change) => change.operation === "set").length,
    };
  });
}
