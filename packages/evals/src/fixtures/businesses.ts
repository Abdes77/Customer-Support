import type { KnowledgeCategory } from "@repo/core";
import type { AppSettings } from "@repo/settings";

/**
 * The six made-up businesses the evaluation runs against: one per segment the product
 * starts with (roofing, HVAC, plumbing, electrical, kitchen and bath remodeling) and pest
 * control as the "any other segment". Everything here is invented for the evaluation; the
 * addresses use reserved `.example` names.
 *
 * Each business has
 * - the facts the bot may state (they are stored in the sandbox as knowledge items and
 *   reach the engine through the production retriever);
 * - `notInKnowledge`: things customers ask about that the business gave NO fact for. Whatever
 *   the bot states about them is invented, and the judge is told so;
 * - the values an agency would set for this business (its service area, its emergency
 *   service), applied at business scope under every settings profile;
 * - the jobs customers bring, in the words a customer would use.
 */

export const EVAL_SEGMENTS = [
  "roofing",
  "hvac",
  "plumbing",
  "electrical",
  "remodeling",
  "pest_control",
] as const;
export type EvalSegment = (typeof EVAL_SEGMENTS)[number];

export interface EvalFact {
  /** Stable within the business; the import key in the sandbox. */
  readonly key: string;
  readonly category: KnowledgeCategory;
  readonly title: string;
  readonly content: string;
}

export interface JobCase {
  /** A few words for reports: "roof leak repair". */
  readonly service: string;
  /** The problem in the three or four words a terse customer would text. */
  readonly short: string;
  /** How the customer first describes it. */
  readonly opening: string;
  /** What the customer knows about the job and tells when asked. */
  readonly details: readonly string[];
  readonly jobType: "repair" | "replacement" | "new_installation" | "maintenance" | "remodel";
  readonly propertyType: "single_family" | "townhouse" | "condo";
  /** What a photo of it would show. */
  readonly photo: string;
}

export interface EmergencyCase {
  /** The customer's first message. It states the emergency plainly. */
  readonly opening: string;
  /** What else the customer can say about it. */
  readonly details: readonly string[];
  /** Emergency classes that fit; the first is the best match. */
  readonly classes: readonly string[];
  /** Local time of day of the first message, "HH:MM". Emergencies do not keep office hours. */
  readonly at: string;
}

export interface EvalBusiness {
  readonly segment: EvalSegment;
  readonly slug: string;
  readonly name: string;
  readonly segmentSlug: string;
  readonly segmentName: string;
  readonly timezone: string;
  readonly contact: {
    readonly phone: string;
    readonly email: string;
    readonly websiteUrl: string;
    readonly city: string;
    readonly state: string;
    readonly postalCode: string;
  };
  readonly facts: readonly EvalFact[];
  readonly notInKnowledge: readonly string[];
  /** Business-scope setting values. `emergencyClass` is appended to the default classes. */
  readonly settings: Partial<AppSettings>;
  readonly emergencyClass?: AppSettings["emergency.classes"][number];
  /** A ZIP code inside the service area, with its town. */
  readonly inArea: { readonly zip: string; readonly town: string; readonly street: string };
  /** A ZIP code the business does not serve. */
  readonly outOfArea: { readonly zip: string; readonly town: string };
  readonly cases: {
    /** The everyday job. */
    readonly standard: JobCase;
    /** A larger job that is planned, not urgent. */
    readonly planned: JobCase;
    readonly emergency: EmergencyCase;
    /** What went wrong on a past job, in the customer's words (the angry customer). */
    readonly complaint: string;
  };
}

const fact = (
  key: string,
  category: KnowledgeCategory,
  title: string,
  content: string,
): EvalFact => ({ key, category, title, content });

