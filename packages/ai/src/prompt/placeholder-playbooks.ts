import type { PlaybookDocument } from "@repo/core";

/**
 * Stand-in playbooks, used when a business's segment has no playbook version yet. Industry
 * playbooks are generated, versioned and edited by `packages/knowledge` (C6); until one
 * exists for a segment the engine still needs trade context, so these short documents cover
 * the five segments the product starts with, plus a general one for everything else.
 *
 * They hold no prices on purpose: a figure that nobody reviewed must not reach a customer,
 * whatever the pricing settings say.
 */

const GENERAL: PlaybookDocument = {
  commonJobs: [
    { name: "Repair", scope: "Something is broken or leaking and needs fixing." },
    { name: "Replacement", scope: "Something is worn out and needs to be replaced." },
    { name: "New installation or remodel", scope: "A planned project with a design and a budget." },
    { name: "Maintenance or inspection", scope: "A check or tune-up before something goes wrong." },
  ],
  customerLanguage: [
    {
      phrase: "it just stopped working",
      meaning: "A sudden failure; ask what happened right before.",
    },
    {
      phrase: "it's been like this for a while",
      meaning: "A slow problem; less urgent, often bigger.",
    },
    {
      phrase: "just looking for a quote",
      meaning: "Comparing companies; a fast, clear next step wins.",
    },
  ],
  urgencySignals: [
    { signal: "Anything involving gas, fire, smoke, sparks or rising water", level: "emergency" },
    { signal: "The home cannot be used normally until it is fixed", level: "urgent" },
    { signal: "A planned improvement with no deadline", level: "routine" },
  ],
  qualificationQuestions: [
    {
      question: "What is going on, in your own words?",
      why: "Tells repair from replacement from project.",
    },
    { question: "Where is the property?", why: "Service area." },
    { question: "How soon do you need it done?", why: "Urgency and scheduling." },
    { question: "Is it your home, or do you rent or manage it?", why: "Who can approve the work." },
  ],
  objections: [
    {
      objection: "Can you just give me a price?",
      response:
        "Explain that the price depends on what the team finds, and offer the fastest way to a real quote.",
    },
    {
      objection: "I'm getting other quotes.",
      response:
        "That is sensible. Offer a time for the team to look, so they can compare like for like.",
    },
  ],
  seasonalPatterns: ["Demand rises with extreme weather; lead times get longer in peak season."],
  priceNorms: [],
  permitsAndRegulations: [
    "Larger jobs can need a permit from the city or county; the team confirms what applies.",
  ],
  vocabulary: [
    {
      term: "Estimate",
      definition: "A visit or call where the team looks at the job and prices it.",
    },
  ],
  sources: [],
};

const ROOFING: PlaybookDocument = {
  commonJobs: [
    {
      name: "Leak repair",
      scope: "Find and fix an active leak; replace damaged shingles and flashing.",
    },
    {
      name: "Roof replacement",
      scope: "Tear off and replace the roof, typical for roofs past 20 years.",
    },
    {
      name: "Storm damage inspection",
      scope: "Inspect after hail or wind, often with an insurance claim.",
    },
    { name: "Gutter and flashing work", scope: "Repair or replace gutters, flashing and vents." },
  ],
  customerLanguage: [
    { phrase: "water stain on the ceiling", meaning: "A leak that has been active for a while." },
    { phrase: "shingles in the yard", meaning: "Wind damage; the roof deck may be exposed." },
    { phrase: "granules in the gutters", meaning: "Shingles near the end of their life." },
  ],
  urgencySignals: [
    { signal: "Water is coming in right now", level: "emergency" },
    { signal: "A tree or large branch is on the roof", level: "emergency" },
    { signal: "A storm is forecast and the roof is open or tarped", level: "urgent" },
    { signal: "Planning a replacement this year", level: "routine" },
  ],
  qualificationQuestions: [
    { question: "What is going on with the roof?", why: "Separates a repair from a replacement." },
    { question: "Is water getting inside at the moment?", why: "Urgency." },
    { question: "What is the ZIP code of the property?", why: "Service area." },
    { question: "Roughly how old is the roof?", why: "Repair or replace." },
    { question: "Do you own the home?", why: "Who can approve the work." },
    { question: "Is an insurance claim involved?", why: "Changes the process and the timeline." },
  ],
  objections: [
    {
      objection: "Can't you just patch it?",
      response: "Often yes. The team looks first and says honestly whether a repair will hold.",
    },
    {
      objection: "My insurance should cover this.",
      response:
        "The team can document the damage for the claim; what the policy covers is the insurer's call.",
    },
  ],
  seasonalPatterns: [
    "Hail and wind season brings a rush of inspections.",
    "Replacements slow down in freezing weather.",
  ],
  priceNorms: [],
  permitsAndRegulations: ["Most re-roofs need a permit; the contractor usually pulls it."],
  vocabulary: [
    {
      term: "Flashing",
      definition: "Metal that seals the joints around chimneys, vents and walls.",
    },
    { term: "Decking", definition: "The wood surface under the shingles." },
    { term: "Square", definition: "100 square feet of roof." },
  ],
  sources: [],
};

