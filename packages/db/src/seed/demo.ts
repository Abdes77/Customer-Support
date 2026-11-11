import {
  type AgencyId,
  type BusinessId,
  type ChannelConnectionId,
  ConfigError,
  type ContactId,
  type ConversationId,
  type LeadId,
  type LeadStatus,
  type PlaybookDocument,
  type Role,
  type RoutingOutcome,
  type SegmentId,
  type UserId,
} from "@repo/core";

import type { AgencyContext } from "../context";
import type { Database } from "../database";
import { recordSystemAudit } from "../repositories/audit";
import {
  agencyMemberships,
  alerts,
  bookings,
  businesses,
  businessMemberships,
  channelConnections,
  contactIdentities,
  contacts,
  conversations,
  escalations,
  internalNotes,
  knowledgeItems,
  leadFields,
  leadReports,
  leads,
  messages,
  playbookVersions,
  routingDecisions,
  segments,
  takeoverLocks,
} from "../schema/tables";

/**
 * Demo data: one agency, two businesses in different segments, a user for each of the four
 * roles, and a handful of conversations and leads at different stages. It is what
 * `pnpm db:seed` loads and what later chunks' screens and end-to-end tests can rely on.
 *
 * Ids are fixed, so the seed can be run again and again: it deletes the demo agency (and by
 * cascade everything below it) and writes it afresh, all through the same scoped API the
 * application uses. Nothing here is a setting: C2 owns setting keys and seeds its own.
 */

export const DEMO = {
  agencyId: "a0000000-0000-4000-8000-000000000001" as AgencyId,
  agencySlug: "brightline",
  segments: {
    roofing: "a0000000-0000-4000-8000-000000000011" as SegmentId,
    hvac: "a0000000-0000-4000-8000-000000000012" as SegmentId,
  },
  businesses: {
    roofing: "a0000000-0000-4000-8000-000000000021" as BusinessId,
    hvac: "a0000000-0000-4000-8000-000000000022" as BusinessId,
  },
  users: {
    agencyAdmin: {
      id: "a0000000-0000-4000-8000-000000000101" as UserId,
      email: "admin@brightline.test",
      fullName: "Avery Admin",
      role: "agency_admin",
    },
    agencyMember: {
      id: "a0000000-0000-4000-8000-000000000102" as UserId,
      email: "member@brightline.test",
      fullName: "Morgan Member",
      role: "agency_member",
    },
    clientOwner: {
      id: "a0000000-0000-4000-8000-000000000103" as UserId,
      email: "owner@summitroofing.test",
      fullName: "Riley Owner",
      role: "client_owner",
    },
    clientStaff: {
      id: "a0000000-0000-4000-8000-000000000104" as UserId,
      email: "staff@summitroofing.test",
      fullName: "Sam Staff",
      role: "client_staff",
    },
  },
} as const satisfies {
  agencyId: AgencyId;
  agencySlug: string;
  segments: Record<string, SegmentId>;
  businesses: Record<string, BusinessId>;
  users: Record<string, { id: UserId; email: string; fullName: string; role: Role }>;
};

/** Password of the demo users on a local database, unless the seed is given another one. */
export const DEMO_PASSWORD = "brightline-demo";

export interface SeedOptions {
  /** Password for the demo users (local sign-in only). */
  readonly password?: string;
  /** The moment the demo data is "now"; conversations are placed in the days before it. */
  readonly now?: Date;
  /**
   * Creates (or finds) an auth user and returns its id. Needed on a Supabase database, where
   * users belong to Supabase Auth; on a local database the built-in store is used.
   */
  readonly createAuthUser?: (input: {
    readonly email: string;
    readonly password: string;
    readonly fullName: string;
  }) => Promise<UserId>;
}

export interface SeedSummary {
  readonly agencyId: AgencyId;
  readonly businesses: readonly {
    readonly id: BusinessId;
    readonly name: string;
    readonly segment: string;
  }[];
  readonly users: readonly { readonly email: string; readonly role: Role }[];
  /** Rows written, by table. */
  readonly counts: Readonly<Record<string, number>>;
}