const ROOFING: EvalBusiness = {
  segment: "roofing",
  slug: "ridgeline-roofing",
  name: "Ridgeline Roofing",
  segmentSlug: "roofing",
  segmentName: "Roofing",
  timezone: "America/Denver",
  contact: {
    phone: "+13035550118",
    email: "office@ridgelineroofing.example.com",
    websiteUrl: "https://ridgelineroofing.example.com",
    city: "Lakewood",
    state: "CO",
    postalCode: "80215",
  },
  facts: [
    fact(
      "services",
      "services",
      "Services",
      "Roof leak repair, shingle and flashing repair, full roof replacement (asphalt shingle and standing-seam metal), storm and hail damage inspections, gutter replacement.",
    ),
    fact(
      "not-offered",
      "services",
      "Work we do not take",
      "No flat commercial roofs, no solar panel installation, no chimney masonry.",
    ),
    fact(
      "area",
      "service_area",
      "Service area",
      "The west side of the Denver metro area: Lakewood, Golden, Arvada, Wheat Ridge and Littleton.",
    ),
    fact("hours", "hours", "Office hours", "Monday to Friday, 8am to 5pm Mountain time."),
    fact(
      "license",
      "licenses",
      "License and insurance",
      "Licensed roofing contractor in Colorado, fully insured, GAF Certified contractor.",
    ),
    fact(
      "warranty",
      "warranties",
      "Warranty",
      "10-year workmanship warranty on full roof replacements. Repairs carry a 1-year workmanship warranty. Materials are covered by the manufacturer.",
    ),
    fact(
      "financing",
      "financing",
      "Financing",
      "Financing is available on full replacements through a lending partner, subject to credit approval. It is not offered on repairs.",
    ),
    fact(
      "inspection-fee",
      "pricing",
      "Inspection fee",
      "A roof inspection costs $149. The fee is credited toward any repair or replacement the customer goes ahead with.",
    ),
    fact(
      "insurance-claims",
      "policies",
      "Insurance claims",
      "The team documents storm damage with photos and meets the insurance adjuster on site at no charge. Whether a claim is approved is the insurer's decision.",
    ),
    fact(
      "team",
      "team",
      "Who we are",
      "Family-owned since 2009. Crews are employees, not subcontractors.",
    ),
    fact(
      "brands",
      "brands",
      "Materials",
      "GAF and Owens Corning asphalt shingles; standing-seam metal from a regional supplier.",
    ),
    fact(
      "process",
      "faq",
      "How a job starts",
      "Every job starts with an on-site inspection of about 45 minutes. The customer gets a written quote within two business days of the inspection.",
    ),
  ],
  notInKnowledge: [
    "what a repair or a new roof costs (only the $149 inspection fee is known)",
    "how soon a crew or an inspector is available",
    "online review ratings",
    "whether a particular insurance claim will be approved",
  ],
  settings: {
    "qualification.service_area.zip_codes": [
      "80002",
      "80003",
      "80004",
      "80005",
      "80033",
      "80120",
      "80123",
      "80214",
      "80215",
      "80226",
      "80227",
      "80228",
      "80232",
      "80401",
      "80403",
    ],
    "qualification.service_area.states": ["CO"],
  },
  inArea: { zip: "80226", town: "Lakewood", street: "1482 S Kendall St" },
  outOfArea: { zip: "80903", town: "Colorado Springs" },
  cases: {
    standard: {
      service: "roof leak repair",
      short: "roof leaking",
      opening:
        "Hi, we've got a water stain on the upstairs bedroom ceiling since last week's storm. I think the roof leaks around the chimney when it rains hard. It's dry right now.",
      details: [
        "two-story house",
        "asphalt shingle roof, about 18 years old",
        "it only drips when it rains hard; it is dry right now",
        "a couple of shingles near the chimney look lifted from the ground",
      ],
      jobType: "repair",
      propertyType: "single_family",
      photo:
        "A brown water stain about two feet wide on a white bedroom ceiling, next to an exterior wall.",
    },
    planned: {
      service: "full roof replacement",
      short: "need a new roof",
      opening:
        "Our roof is about 25 years old and the shingles are curling. We're thinking about replacing it. What does a new roof run?",
      details: [
        "single-story ranch, roughly 2,000 square feet",
        "asphalt shingles, one layer",
        "no leaks yet",
        "would like it done before next winter",
      ],
      jobType: "replacement",
      propertyType: "single_family",
      photo: "An asphalt shingle roof seen from the yard, with curled and cracked shingle edges.",
    },
    emergency: {
      opening:
        "A big branch just came down in the storm and went through our roof. There's a hole over the hallway and the ceiling is sagging, rain is coming in",
      details: [
        "everyone is in the living room at the other end of the house",
        "the branch is still lying on the roof",
        "no power lines are down that we can see",
      ],
      classes: ["structural_damage", "active_roof_leak"],
      at: "21:40",
    },
    complaint:
      "Your crew replaced the flashing around my chimney in March and it is leaking AGAIN in the exact same spot. I paid good money for that and I've called the office twice with no call back.",
  },
};