const HVAC: PlaybookDocument = {
  commonJobs: [
    { name: "No heat or no cooling", scope: "Diagnose and repair a system that stopped working." },
    { name: "System replacement", scope: "Replace a furnace, air conditioner or heat pump." },
    { name: "Tune-up", scope: "Seasonal maintenance before winter or summer." },
    { name: "Ductwork and air quality", scope: "Duct repair, filters, humidifiers." },
  ],
  customerLanguage: [
    {
      phrase: "blowing cold air",
      meaning: "The furnace runs but does not heat: ignition or flame sensor.",
    },
    {
      phrase: "AC runs but the house stays warm",
      meaning: "Low refrigerant, a dirty coil or a failed part.",
    },
    {
      phrase: "it keeps turning on and off",
      meaning: "Short cycling: thermostat, airflow or sizing.",
    },
  ],
  urgencySignals: [
    { signal: "A gas smell or a carbon monoxide alarm", level: "emergency" },
    { signal: "No heat in freezing weather, or no cooling in extreme heat", level: "emergency" },
    { signal: "The system works but poorly", level: "urgent" },
    { signal: "Planning a replacement or a tune-up", level: "routine" },
  ],
  qualificationQuestions: [
    { question: "What is the system doing or not doing?", why: "Repair or replacement." },
    {
      question: "Is it a furnace, a heat pump, or central air?",
      why: "Sends the right technician.",
    },
    { question: "Roughly how old is the system?", why: "Repair or replace." },
    { question: "What is the ZIP code?", why: "Service area." },
    { question: "How soon do you need someone out?", why: "Urgency." },
    { question: "Do you own the home?", why: "Who can approve the work." },
  ],
  objections: [
    {
      objection: "How much is a new system?",
      response: "It depends on the home and the equipment; the team measures and quotes on site.",
    },
    {
      objection: "Can you tell me what's wrong over chat?",
      response: "Not reliably. A technician needs to test it; offer the next step to get one out.",
    },
  ],
  seasonalPatterns: [
    "First cold snap and first heat wave bring the most no-heat and no-cooling calls.",
    "Spring and fall are tune-up season.",
  ],
  priceNorms: [],
  permitsAndRegulations: ["Equipment replacements usually need a mechanical permit."],
  vocabulary: [
    { term: "Heat pump", definition: "One system that both heats and cools." },
    { term: "Condenser", definition: "The outdoor unit of an air conditioner." },
    {
      term: "SEER",
      definition: "An efficiency rating for cooling equipment; higher uses less power.",
    },
  ],
  sources: [],
};