const ROOFING_PLAYBOOK: PlaybookDocument = {
  commonJobs: [
    {
      name: "Leak repair",
      scope: "Find and fix an active leak; replace damaged shingles and flashing.",
    },
    {
      name: "Roof replacement",
      scope: "Tear off and replace the roof; typical for roofs over 20 years old.",
    },
    {
      name: "Storm damage inspection",
      scope: "Inspect after hail or wind, often with an insurance claim.",
    },
  ],
  customerLanguage: [
    { phrase: "water stain on the ceiling", meaning: "A leak that has been active for a while." },
    { phrase: "shingles in the yard", meaning: "Wind damage; the deck may be exposed." },
  ],
  urgencySignals: [
    { signal: "Water is coming in right now", level: "emergency" },
    { signal: "A storm is forecast and the roof is open", level: "urgent" },
    { signal: "Planning a replacement this year", level: "routine" },
  ],
  qualificationQuestions: [
    { question: "What is going on with the roof?", why: "Separates repair from replacement." },
    { question: "What is the address or ZIP code?", why: "Service area." },
    { question: "Do you own the home?", why: "Decision-maker." },
    { question: "Is an insurance claim involved?", why: "Changes the process and the timeline." },
  ],
  objections: [
    {
      objection: "I am getting other quotes.",
      response: "That makes sense. A free inspection gives you a written scope to compare.",
    },
  ],
  seasonalPatterns: ["Hail season brings a rush of inspections in spring and early summer."],
  priceNorms: [
    { job: "Leak repair", range: "$400 to $1,500", notes: "Depends on access and decking damage." },
    {
      job: "Asphalt shingle replacement",
      range: "$9,000 to $22,000",
      notes: "Typical single-family home.",
    },
  ],
  permitsAndRegulations: ["Most cities require a permit for a full replacement."],
  vocabulary: [
    { term: "flashing", definition: "Metal that seals joints around chimneys, vents and walls." },
    { term: "decking", definition: "The wood sheathing under the shingles." },
  ],
  sources: [
    { title: "Demo playbook (seed data)", url: "https://example.com/demo-playbook-roofing" },
  ],
};

const HVAC_PLAYBOOK: PlaybookDocument = {
  commonJobs: [
    {
      name: "No-heat repair",
      scope: "Diagnose and repair a furnace or heat pump that is not heating.",
    },
    { name: "AC tune-up", scope: "Seasonal maintenance of the cooling system." },
    { name: "System replacement", scope: "Replace furnace, air conditioner or both." },
  ],
  customerLanguage: [
    {
      phrase: "blowing cold air",
      meaning: "Furnace runs but does not heat: igniter, flame sensor or gas supply.",
    },
    { phrase: "short cycling", meaning: "The system turns on and off every few minutes." },
  ],
  urgencySignals: [
    { signal: "Smell of gas", level: "emergency" },
    { signal: "No heat and freezing temperatures", level: "emergency" },
    { signal: "No cooling during a heat wave", level: "urgent" },
    { signal: "Wants a quote for a new system", level: "routine" },
  ],
  qualificationQuestions: [
    {
      question: "What is the system doing or not doing?",
      why: "Repair versus replacement, and urgency.",
    },
    { question: "How old is the system?", why: "Over 12 to 15 years suggests replacement." },
    { question: "What is the ZIP code?", why: "Service area." },
    { question: "Do you own the home?", why: "Decision-maker." },
  ],
  objections: [
    {
      objection: "Your diagnostic fee is too high.",
      response: "The fee is credited toward the repair if you go ahead.",
    },
  ],
  seasonalPatterns: ["First cold week of autumn: no-heat calls spike."],
  priceNorms: [
    { job: "Diagnostic visit", range: "$89 to $149", notes: null },
    {
      job: "Furnace replacement",
      range: "$4,500 to $9,000",
      notes: "Depends on efficiency and ductwork.",
    },
  ],
  permitsAndRegulations: ["Replacements usually need a mechanical permit."],
  vocabulary: [
    { term: "SEER2", definition: "Cooling efficiency rating; higher is more efficient." },
    { term: "heat exchanger", definition: "Part of the furnace that transfers heat to the air." },
  ],
  sources: [{ title: "Demo playbook (seed data)", url: "https://example.com/demo-playbook-hvac" }],
};

interface SeedMessage {
  readonly from: "customer" | "bot" | "human_agent";
  readonly text: string;
}