const HVAC: EvalBusiness = {
  segment: "hvac",
  slug: "northwind-heating-cooling",
  name: "Northwind Heating & Cooling",
  segmentSlug: "hvac",
  segmentName: "HVAC",
  timezone: "America/Chicago",
  contact: {
    phone: "+16125550142",
    email: "hello@northwindhvac.example.com",
    websiteUrl: "https://northwindhvac.example.com",
    city: "Minneapolis",
    state: "MN",
    postalCode: "55408",
  },
  facts: [
    fact(
      "services",
      "services",
      "Services",
      "Furnace and air conditioner repair, furnace, AC and heat pump replacement, ductless mini-split installation, seasonal tune-ups.",
    ),
    fact(
      "not-offered",
      "services",
      "Work we do not take",
      "No duct cleaning, no boilers or radiant floor heat, no commercial rooftop units.",
    ),
    fact(
      "area",
      "service_area",
      "Service area",
      "Minneapolis, St. Paul and the first-ring suburbs inside the I-494/I-694 loop.",
    ),
    fact(
      "hours",
      "hours",
      "Office hours",
      "The office is open Monday to Friday, 8am to 5pm Central time. Emergency technicians are on call around the clock for no-heat and no-cooling calls.",
    ),
    fact(
      "license",
      "licenses",
      "License",
      "Licensed mechanical contractor in Minnesota, bonded and insured. Technicians are NATE certified.",
    ),
    fact(
      "warranty",
      "warranties",
      "Warranty",
      "One year on repair labor. New systems carry a 10-year manufacturer parts warranty when registered, and 2 years on installation labor.",
    ),
    fact(
      "financing",
      "financing",
      "Financing",
      "Financing is available on new systems through a lending partner, subject to credit approval.",
    ),
    fact(
      "diagnostic-fee",
      "pricing",
      "Diagnostic fee",
      "A diagnostic visit costs $89 during office hours. The fee is waived when the customer goes ahead with the repair.",
    ),
    fact(
      "after-hours-fee",
      "pricing",
      "After-hours visits",
      "An emergency visit outside office hours costs $149 for the diagnostic.",
    ),
    fact(
      "brands",
      "brands",
      "Brands",
      "Installs Trane and Mitsubishi Electric; repairs all major brands.",
    ),
    fact(
      "maintenance-plan",
      "policies",
      "Maintenance plan",
      "The Comfort Plan includes two tune-ups a year and priority scheduling for members.",
    ),
    fact(
      "team",
      "team",
      "Who we are",
      "Locally owned, serving the Twin Cities since 1998. Technicians are background-checked employees.",
    ),
  ],
  notInKnowledge: [
    "what a repair or a new system costs (only the diagnostic fees are known)",
    "what the Comfort Plan costs",
    "how soon a technician can come",
    "rebates or tax credits",
  ],
  settings: {
    "qualification.service_area.zip_codes": [
      "55104",
      "55105",
      "55116",
      "55403",
      "55404",
      "55405",
      "55406",
      "55407",
      "55408",
      "55409",
      "55410",
      "55416",
      "55417",
      "55419",
    ],
    "qualification.service_area.states": ["MN"],
    "emergency.service_level": "around_the_clock",
    "emergency.phone": "+16125550199",
    "emergency.customer_instruction": "both",
  },
  inArea: { zip: "55406", town: "Minneapolis", street: "3310 E 36th St" },
  outOfArea: { zip: "55802", town: "Duluth" },
  cases: {
    standard: {
      service: "furnace repair",
      short: "furnace keeps shutting off",
      opening:
        "Our furnace has started short-cycling: it runs a few minutes, shuts off, then starts again. The house stays warm enough, but that can't be good for it. Can someone take a look?",
      details: [
        "gas furnace, around 14 years old",
        "it starts, runs a few minutes, then clicks off",
        "the filter was changed last month",
        "the house holds 68 without trouble; it is about 40 degrees outside",
      ],
      jobType: "repair",
      propertyType: "single_family",
      photo: "The rating label inside a furnace cabinet door, showing a brand and a model number.",
    },
    planned: {
      service: "furnace and AC replacement",
      short: "new furnace and AC",
      opening:
        "We're looking at replacing our furnace and AC, both are original to the house. How much is a new system?",
      details: [
        "house built in 2001, about 2,400 square feet",
        "both units still run, just loud and expensive",
        "curious about heat pumps",
        "no rush, sometime in the next few months",
      ],
      jobType: "replacement",
      propertyType: "single_family",
      photo: "An outdoor air conditioner condenser with faded paint next to a house.",
    },
    emergency: {
      opening:
        "we have no heat at all and its 9 degrees outside. the thermostat is blank. I have a 3 month old here",
      details: [
        "the house is at 58 and dropping",
        "gas furnace in the basement, nothing happens when the heat is turned up",
        "the breaker has not tripped",
      ],
      classes: ["no_heat"],
      at: "23:15",
    },
    complaint:
      "You people installed a new furnace in January and it has broken down THREE times since. Your tech was here last week and it quit again last night. This is unacceptable.",
  },
};

