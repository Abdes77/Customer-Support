import {
  type AgencyId,
  type BusinessId,
  type BusinessProfile,
  CHANNEL_CAPABILITIES,
  type ChannelId,
  type ConversationId,
  type ConversationTurn,
  type CustomerProfile,
  type EngineTurnInput,
  type KnowledgeFact,
  type LeadSnapshot,
  type MessageId,
  type PlaybookSnapshot,
  type SegmentId,
  type TraceId,
  type TurnTrigger,
} from "@repo/core";
import { type AppResolvedSettings, type AppSettings, settingsWith } from "@repo/settings";

/**
 * Businesses and turn inputs for tests: four made-up companies, one per segment the product
 * starts with, each with a handful of facts. Other packages' tests may use them too.
 */

export type TestSegment = "roofing" | "hvac" | "electrical" | "remodeling";

export interface TestBusiness {
  readonly business: BusinessProfile;
  readonly facts: readonly KnowledgeFact[];
}

const AGENCY = "0a000000-0000-4000-8000-000000000001" as AgencyId;
const UPDATED = "2026-10-01T12:00:00.000Z";

function fact(
  id: string,
  category: KnowledgeFact["category"],
  title: string,
  content: string,
): KnowledgeFact {
  return { id, category, title, content, source: "manual", updatedAt: UPDATED };
}

const BUSINESSES: Readonly<Record<TestSegment, TestBusiness>> = {
  roofing: {
    business: {
      id: "0b000000-0000-4000-8000-000000000001" as BusinessId,
      agencyId: AGENCY,
      name: "Summit Roofing Co.",
      segment: {
        id: "0c000000-0000-4000-8000-000000000001" as SegmentId,
        slug: "roofing",
        name: "Roofing",
      },
      timezone: "America/Denver",
      contact: {
        phone: "+13035550100",
        email: "office@summitroofing.example.com",
        websiteUrl: "https://summitroofing.example.com",
        city: "Lakewood",
        state: "CO",
        postalCode: "80215",
      },
    },
    facts: [
      fact(
        "roof-services",
        "services",
        "Services",
        "Roof repair, full replacement (asphalt shingle and metal), storm damage inspections and insurance claim support.",
      ),
      fact(
        "roof-area",
        "service_area",
        "Service area",
        "Denver metro west side: Lakewood, Golden, Arvada, Wheat Ridge and Littleton.",
      ),
      fact("roof-hours", "hours", "Office hours", "Monday to Friday 8am to 5pm."),
      fact(
        "roof-license",
        "licenses",
        "License and insurance",
        "Licensed roofing contractor in Colorado, fully insured, GAF Certified.",
      ),
      fact(
        "roof-warranty",
        "warranties",
        "Warranty",
        "10-year workmanship warranty on full replacements; manufacturer warranty on materials.",
      ),
      fact(
        "roof-financing",
        "financing",
        "Financing",
        "Financing is available on replacements through a lending partner, subject to credit approval.",
      ),
      fact(
        "roof-pricing",
        "pricing",
        "Inspection",
        "A roof inspection costs $149 and is credited toward any repair over $500.",
      ),
    ],
  },
  hvac: {
    business: {
      id: "0b000000-0000-4000-8000-000000000002" as BusinessId,
      agencyId: AGENCY,
      name: "Evergreen Heating & Air",
      segment: {
        id: "0c000000-0000-4000-8000-000000000002" as SegmentId,
        slug: "hvac",
        name: "HVAC",
      },
      timezone: "America/Chicago",
      contact: {
        phone: "+16125550140",
        email: "hello@evergreenhvac.example.com",
        websiteUrl: "https://evergreenhvac.example.com",
        city: "Minneapolis",
        state: "MN",
        postalCode: "55408",
      },
    },
    facts: [
      fact(
        "hvac-services",
        "services",
        "Services",
        "Furnace and air conditioner repair, heat pump and furnace replacement, seasonal tune-ups, duct cleaning.",
      ),
      fact(
        "hvac-area",
        "service_area",
        "Service area",
        "Minneapolis, St. Paul and the suburbs inside the I-494/I-694 loop.",
      ),
      fact(
        "hvac-hours",
        "hours",
        "Office hours",
        "Monday to Friday 8am to 5pm. Emergency technicians are on call around the clock.",
      ),
      fact(
        "hvac-license",
        "licenses",
        "License",
        "Licensed mechanical contractor in Minnesota, bonded and insured.",
      ),
      fact(
        "hvac-warranty",
        "warranties",
        "Warranty",
        "One year on repairs; 10 years on parts for new systems registered with the manufacturer.",
      ),
      fact(
        "hvac-brands",
        "brands",
        "Brands",
        "Installs Trane and Mitsubishi; services all major brands.",
      ),
      fact(
        "hvac-pricing",
        "pricing",
        "Diagnostic fee",
        "The diagnostic visit is $89, waived when the repair is done the same day.",
      ),
    ],
  },
  electrical: {
    business: {
      id: "0b000000-0000-4000-8000-000000000003" as BusinessId,
      agencyId: AGENCY,
      name: "Brightwire Electric",
      segment: {
        id: "0c000000-0000-4000-8000-000000000003" as SegmentId,
        slug: "electrical",
        name: "Electrical",
      },
      timezone: "America/New_York",
      contact: {
        phone: "+14045550170",
        email: "office@brightwire.example.com",
        websiteUrl: "https://brightwire.example.com",
        city: "Decatur",
        state: "GA",
        postalCode: "30030",
      },
    },
    facts: [
      fact(
        "elec-services",
        "services",
        "Services",
        "Troubleshooting, panel upgrades, EV charger installation, recessed lighting, whole-home surge protection.",
      ),
      fact(
        "elec-area",
        "service_area",
        "Service area",
        "Decatur, Atlanta east side, Tucker and Stone Mountain.",
      ),
      fact("elec-hours", "hours", "Office hours", "Monday to Friday 8am to 5pm."),
      fact(
        "elec-license",
        "licenses",
        "License",
        "Georgia licensed electrical contractor (Class II), insured.",
      ),
      fact("elec-warranty", "warranties", "Warranty", "Two-year warranty on workmanship."),
    ],
  },
  remodeling: {
    business: {
      id: "0b000000-0000-4000-8000-000000000004" as BusinessId,
      agencyId: AGENCY,
      name: "Harbor Kitchen & Bath",
      segment: {
        id: "0c000000-0000-4000-8000-000000000004" as SegmentId,
        slug: "remodeling",
        name: "Kitchen and bath remodeling",
      },
      timezone: "America/Los_Angeles",
      contact: {
        phone: "+12065550190",
        email: "studio@harborkb.example.com",
        websiteUrl: "https://harborkb.example.com",
        city: "Seattle",
        state: "WA",
        postalCode: "98107",
      },
    },
    facts: [
      fact(
        "remodel-services",
        "services",
        "Services",
        "Full kitchen remodels, bathroom remodels, tub-to-shower conversions, cabinet and countertop replacement.",
      ),
      fact(
        "remodel-area",
        "service_area",
        "Service area",
        "Seattle north of the ship canal, Shoreline and Edmonds.",
      ),
      fact("remodel-hours", "hours", "Studio hours", "Monday to Friday 8am to 5pm."),
      fact(
        "remodel-license",
        "licenses",
        "License",
        "Washington general contractor, bonded and insured.",
      ),
      fact("remodel-warranty", "warranties", "Warranty", "Three-year warranty on workmanship."),
      fact(
        "remodel-process",
        "faq",
        "How a project starts",
        "Every project starts with a free in-home design consultation of about an hour.",
      ),
    ],
  },
};