const PLUMBING: PlaybookDocument = {
  commonJobs: [
    { name: "Leak or burst pipe", scope: "Stop the water, repair or replace the pipe." },
    { name: "Drain clearing", scope: "Clear a clogged sink, tub, toilet or main line." },
    { name: "Water heater", scope: "Repair or replace a tank or tankless water heater." },
    { name: "Fixture installation", scope: "Install faucets, toilets, disposals and the like." },
  ],
  customerLanguage: [
    {
      phrase: "no hot water",
      meaning: "A water heater problem: pilot, element or the tank itself.",
    },
    {
      phrase: "everything is backing up",
      meaning: "A blocked main sewer line, not a single drain.",
    },
    { phrase: "the water bill jumped", meaning: "A hidden leak or a running toilet." },
  ],
  urgencySignals: [
    { signal: "Water is spraying or flooding", level: "emergency" },
    { signal: "Sewage is coming up into the house", level: "emergency" },
    { signal: "No water or no hot water", level: "urgent" },
    { signal: "A drip, a slow drain or a planned install", level: "routine" },
  ],
  qualificationQuestions: [
    { question: "What is happening, and where in the house?", why: "Job type and size." },
    { question: "Is water running or leaking right now?", why: "Urgency." },
    { question: "What is the ZIP code?", why: "Service area." },
    { question: "How soon do you need someone?", why: "Scheduling." },
    { question: "Do you own the home?", why: "Who can approve the work." },
  ],
  objections: [
    {
      objection: "Is there a fee just to come out?",
      response: "Answer only from the business's pricing rules; otherwise the team confirms.",
    },
  ],
  seasonalPatterns: ["Frozen and burst pipes in cold snaps; water heaters fail more in winter."],
  priceNorms: [],
  permitsAndRegulations: ["Water heater replacements and re-pipes usually need a permit."],
  vocabulary: [
    { term: "Main shut-off", definition: "The valve that stops all water to the house." },
    { term: "Main line", definition: "The sewer pipe from the house to the street." },
  ],
  sources: [],
};

const ELECTRICAL: PlaybookDocument = {
  commonJobs: [
    { name: "Troubleshooting", scope: "Find why outlets, lights or a circuit stopped working." },
    { name: "Panel upgrade", scope: "Replace or enlarge the breaker panel, often to 200 amps." },
    {
      name: "EV charger or new circuit",
      scope: "Add a dedicated circuit for a charger or appliance.",
    },
    { name: "Lighting and fixtures", scope: "Install recessed lights, fans and fixtures." },
  ],
  customerLanguage: [
    {
      phrase: "the breaker keeps tripping",
      meaning: "An overloaded circuit or a fault; needs testing.",
    },
    {
      phrase: "the lights flicker",
      meaning: "A loose connection, possibly at the panel or the service.",
    },
    { phrase: "half the house is out", meaning: "A lost leg of power or a failed main breaker." },
  ],
  urgencySignals: [
    { signal: "Sparks, a burning smell, or a hot outlet or panel", level: "emergency" },
    { signal: "Someone got a shock", level: "emergency" },
    { signal: "Part of the home has no power", level: "urgent" },
    { signal: "A planned upgrade or installation", level: "routine" },
  ],
  qualificationQuestions: [
    { question: "What is happening, or what would you like installed?", why: "Job type." },
    { question: "Is there any burning smell, heat or sparking?", why: "Safety first." },
    { question: "What is the ZIP code?", why: "Service area." },
    { question: "Do you know the size or age of the panel?", why: "Scope of an upgrade." },
    { question: "How soon do you need it done?", why: "Scheduling." },
    { question: "Do you own the home?", why: "Who can approve the work." },
  ],
  objections: [
    {
      objection: "Can I just reset it myself?",
      response:
        "Resetting a breaker once is fine. If it trips again, leave it off: something is wrong and needs testing.",
    },
  ],
  seasonalPatterns: ["Storms bring outages and surge damage; summer loads trip old panels."],
  priceNorms: [],
  permitsAndRegulations: [
    "Panel upgrades and new circuits need a permit and an inspection in most places.",
  ],
  vocabulary: [
    { term: "Panel", definition: "The breaker box that distributes power in the home." },
    { term: "GFCI", definition: "An outlet that cuts power fast to prevent shocks near water." },
    { term: "Dedicated circuit", definition: "A circuit that serves a single appliance." },
  ],
  sources: [],
};