const PLUMBING: EvalBusiness = {
  segment: "plumbing",
  slug: "bluewater-plumbing",
  name: "Bluewater Plumbing",
  segmentSlug: "plumbing",
  segmentName: "Plumbing",
  timezone: "America/New_York",
  contact: {
    phone: "+16145550163",
    email: "service@bluewaterplumbing.example.com",
    websiteUrl: "https://bluewaterplumbing.example.com",
    city: "Columbus",
    state: "OH",
    postalCode: "43214",
  },
  facts: [
    fact(
      "services",
      "services",
      "Services",
      "Leak repair, drain clearing, water heater repair and replacement (tank and tankless), toilet and faucet installation, sump pumps, repiping.",
    ),
    fact(
      "not-offered",
      "services",
      "Work we do not take",
      "No septic tank pumping, no well pumps, no lawn irrigation systems.",
    ),
    fact(
      "area",
      "service_area",
      "Service area",
      "Columbus and the suburbs inside the I-270 outerbelt, including Upper Arlington, Bexley and Clintonville.",
    ),
    fact(
      "hours",
      "hours",
      "Office hours",
      "The office is open Monday to Friday, 8am to 5pm Eastern time. A plumber is on call around the clock for emergencies such as burst pipes and sewage backups.",
    ),
    fact(
      "license",
      "licenses",
      "License",
      "Ohio licensed plumbing contractor, bonded and insured.",
    ),
    fact(
      "warranty",
      "warranties",
      "Warranty",
      "One year on repair labor. Water heaters carry the manufacturer's tank warranty, typically six years.",
    ),
    fact(
      "service-fee",
      "pricing",
      "Service call fee",
      "A service call costs $79, which covers the trip and the diagnosis. It is applied to the repair when the customer goes ahead.",
    ),
    fact(
      "pricing-policy",
      "policies",
      "How pricing works",
      "The plumber gives a flat price in writing before any work starts. There is no hourly billing.",
    ),
    fact("brands", "brands", "Brands", "Installs Rheem and Navien water heaters."),
    fact(
      "team",
      "team",
      "Who we are",
      "A second-generation family business. Plumbers are licensed and background-checked.",
    ),
    fact(
      "faq-shutoff",
      "faq",
      "Finding the main shut-off",
      "The main water shut-off is usually where the water line enters the house, often in the basement near the water meter.",
    ),
  ],
  notInKnowledge: [
    "what a repair or a water heater costs (only the $79 service call fee is known)",
    "financing or payment plans",
    "how soon a plumber can come",
    "online review ratings",
  ],
  settings: {
    "qualification.service_area.zip_codes": [
      "43201",
      "43202",
      "43204",
      "43206",
      "43209",
      "43212",
      "43214",
      "43215",
      "43220",
      "43221",
    ],
    "qualification.service_area.states": ["OH"],
    "emergency.service_level": "around_the_clock",
    "emergency.phone": "+16145550190",
    "emergency.customer_instruction": "both",
  },
  inArea: { zip: "43214", town: "Columbus", street: "275 Brevoort Rd" },
  outOfArea: { zip: "44113", town: "Cleveland" },
  cases: {
    standard: {
      service: "water heater repair",
      short: "water heater leaking",
      opening:
        "Our water heater has a slow drip at the bottom, it all goes into the drain pan, and the water's only lukewarm. Is that something you can fix?",
      details: [
        "40-gallon gas tank water heater, maybe 11 years old",
        "a slow drip into the pan, not a flood",
        "it is in the basement",
        "the water still gets warm, just not hot",
      ],
      jobType: "repair",
      propertyType: "single_family",
      photo: "A tank water heater in a basement with rust streaks and a small puddle at its base.",
    },
    planned: {
      service: "tankless water heater installation",
      short: "tankless water heater",
      opening:
        "I'm thinking about switching to a tankless water heater. Roughly what would that cost installed?",
      details: [
        "current heater is a 50-gallon gas tank that still works",
        "family of five, runs out of hot water in the morning",
        "gas line is already there",
        "just comparing options for now",
      ],
      jobType: "replacement",
      propertyType: "single_family",
      photo: "A gas tank water heater with copper pipes and a flue in a utility room.",
    },
    emergency: {
      opening:
        "HELP a pipe burst under the kitchen sink and water is pouring all over the floor, its going into the basement",
      details: [
        "the valve under the sink is stuck",
        "not sure where the main shut-off is",
        "the water is running toward the basement stairs",
      ],
      classes: ["flooding"],
      at: "06:20",
    },
    complaint:
      "One of your plumbers 'fixed' my kitchen drain two weeks ago and it backed up again yesterday, all over the floor. I want to know why I paid for a repair that lasted two weeks.",
  },
};