export function testBusiness(segment: TestSegment = "roofing"): TestBusiness {
  return BUSINESSES[segment];
}

export interface TestInputOptions {
  readonly business?: BusinessProfile;
  /** Overrides on top of the registry defaults, or a ready snapshot. */
  readonly settings?: Partial<AppSettings> | AppResolvedSettings;
  /** Default: Tuesday, November 10, 2026, 17:00 UTC (office hours in every US time zone). */
  readonly now?: string;
  readonly channel?: ChannelId;
  readonly history?: readonly ConversationTurn[];
  /** Customer messages to answer: texts or ready turns. */
  readonly pending?: readonly (string | ConversationTurn)[];
  readonly lead?: LeadSnapshot;
  readonly playbook?: PlaybookSnapshot | null;
  readonly trigger?: TurnTrigger;
  readonly customer?: CustomerProfile;
  readonly mode?: "live" | "dry_run";
}

let messageCounter = 0;

/** A stored message as the engine sees it. */
export function testTurn(
  author: ConversationTurn["author"],
  text: string | null,
  sentAt: string,
  extra: Partial<ConversationTurn> = {},
): ConversationTurn {
  messageCounter += 1;
  return {
    messageId: `0d000000-0000-4000-8000-${String(messageCounter).padStart(12, "0")}` as MessageId,
    author,
    sentAt,
    text,
    attachments: [],
    subject: null,
    ...extra,
  };
}

function isSnapshot(value: TestInputOptions["settings"]): value is AppResolvedSettings {
  return value !== undefined && "values" in value && "version" in value && "sources" in value;
}

/** An `EngineTurnInput` with sensible defaults for everything a test does not care about. */
export function testInput(options: TestInputOptions = {}): EngineTurnInput {
  const business = options.business ?? BUSINESSES.roofing.business;
  const now = options.now ?? "2026-11-10T17:00:00.000Z";
  const channel = options.channel ?? "test";
  const settings = isSnapshot(options.settings)
    ? options.settings
    : settingsWith(options.settings ?? {});
  return {
    trace: {
      traceId: "0e000000-0000-4000-8000-000000000001" as TraceId,
      agencyId: business.agencyId,
      businessId: business.id,
      conversationId: "0f000000-0000-4000-8000-000000000001" as ConversationId,
    },
    mode: options.mode ?? "dry_run",
    trigger: options.trigger ?? "inbound_message",
    now,
    business,
    ...(options.customer === undefined ? {} : { customer: options.customer }),
    channel: {
      id: channel,
      capabilities: CHANNEL_CAPABILITIES[channel],
      window: { open: true, closesAt: null },
    },
    settings,
    playbook: options.playbook ?? null,
    lead: options.lead ?? { id: null, status: "new", fields: {}, routing: null },
    history: options.history ?? [],
    pending: (options.pending ?? ["My roof is leaking."]).map((entry) =>
      typeof entry === "string" ? testTurn("customer", entry, now) : entry,
    ),
  };
}