const REMODELING: PlaybookDocument = {
  commonJobs: [
    { name: "Kitchen remodel", scope: "Cabinets, counters, layout changes, appliances, lighting." },
    { name: "Bathroom remodel", scope: "Tub or shower, tile, vanity, plumbing fixtures." },
    {
      name: "Partial update",
      scope: "Counters, backsplash, a vanity or flooring without moving walls.",
    },
  ],
  customerLanguage: [
    {
      phrase: "we want to open it up",
      meaning: "Removing a wall: structural review and a permit.",
    },
    { phrase: "just a refresh", meaning: "Surfaces and fixtures; the layout stays." },
    {
      phrase: "tub to shower",
      meaning: "A common bath conversion with plumbing and waterproofing work.",
    },
  ],
  urgencySignals: [
    { signal: "Water damage or a failed shower forcing the project", level: "urgent" },
    { signal: "A deadline such as a sale, a baby or a holiday", level: "urgent" },
    { signal: "Collecting ideas for some time next year", level: "routine" },
  ],
  qualificationQuestions: [
    { question: "Which room, and what would you like to change?", why: "Scope." },
    {
      question: "Are you keeping the layout or moving things around?",
      why: "Size of the project.",
    },
    { question: "When would you like the work to start?", why: "Timeline." },
    { question: "What is the ZIP code?", why: "Service area." },
    { question: "Do you own the home?", why: "Who can approve the work." },
    {
      question: "Do you have a budget range in mind?",
      why: "Fit, once the customer raises money.",
    },
  ],
  objections: [
    {
      objection: "How much does a kitchen cost?",
      response:
        "It depends on size, layout and finishes; a design visit turns ideas into a real number.",
    },
    {
      objection: "How long will we be without a kitchen?",
      response: "The team gives a schedule with the proposal; do not guess a duration.",
    },
  ],
  seasonalPatterns: ["Demand peaks in spring and before the holidays; lead times grow then."],
  priceNorms: [],
  permitsAndRegulations: [
    "Moving plumbing, electrical or walls needs permits; condos and HOAs can add approvals.",
  ],
  vocabulary: [
    { term: "Rough-in", definition: "Plumbing and wiring installed before walls are closed." },
    { term: "Backsplash", definition: "The wall surface between the counter and the cabinets." },
    { term: "Vanity", definition: "The bathroom cabinet that holds the sink." },
  ],
  sources: [],
};

const BY_SLUG: Readonly<Record<string, PlaybookDocument>> = {
  roofing: ROOFING,
  hvac: HVAC,
  plumbing: PLUMBING,
  electrical: ELECTRICAL,
  remodeling: REMODELING,
};

const ALIASES: Readonly<Record<string, string>> = {
  roofers: "roofing",
  "heating-and-cooling": "hvac",
  "heating-cooling": "hvac",
  plumbers: "plumbing",
  electricians: "electrical",
  electrician: "electrical",
  "kitchen-and-bath": "remodeling",
  "kitchen-bath-remodeling": "remodeling",
  "kitchen-and-bath-remodeling": "remodeling",
  remodel: "remodeling",
};

/** The stand-in for a segment, by its slug; the general one when the trade is not covered. */
export function placeholderPlaybook(segmentSlug: string): {
  readonly slug: string;
  readonly document: PlaybookDocument;
} {
  const slug = segmentSlug.trim().toLowerCase().replaceAll("_", "-");
  const key = BY_SLUG[slug] !== undefined ? slug : ALIASES[slug];
  const document = key === undefined ? undefined : BY_SLUG[key];
  return document === undefined || key === undefined
    ? { slug: "general", document: GENERAL }
    : { slug: key, document };
}

export const PLACEHOLDER_PLAYBOOK_SLUGS: readonly string[] = Object.keys(BY_SLUG);