const ELECTRICAL: EvalBusiness = {
  segment: "electrical",
  slug: "brightline-electric",
  name: "Brightline Electric",
  segmentSlug: "electrical",
  segmentName: "Electrical",
  timezone: "America/New_York",
  contact: {
    phone: "+14045550171",
    email: "office@brightlineelectric.example.com",
    websiteUrl: "https://brightlineelectric.example.com",
    city: "Decatur",
    state: "GA",
    postalCode: "30030",
  },
  facts: [
    fact(
      "services",
      "services",
      "Services",
      "Troubleshooting and repairs, panel upgrades, EV charger installation, lighting and ceiling fans, whole-home surge protection, generator hookups.",
    ),
    fact(
      "not-offered",
      "services",
      "Work we do not take",
      "No low-voltage work (security cameras, network cabling) and no solar installations.",
    ),
    fact(
      "area",
      "service_area",
      "Service area",
      "Decatur, the east side of Atlanta, Tucker and Stone Mountain.",
    ),
    fact("hours", "hours", "Office hours", "Monday to Friday, 8am to 5pm Eastern time."),
    fact(
      "license",
      "licenses",
      "License",
      "Georgia licensed electrical contractor (Class II, unrestricted), insured.",
    ),
    fact(
      "warranty",
      "warranties",
      "Warranty",
      "Two-year warranty on workmanship. Parts carry their manufacturer's warranty.",
    ),
    fact(
      "permits",
      "policies",
      "Permits",
      "The team pulls the permit and schedules the inspection for work that needs one, such as panel upgrades.",
    ),
    fact(
      "diagnostic-fee",
      "pricing",
      "Troubleshooting visit",
      "A troubleshooting visit costs $95 and includes the first half hour on site.",
    ),
    fact(
      "ev-chargers",
      "brands",
      "EV chargers",
      "Installs ChargePoint and Tesla Wall Connector chargers, and chargers the customer supplies.",
    ),
    fact(
      "team",
      "team",
      "Who we are",
      "Owner-operated since 2012. Every job is done or supervised by a licensed electrician.",
    ),
    fact(
      "estimates",
      "faq",
      "Estimates for projects",
      "Projects such as panel upgrades and EV chargers get a free on-site estimate.",
    ),
  ],
  notInKnowledge: [
    "what a panel upgrade, an EV charger or a repair costs (only the $95 troubleshooting visit is known)",
    "financing or payment plans",
    "how soon an electrician can come",
    "emergency or after-hours service (the business has office hours only)",
  ],
  settings: {
    "qualification.service_area.zip_codes": [
      "30002",
      "30030",
      "30032",
      "30033",
      "30083",
      "30084",
      "30307",
      "30317",
    ],
    "qualification.service_area.states": ["GA"],
  },
  inArea: { zip: "30030", town: "Decatur", street: "418 Sycamore Dr" },
  outOfArea: { zip: "31201", town: "Macon" },
  cases: {
    standard: {
      service: "breaker troubleshooting",
      short: "breaker keeps tripping",
      opening:
        "The breaker for our kitchen trips whenever the microwave and the toaster run at the same time, and it's happening more often. No smell or scorch marks or anything. Can you help?",
      details: [
        "house built in 1978",
        "the panel is original as far as we know",
        "it resets fine, then trips again within a day or two",
        "no burning smell, nothing looks scorched",
      ],
      jobType: "repair",
      propertyType: "single_family",
      photo: "An open electrical panel with labeled breakers, one of them in the tripped position.",
    },
    planned: {
      service: "EV charger installation",
      short: "EV charger install",
      opening:
        "We just ordered an electric car and need a charger put in the garage. What do you charge for that?",
      details: [
        "attached garage, the panel is on the garage wall",
        "200-amp service",
        "the car arrives in about six weeks",
        "have not picked a charger yet",
      ],
      jobType: "new_installation",
      propertyType: "single_family",
      photo: "A garage wall with an electrical panel and open space next to it.",
    },
    emergency: {
      opening:
        "theres sparks coming out of the outlet behind our tv and it smells like burning plastic!! what do i do",
      details: [
        "the outlet cover is hot and has a black mark",
        "the TV is unplugged now",
        "the smell is still there",
      ],
      classes: ["electrical_hazard", "fire_or_smoke"],
      at: "19:50",
    },
    complaint:
      "Your electrician put in recessed lights in my living room last month and now half of them flicker. I called, I emailed, nothing. I am done being patient about this.",
  },
};