interface SeedConversation {
  readonly id: ConversationId;
  readonly contactId: ContactId;
  readonly leadId: LeadId;
  readonly contact: {
    readonly name: string;
    readonly phone: string;
    readonly email: string | null;
    readonly address: string | null;
  };
  /** Hours before "now" that the conversation started. */
  readonly startedHoursAgo: number;
  readonly messages: readonly SeedMessage[];
  readonly lead: {
    readonly status: LeadStatus;
    readonly score: number;
    readonly band: string;
    readonly outcome: RoutingOutcome;
    readonly fields: Readonly<
      Record<string, { value: unknown; confidence: number; evidence: string }>
    >;
    readonly summary: string;
    readonly reasons: readonly string[];
    readonly disqualifyReason?: string;
  };
}

const id = (suffix: string) => `a0000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

const ROOFING_CONVERSATIONS: readonly SeedConversation[] = [
  {
    id: id("1001") as ConversationId,
    contactId: id("2001") as ContactId,
    leadId: id("3001") as LeadId,
    contact: {
      name: "Dana Whitfield",
      phone: "+13035550142",
      email: "dana.whitfield@example.com",
      address: "418 Juniper Ct, Lakewood, CO 80226",
    },
    startedHoursAgo: 50,
    messages: [
      {
        from: "customer",
        text: "Hi, we had hail last week and I think the roof took a beating. Shingle bits in the gutters.",
      },
      {
        from: "bot",
        text: "Sorry to hear that, Dana. Granules in the gutters after hail is worth a look. Is any water getting inside, or is it just the outside so far?",
      },
      { from: "customer", text: "No leaks yet. The roof is about 18 years old." },
      {
        from: "bot",
        text: "Good that it's dry inside. At 18 years with hail damage, an inspection will tell you whether it's a repair or a replacement. Are you the homeowner, and have you opened an insurance claim?",
      },
      {
        from: "customer",
        text: "Yes I own it. I filed a claim yesterday, adjuster comes next Friday. We're in Lakewood 80226.",
      },
      {
        from: "bot",
        text: "Perfect, that's in our area. We can inspect before the adjuster comes so you have our photos and scope in hand. Would Tuesday at 10am or Wednesday at 2pm work?",
      },
      { from: "customer", text: "Tuesday 10 works." },
      {
        from: "bot",
        text: "You're booked for Tuesday at 10am at 418 Juniper Ct. You'll get a reminder the day before. Anything else I can help with?",
      },
    ],
    lead: {
      status: "meeting_booked",
      score: 88,
      band: "hot",
      outcome: "book_meeting",
      fields: {
        service_type: {
          value: "storm_damage_inspection",
          confidence: 0.95,
          evidence: "hail last week, shingle bits in the gutters",
        },
        timeline: { value: "this_week", confidence: 0.9, evidence: "adjuster comes next Friday" },
        decision_maker: { value: true, confidence: 1, evidence: "Yes I own it" },
        insurance_claim: { value: true, confidence: 1, evidence: "I filed a claim yesterday" },
        service_area_zip: { value: "80226", confidence: 1, evidence: "We're in Lakewood 80226" },
      },
      summary:
        "Homeowner in Lakewood with hail damage on an 18-year-old roof and an open insurance claim. Inspection booked before the adjuster's visit.",
      reasons: [
        "Homeowner and decision-maker",
        "Inside the service area",
        "Insurance claim open",
        "Wants an inspection this week",
      ],
    },
  },
  {
    id: id("1002") as ConversationId,
    contactId: id("2002") as ContactId,
    leadId: id("3002") as LeadId,
    contact: { name: "Marcus Reyes", phone: "+13035550177", email: null, address: null },
    startedHoursAgo: 5,
    messages: [
      { from: "customer", text: "Do you guys fix leaks? There's a stain on my bedroom ceiling." },
      {
        from: "bot",
        text: "We do. A ceiling stain usually means water has been getting in for a little while, so it's good you're on it. Is it dripping now, or only when it rains?",
      },
      { from: "customer", text: "Only when it rains hard." },
      { from: "bot", text: "Got it. What's your ZIP code, and do you own the home?" },
    ],
    lead: {
      status: "qualifying",
      score: 45,
      band: "warm",
      outcome: "contact_later",
      fields: {
        service_type: {
          value: "leak_repair",
          confidence: 0.9,
          evidence: "stain on my bedroom ceiling",
        },
        timeline: { value: "soon", confidence: 0.5, evidence: "Only when it rains hard" },
      },
      summary:
        "Leak over a bedroom that shows in heavy rain. Location and ownership not known yet.",
      reasons: ["Clear repair need", "Service area and ownership still unknown"],
    },
  },
  {
    id: id("1003") as ConversationId,
    contactId: id("2003") as ContactId,
    leadId: id("3003") as LeadId,
    contact: {
      name: "Priya Nair",
      phone: "+17195550119",
      email: "priya.nair@example.com",
      address: null,
    },
    startedHoursAgo: 96,
    messages: [
      { from: "customer", text: "Looking for a quote to replace my roof. I'm in Pueblo, 81003." },
      {
        from: "bot",
        text: "Thanks for reaching out, Priya. I'm sorry, Pueblo is outside the area our crews cover, so we wouldn't be able to take this one on. A local roofer will serve you better and faster.",
      },
      { from: "customer", text: "Ok thanks anyway." },
    ],
    lead: {
      status: "disqualified",
      score: 12,
      band: "cold",
      outcome: "disqualify",
      fields: {
        service_type: { value: "roof_replacement", confidence: 0.95, evidence: "replace my roof" },
        service_area_zip: { value: "81003", confidence: 1, evidence: "I'm in Pueblo, 81003" },
      },
      summary: "Wants a roof replacement in Pueblo (81003), outside the service area.",
      reasons: ["Outside the service area"],
      disqualifyReason: "out_of_area",
    },
  },
];

const HVAC_CONVERSATIONS: readonly SeedConversation[] = [
  {
    id: id("1101") as ConversationId,
    contactId: id("2101") as ContactId,
    leadId: id("3101") as LeadId,
    contact: {
      name: "Helen Kowalski",
      phone: "+16125550163",
      email: null,
      address: "2207 Ashbury Ave, Minneapolis, MN 55406",
    },
    startedHoursAgo: 20,
    messages: [
      {
        from: "customer",
        text: "Our furnace quit and it's 8 degrees out. House is at 54 and dropping. We have a baby.",
      },
      {
        from: "bot",
        text: "That's an emergency and we'll treat it as one. I'm alerting our on-call technician right now. While you wait: keep everyone in one room with the door closed, and please don't use the oven or a grill for heat. What's the address?",
      },
      { from: "customer", text: "2207 Ashbury Ave, Minneapolis" },
      {
        from: "bot",
        text: "Thank you. Our on-call tech has your address and will call you within minutes. If you smell gas at any point, leave the house and call 911.",
      },
      {
        from: "human_agent",
        text: "Helen, this is Tom from Evergreen. I'm 25 minutes away and heading to you now.",
      },
    ],
    lead: {
      status: "handed_off",
      score: 95,
      band: "hot",
      outcome: "contact_later",
      fields: {
        service_type: { value: "no_heat_repair", confidence: 1, evidence: "Our furnace quit" },
        timeline: {
          value: "emergency",
          confidence: 1,
          evidence: "it's 8 degrees out. House is at 54 and dropping",
        },
        service_area_zip: {
          value: "55406",
          confidence: 0.8,
          evidence: "2207 Ashbury Ave, Minneapolis",
        },
      },
      summary:
        "No heat in freezing weather with an infant in the home. Escalated to the on-call technician, who took over the conversation.",
      reasons: ["Emergency: no heat in freezing weather", "Technician dispatched"],
    },
  },
  {
    id: id("1102") as ConversationId,
    contactId: id("2102") as ContactId,
    leadId: id("3102") as LeadId,
    contact: {
      name: "Jordan Blake",
      phone: "+16125550188",
      email: "jordan.blake@example.com",
      address: null,
    },
    startedHoursAgo: 30,
    messages: [
      { from: "customer", text: "How much for a new AC unit?" },
      {
        from: "bot",
        text: "Happy to help with that. The price depends mostly on the size of the home and the efficiency you want, so a quick look gives you a real number instead of a guess. Roughly how big is the house, and how old is the current system?",
      },
      {
        from: "customer",
        text: "2,100 sq ft. System is maybe 16 years old. Just shopping around for now.",
      },
      {
        from: "bot",
        text: "That's useful, thanks. At 16 years a replacement is a sensible thing to price out. I'll have one of our comfort advisors get in touch with options and a written estimate. What's the best email for that?",
      },
      { from: "customer", text: "jordan.blake@example.com" },
    ],
    lead: {
      status: "qualified",
      score: 62,
      band: "warm",
      outcome: "contact_later",
      fields: {
        service_type: {
          value: "system_replacement",
          confidence: 0.9,
          evidence: "How much for a new AC unit?",
        },
        timeline: {
          value: "researching",
          confidence: 0.85,
          evidence: "Just shopping around for now",
        },
        job_scope: {
          value: "2,100 sq ft home, 16-year-old system",
          confidence: 0.9,
          evidence: "2,100 sq ft. System is maybe 16 years old.",
        },
      },
      summary:
        "Pricing a replacement for a 16-year-old AC in a 2,100 sq ft home. Early in the decision; wants a written estimate by email.",
      reasons: ["Aging system, replacement is likely", "Still comparing options"],
    },
  },
];

interface SeedBusiness {
  readonly id: BusinessId;
  readonly connectionId: ChannelConnectionId;
  readonly segment: keyof typeof DEMO.segments;
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
  readonly clientPortalEnabled: boolean;
  readonly profile: {
    readonly websiteUrl: string;
    readonly phone: string;
    readonly email: string;
    readonly addressLine1: string;
    readonly city: string;
    readonly state: string;
    readonly postalCode: string;
  };
  readonly knowledge: readonly {
    readonly category: (typeof knowledgeItems.$inferInsert)["category"];
    readonly title: string;
    readonly content: string;
    readonly isCore: boolean;
  }[];
  readonly conversations: readonly SeedConversation[];
}

const SEED_BUSINESSES: readonly SeedBusiness[] = [
  {
    id: DEMO.businesses.roofing,
    connectionId: id("4001") as ChannelConnectionId,
    segment: "roofing",
    name: "Summit Roofing Co.",
    slug: "summit-roofing",
    timezone: "America/Denver",
    clientPortalEnabled: true,
    profile: {
      websiteUrl: "https://summitroofing.example.com",
      phone: "+13035550100",
      email: "office@summitroofing.example.com",
      addressLine1: "1200 W Colfax Ave",
      city: "Lakewood",
      state: "CO",
      postalCode: "80215",
    },
    knowledge: [
      {
        category: "services",
        title: "Services",
        content:
          "Roof repair, full replacement (asphalt shingle, metal), storm damage inspections and insurance claim support.",
        isCore: true,
      },
      {
        category: "service_area",
        title: "Service area",
        content:
          "Denver metro west side: Lakewood, Golden, Arvada, Wheat Ridge and Littleton. ZIP codes 80002 to 80033, 80120 to 80128, 80214 to 80235 and 80401 to 80403.",
        isCore: true,
      },
      {
        category: "hours",
        title: "Office hours",
        content: "Monday to Friday 7am to 5pm, Saturday 8am to noon. Closed Sunday.",
        isCore: true,
      },
      {
        category: "licenses",
        title: "License and insurance",
        content: "Licensed roofing contractor in Colorado, fully insured, GAF Certified.",
        isCore: false,
      },
      {
        category: "warranties",
        title: "Warranty",
        content:
          "10-year workmanship warranty on full replacements; manufacturer warranty on materials.",
        isCore: false,
      },
      {
        category: "financing",
        title: "Financing",
        content:
          "Financing available on replacements through a lending partner, subject to credit approval.",
        isCore: false,
      },
    ],
    conversations: ROOFING_CONVERSATIONS,
  },
  {
    id: DEMO.businesses.hvac,
    connectionId: id("4002") as ChannelConnectionId,
    segment: "hvac",
    name: "Evergreen Heating & Air",
    slug: "evergreen-heating-air",
    timezone: "America/Chicago",
    clientPortalEnabled: false,
    profile: {
      websiteUrl: "https://evergreenhvac.example.com",
      phone: "+16125550100",
      email: "service@evergreenhvac.example.com",
      addressLine1: "3410 Lyndale Ave S",
      city: "Minneapolis",
      state: "MN",
      postalCode: "55408",
    },
    knowledge: [
      {
        category: "services",
        title: "Services",
        content:
          "Furnace and AC repair, seasonal tune-ups, full system replacement, heat pumps and indoor air quality.",
        isCore: true,
      },
      {
        category: "service_area",
        title: "Service area",
        content:
          "Minneapolis, St. Paul and first-ring suburbs. ZIP codes starting with 551, 553 and 554.",
        isCore: true,
      },
      {
        category: "hours",
        title: "Hours",
        content: "Monday to Friday 7am to 6pm. Emergency service 24 hours a day, every day.",
        isCore: true,
      },
      {
        category: "pricing",
        title: "Diagnostic fee",
        content: "Diagnostic visit $109, credited toward the repair when you go ahead.",
        isCore: false,
      },
      {
        category: "brands",
        title: "Brands",
        content: "We install Carrier and Trane and service every major brand.",
        isCore: false,
      },
    ],
    conversations: HVAC_CONVERSATIONS,
  },
];

type DemoUserKey = keyof typeof DEMO.users;
type DemoUserIds = Record<DemoUserKey, UserId>;

async function ensureUsers(db: Database, options: SeedOptions): Promise<DemoUserIds> {
  const password = options.password ?? DEMO_PASSWORD;
  const local = await db.localAuth.isAvailable();
  const ids = {} as DemoUserIds;
  for (const key of Object.keys(DEMO.users) as DemoUserKey[]) {
    const user = DEMO.users[key];
    if (local) {
      // An existing user with this email keeps its id.
      const existing = await db.localAuth.findUserByEmail(user.email);
      const saved = await db.localAuth.upsertUser({
        id: existing === null ? user.id : undefined,
        email: user.email,
        password,
        fullName: user.fullName,
      });
      ids[key] = saved.id;
    } else if (options.createAuthUser !== undefined) {
      ids[key] = await options.createAuthUser({
        email: user.email,
        password,
        fullName: user.fullName,
      });
    } else {
      throw new ConfigError(
        "This is a Supabase database: the demo users must be created through Supabase Auth. " +
          "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY and run the seed again.",
      );
    }
  }
  return ids;
}

async function seedBusiness(
  ctx: AgencyContext,
  business: SeedBusiness,
  userIds: DemoUserIds,
  now: Date,
  counts: Record<string, number>,
): Promise<void> {
  const { tx } = ctx;
  const tenant = { agencyId: ctx.tenant.agencyId, businessId: business.id };
  const bump = (table: string, by = 1) => {
    counts[table] = (counts[table] ?? 0) + by;
  };
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

  await tx.insert(businesses).values({
    id: business.id,
    agencyId: tenant.agencyId,
    segmentId: DEMO.segments[business.segment],
    name: business.name,
    slug: business.slug,
    status: "active",
    timezone: business.timezone,
    clientPortalEnabled: business.clientPortalEnabled,
    ...business.profile,
  });
  bump("businesses");

  await tx.insert(knowledgeItems).values(
    business.knowledge.map((item, position) => ({
      ...tenant,
      ...item,
      position,
      source: "manual",
      updatedBy: userIds.agencyAdmin,
    })),
  );
  bump("knowledge_items", business.knowledge.length);

  await tx.insert(channelConnections).values({
    id: business.connectionId,
    ...tenant,
    channel: "test",
    externalAccountId: `test-${business.slug}`,
    displayName: "Test chat",
    status: "active",
    connectedBy: userIds.agencyAdmin,
    connectedAt: hoursAgo(24 * 14),
  });
  bump("channel_connections");

  for (const conversation of business.conversations) {
    const startedAt = hoursAgo(conversation.startedHoursAgo);
    // Messages are spaced two minutes apart from the start of the conversation.
    const at = (index: number) => new Date(startedAt.getTime() + index * 120_000);
    const lastIndex = conversation.messages.length - 1;
    const lastInbound = conversation.messages.findLastIndex((m) => m.from === "customer");
    const lastOutbound = conversation.messages.findLastIndex((m) => m.from !== "customer");
    const visitorId = `demo-visitor-${conversation.id.slice(-4)}`;

    await tx.insert(contacts).values({
      id: conversation.contactId,
      ...tenant,
      displayName: conversation.contact.name,
      phone: conversation.contact.phone,
      email: conversation.contact.email,
      address: conversation.contact.address,
      firstSeenAt: startedAt,
      lastSeenAt: at(Math.max(lastInbound, 0)),
    });
    bump("contacts");
    await tx.insert(contactIdentities).values({
      ...tenant,
      contactId: conversation.contactId,
      channel: "test",
      externalId: visitorId,
      displayName: conversation.contact.name,
      lastSeenAt: at(Math.max(lastInbound, 0)),
    });
    bump("contact_identities");

    const closed = conversation.lead.status === "disqualified";
    await tx.insert(conversations).values({
      id: conversation.id,
      ...tenant,
      contactId: conversation.contactId,
      channelConnectionId: business.connectionId,
      channel: "test",
      status: closed ? "closed" : "open",
      closedAt: closed ? at(lastIndex) : null,
      closedReason: closed ? "not_a_fit" : null,
      messageSeq: conversation.messages.length,
      lastInboundAt: lastInbound >= 0 ? at(lastInbound) : null,
      lastOutboundAt: lastOutbound >= 0 ? at(lastOutbound) : null,
      lastMessageAt: at(lastIndex),
      createdAt: startedAt,
    });
    bump("conversations");

    await tx.insert(messages).values(
      conversation.messages.map((message, index) => {
        const inbound = message.from === "customer";
        return {
          ...tenant,
          conversationId: conversation.id,
          channelConnectionId: business.connectionId,
          direction: inbound ? ("inbound" as const) : ("outbound" as const),
          author: message.from,
          authorUserId: message.from === "human_agent" ? userIds.agencyMember : null,
          text: message.text,
          externalMessageId: `demo-${conversation.id.slice(-4)}-${index + 1}`,
          sequence: index + 1,
          status: inbound ? ("received" as const) : ("delivered" as const),
          enqueuedAt: inbound ? at(index) : null,
          sentAt: at(index),
          deliveredAt: inbound ? null : at(index),
          createdAt: at(index),
        };
      }),
    );
    bump("messages", conversation.messages.length);

    const lead = conversation.lead;
    const decidedAt = at(lastIndex);
    await tx.insert(leads).values({
      id: conversation.leadId,
      ...tenant,
      contactId: conversation.contactId,
      conversationId: conversation.id,
      status: lead.status,
      score: lead.score,
      band: lead.band,
      routingOutcome: lead.outcome,
      routingDecidedAt: decidedAt,
      settingsVersion: "seed",
      qualifiedAt: ["qualified", "meeting_requested", "meeting_booked", "handed_off"].includes(
        lead.status,
      )
        ? decidedAt
        : null,
      disqualifiedAt: lead.status === "disqualified" ? decidedAt : null,
      disqualifyReason: lead.disqualifyReason ?? null,
      handedOffAt: lead.status === "handed_off" ? decidedAt : null,
      createdAt: startedAt,
    });
    bump("leads");

    const fields = Object.entries(lead.fields);
    await tx.insert(leadFields).values(
      fields.map(([key, field]) => ({
        ...tenant,
        leadId: conversation.leadId,
        key,
        value: field.value,
        confidence: field.confidence,
        evidence: field.evidence,
      })),
    );
    bump("lead_fields", fields.length);

    await tx.insert(routingDecisions).values({
      ...tenant,
      leadId: conversation.leadId,
      outcome: lead.outcome,
      score: lead.score,
      band: lead.band,
      reasons: [...lead.reasons],
      settingsVersion: "seed",
      decidedAt,
    });
    bump("routing_decisions");

    await tx.insert(leadReports).values({
      ...tenant,
      leadId: conversation.leadId,
      version: 1,
      summary: lead.summary,
      markdown: [
        `## ${conversation.contact.name}`,
        "",
        lead.summary,
        "",
        `**Score:** ${lead.score} (${lead.band})`,
        "",
        "**Why:**",
        ...lead.reasons.map((reason) => `- ${reason}`),
      ].join("\n"),
      sections: { who: conversation.contact.name, fit: lead.reasons },
      score: lead.score,
      band: lead.band,
      settingsVersion: "seed",
      createdAt: decidedAt,
    });
    bump("lead_reports");

    if (lead.status === "meeting_booked") {
      const startsAt = new Date(now.getTime() + 3 * 24 * 3_600_000);
      await tx.insert(bookings).values({
        ...tenant,
        contactId: conversation.contactId,
        conversationId: conversation.id,
        leadId: conversation.leadId,
        provider: "manual",
        status: "confirmed",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
        timezone: business.timezone,
        title: `Roof inspection: ${conversation.contact.name}`,
        location: conversation.contact.address,
      });
      bump("bookings");
    }

    if (lead.status === "handed_off") {
      await tx.insert(takeoverLocks).values({
        ...tenant,
        conversationId: conversation.id,
        userId: userIds.agencyMember,
        source: "admin_panel",
        reason: "Emergency: technician took over",
        startedAt: at(lastIndex),
        lastActivityAt: at(lastIndex),
      });
      bump("takeover_locks");
      await tx.insert(escalations).values({
        ...tenant,
        conversationId: conversation.id,
        leadId: conversation.leadId,
        emergencyClass: "no_heat_freezing",
        summary: lead.summary,
        status: "acknowledged",
        chain: [{ name: "On-call technician", channel: "sms" }],
        startedAt: at(1),
        acknowledgedAt: at(lastIndex),
        acknowledgedBy: "On-call technician",
        endedAt: at(lastIndex),
      });
      bump("escalations");
      await tx.insert(alerts).values({
        ...tenant,
        conversationId: conversation.id,
        leadId: conversation.leadId,
        kind: "emergency",
        severity: "critical",
        channel: "sms",
        recipient: "+16125550101",
        status: "acknowledged",
        subject: "Emergency: no heat in freezing weather",
        body: lead.summary,
        sentAt: at(1),
        acknowledgedAt: at(lastIndex),
        acknowledgedBy: "On-call technician",
      });
      bump("alerts");
      await tx.insert(internalNotes).values({
        ...tenant,
        conversationId: conversation.id,
        authorUserId: userIds.agencyMember,
        body: "Tom confirmed he is on the way. Follow up tomorrow about a maintenance plan.",
      });
      bump("internal_notes");
    }
  }
}