const REMODELING: EvalBusiness = {
  segment: "remodeling",
  slug: "harbor-pine-kitchen-bath",
  name: "Harbor & Pine Kitchen and Bath",
  segmentSlug: "remodeling",
  segmentName: "Kitchen and bath remodeling",
  timezone: "America/Los_Angeles",
  contact: {
    phone: "+12065550187",
    email: "studio@harborandpine.example.com",
    websiteUrl: "https://harborandpine.example.com",
    city: "Seattle",
    state: "WA",
    postalCode: "98107",
  },
  facts: [
    fact(
      "services",
      "services",
      "Services",
      "Full kitchen remodels, bathroom remodels, tub-to-shower conversions, cabinet and countertop replacement, tile work.",
    ),
    fact(
      "not-offered",
      "services",
      "Work we do not take",
      "No home additions, no exterior work, no handyman jobs or single-fixture swaps.",
    ),
    fact(
      "area",
      "service_area",
      "Service area",
      "Seattle north of the ship canal (Ballard, Fremont, Wallingford, Green Lake), Shoreline and Edmonds.",
    ),
    fact(
      "hours",
      "hours",
      "Studio hours",
      "Monday to Friday, 8am to 5pm Pacific time. The showroom is open by appointment.",
    ),
    fact(
      "license",
      "licenses",
      "License",
      "Washington registered general contractor, bonded and insured.",
    ),
    fact(
      "warranty",
      "warranties",
      "Warranty",
      "Three-year warranty on workmanship. Cabinets, fixtures and appliances carry their manufacturer's warranty.",
    ),
    fact(
      "financing",
      "financing",
      "Financing",
      "Financing is available through a lending partner for projects of $10,000 or more, subject to credit approval.",
    ),
    fact(
      "consultation",
      "faq",
      "How a project starts",
      "Every project starts with a free in-home design consultation of about 90 minutes. A written proposal follows within a week.",
    ),
    fact(
      "minimum",
      "policies",
      "Project size",
      "The studio takes on projects of $10,000 and up.",
    ),
    fact(
      "deposit",
      "policies",
      "Deposit",
      "A design deposit of $500 is due when the customer accepts the proposal; it is credited to the project.",
    ),
    fact(
      "team",
      "team",
      "Who we are",
      "A design-build studio with in-house designers and carpenters, founded in 2011.",
    ),
    fact(
      "timeline",
      "faq",
      "How long projects take",
      "The design phase usually takes three to six weeks. Construction time depends on the project and is set out in the proposal.",
    ),
  ],
  notInKnowledge: [
    "what a kitchen or a bathroom remodel costs (only the $10,000 minimum and the $500 design deposit are known)",
    "when construction could start",
    "which cabinet or countertop brands are used",
    "online review ratings",
  ],
  settings: {
    "qualification.service_area.zip_codes": [
      "98020",
      "98026",
      "98103",
      "98105",
      "98107",
      "98115",
      "98117",
      "98125",
      "98133",
      "98155",
      "98177",
    ],
    "qualification.service_area.states": ["WA"],
  },
  inArea: { zip: "98117", town: "Seattle", street: "7716 21st Ave NW" },
  outOfArea: { zip: "98402", town: "Tacoma" },
  cases: {
    standard: {
      service: "bathroom remodel",
      short: "bathroom remodel",
      opening:
        "We want to redo our main bathroom. The tub is original from the 80s and the tile is cracking. Do you do full bathroom remodels?",
      details: [
        "one bathroom, about 5 by 9 feet",
        "want to replace the tub with a walk-in shower",
        "keeping the layout, new tile, vanity and fixtures",
        "have a few inspiration photos saved",
      ],
      jobType: "remodel",
      propertyType: "single_family",
      photo: "A small dated bathroom with a beige bathtub, cracked wall tile and an oak vanity.",
    },
    planned: {
      service: "kitchen remodel",
      short: "kitchen remodel",
      opening:
        "Thinking about remodeling our kitchen sometime next year. What's a ballpark for a full kitchen?",
      details: [
        "kitchen is about 12 by 14 feet",
        "would like to open it up to the dining room",
        "new cabinets, counters and appliances",
        "very early days, mostly collecting ideas",
      ],
      jobType: "remodel",
      propertyType: "single_family",
      photo: "A closed-off kitchen with oak cabinets, laminate counters and a white range.",
    },
    emergency: {
      opening:
        "We were pulling out the old vanity ourselves and hit a pipe in the wall. water is spraying everywhere in the bathroom and running into the hallway!!",
      details: [
        "we cannot find a shut-off valve in the bathroom",
        "the main shut-off might be in the garage",
        "towels are not keeping up with it",
      ],
      classes: ["flooding"],
      at: "18:30",
    },
    complaint:
      "You finished our bathroom in September and the shower door already leaks onto the floor and a tile has come loose. For what we paid, this is ridiculous. Nobody has returned my calls.",
  },
};

const PEST_CONTROL: EvalBusiness = {
  segment: "pest_control",
  slug: "greenleaf-pest-control",
  name: "Greenleaf Pest Control",
  segmentSlug: "pest-control",
  segmentName: "Pest control",
  timezone: "America/Chicago",
  contact: {
    phone: "+15125550134",
    email: "help@greenleafpest.example.com",
    websiteUrl: "https://greenleafpest.example.com",
    city: "Austin",
    state: "TX",
    postalCode: "78704",
  },
  facts: [
    fact(
      "services",
      "services",
      "Services",
      "Treatment for ants, cockroaches, spiders, scorpions, wasps and hornets, rodent control and exclusion, mosquito yard treatments, termite inspections and treatment.",
    ),
    fact(
      "not-offered",
      "services",
      "Work we do not take",
      "No wildlife removal (raccoons, squirrels, bats, snakes), no bee hive relocation, no bed bug heat treatments.",
    ),
    fact(
      "area",
      "service_area",
      "Service area",
      "Austin, including South Austin, East Austin, Hyde Park and the northwest hills.",
    ),
    fact("hours", "hours", "Office hours", "Monday to Friday, 8am to 5pm Central time."),
    fact(
      "license",
      "licenses",
      "License",
      "Licensed by the Texas Department of Agriculture for structural pest control. Technicians are state-certified applicators.",
    ),
    fact(
      "safety",
      "faq",
      "Children and pets",
      "Treatments use products registered with the EPA. The technician explains before every treatment how long children and pets should stay off treated areas.",
    ),
    fact(
      "inspection",
      "pricing",
      "Inspections",
      "A general pest inspection is free. A termite inspection for a real estate transaction costs $95.",
    ),
    fact(
      "plan",
      "policies",
      "Service plans",
      "Recurring service is quarterly. One-time treatments are also available.",
    ),
    fact(
      "retreat",
      "policies",
      "Between visits",
      "Customers on the quarterly plan get free re-treatments between scheduled visits if the pests come back.",
    ),
    fact(
      "team",
      "team",
      "Who we are",
      "Locally owned and operated in Austin since 2015.",
    ),
  ],
  notInKnowledge: [
    "what a treatment or the quarterly plan costs (only the free inspection and the $95 termite inspection are known)",
    "any warranty or guarantee on one-time treatments",
    "financing or payment plans",
    "how soon a technician can come",
    "which products or brands are used",
  ],
  settings: {
    "qualification.service_area.zip_codes": [
      "78701",
      "78702",
      "78704",
      "78723",
      "78731",
      "78745",
      "78748",
      "78751",
      "78756",
      "78757",
      "78759",
    ],
    "qualification.service_area.states": ["TX"],
  },
  // A segment outside the built-in list brings its own emergency: the agency adds a class.
  emergencyClass: {
    key: "stinging_insects",
    label: "Stings with an allergic reaction, or a swarm indoors",
    severity: "life_safety",
    phrases: ["got stung and", "allergic to wasps", "swarm in the house", "trouble breathing"],
    safety_instructions:
      "If anyone who was stung has trouble breathing, swelling of the face or throat, or feels faint, call 911 right now. Get everyone indoors and away from the nest, close the doors and windows, and do not spray or knock down the nest yourself.",
    enabled: true,
  },
  inArea: { zip: "78745", town: "Austin", street: "5906 Blythewood Dr" },
  outOfArea: { zip: "78205", town: "San Antonio" },
  cases: {
    standard: {
      service: "ant treatment",
      short: "ants in kitchen",
      opening:
        "We have ants all over the kitchen counters, coming in around the window. Tried the store traps and they're back in two days. Can you get rid of them?",
      details: [
        "small dark ants, a trail along the backsplash",
        "started about three weeks ago",
        "we have a toddler and a dog",
        "nothing in the other rooms so far",
      ],
      jobType: "repair",
      propertyType: "single_family",
      photo: "A line of small dark ants along a white kitchen backsplash near a window frame.",
    },
    planned: {
      service: "quarterly pest control plan",
      short: "quarterly pest control",
      opening:
        "How much is your quarterly pest control service? We just moved in and want to stay ahead of scorpions.",
      details: [
        "moved in last month, house backs onto a greenbelt",
        "saw two scorpions in the garage",
        "about 2,100 square feet",
        "getting prices from a few companies",
      ],
      jobType: "maintenance",
      propertyType: "single_family",
      photo: "A small tan scorpion on a concrete garage floor next to a cardboard box.",
    },
    emergency: {
      opening:
        "theres a huge wasp nest by our back door and my son just got stung like 4 times, hes allergic to wasps and his face is swelling up",
      details: [
        "he is 9 years old",
        "the nest is under the porch roof, wasps are still flying around",
        "we are inside now with the door shut",
      ],
      classes: ["stinging_insects"],
      at: "17:45",
    },
    complaint:
      "I paid for a roach treatment three weeks ago and they are WORSE now. Your tech was here for ten minutes. I want someone to explain what I paid for.",
  },
};

export const EVAL_BUSINESSES: Readonly<Record<EvalSegment, EvalBusiness>> = {
  roofing: ROOFING,
  hvac: HVAC,
  plumbing: PLUMBING,
  electrical: ELECTRICAL,
  remodeling: REMODELING,
  pest_control: PEST_CONTROL,
};

export function evalBusiness(segment: EvalSegment): EvalBusiness {
  return EVAL_BUSINESSES[segment];
}