/**
 * Writes the demo data. Safe to run repeatedly: the demo agency is replaced as a whole.
 * Refuses nothing by itself; `scripts/seed.ts` decides where it may run.
 */
export async function seedDemoData(db: Database, options: SeedOptions = {}): Promise<SeedSummary> {
  const now = options.now ?? new Date();
  const userIds = await ensureUsers(db, options);

  await db.platform.deleteAgency(DEMO.agencyId);
  await db.platform.createAgency({
    id: DEMO.agencyId,
    name: "Brightline Growth Agency",
    slug: DEMO.agencySlug,
  });

  const counts: Record<string, number> = { agencies: 1, users: Object.keys(userIds).length };
  await db.forAgency(DEMO.agencyId).run(async (ctx) => {
    const { tx } = ctx;
    const agencyId = ctx.tenant.agencyId;

    await tx.insert(agencyMemberships).values([
      { agencyId, userId: userIds.agencyAdmin, role: "agency_admin" },
      { agencyId, userId: userIds.agencyMember, role: "agency_member" },
    ]);
    counts["agency_memberships"] = 2;

    await tx.insert(segments).values([
      { id: DEMO.segments.roofing, agencyId, slug: "roofing", name: "Roofing" },
      { id: DEMO.segments.hvac, agencyId, slug: "hvac", name: "Heating and cooling (HVAC)" },
    ]);
    counts["segments"] = 2;
    await tx.insert(playbookVersions).values([
      {
        agencyId,
        segmentId: DEMO.segments.roofing,
        version: 1,
        isActive: true,
        origin: "manual",
        document: ROOFING_PLAYBOOK,
        changeNote: "Demo playbook from the seed",
        createdBy: userIds.agencyAdmin,
      },
      {
        agencyId,
        segmentId: DEMO.segments.hvac,
        version: 1,
        isActive: true,
        origin: "manual",
        document: HVAC_PLAYBOOK,
        changeNote: "Demo playbook from the seed",
        createdBy: userIds.agencyAdmin,
      },
    ]);
    counts["playbook_versions"] = 2;

    for (const business of SEED_BUSINESSES) {
      await seedBusiness(ctx, business, userIds, now, counts);
    }

    await tx.insert(businessMemberships).values([
      {
        agencyId,
        businessId: DEMO.businesses.roofing,
        userId: userIds.clientOwner,
        role: "client_owner",
      },
      {
        agencyId,
        businessId: DEMO.businesses.roofing,
        userId: userIds.clientStaff,
        role: "client_staff",
      },
    ]);
    counts["business_memberships"] = 2;

    await recordSystemAudit(
      ctx,
      { type: "system", label: "seed" },
      { action: "seed.run", summary: "Demo data loaded", targetType: "agency", targetId: agencyId },
    );
    counts["audit_log"] = 1;
  });

  return {
    agencyId: DEMO.agencyId,
    businesses: SEED_BUSINESSES.map((business) => ({
      id: business.id,
      name: business.name,
      segment: business.segment,
    })),
    users: Object.values(DEMO.users).map((user) => ({ email: user.email, role: user.role })),
    counts,
  };
}
