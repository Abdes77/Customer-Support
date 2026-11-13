import type { ModelContentBlock, ModelResponse } from "@repo/ai";
import { scriptedResponse, type ScriptedStep, toolUse } from "@repo/ai/testing";
import type { PlaybookDocument, PlaybookSource } from "@repo/core";

/**
 * Playbook generation without the Claude API: two complete playbooks and the model responses
 * that lead to them, in the API's own response format (search calls, search results,
 * cited notes, the `submit_playbook` call). Tests of this package and of later chunks (the
 * onboarding wizard, the evaluation harness) play them through the scripted model client.
 *
 * Everything here is written by hand for tests: the pages, their addresses (reserved
 * `.example` names) and the figures are not research. The live run that replaces them is in
 * docs/HUMAN_TODO.md.
 */

export const ROOFING_SOURCES: readonly PlaybookSource[] = [
  {
    title: "Residential roofing: common repairs and replacement",
    url: "https://roofing-contractors-association.example/homeowners/repairs-and-replacement",
  },
  {
    title: "What a new roof costs: regional price guide",
    url: "https://home-cost-guide.example/roofing/replacement-cost-by-region",
  },
  {
    title: "Storm damage, insurance claims and your roof",
    url: "https://insurance-information.example/homeowners/roof-claims",
  },
  {
    title: "Re-roofing permits and inspections",
    url: "https://building-codes.example/residential/re-roofing-permits",
  },
];

export const ROOFING_PLAYBOOK: PlaybookDocument = {
  commonJobs: [
    {
      name: "Leak repair",
      scope:
        "Finding where water gets in and fixing it: damaged shingles, failed flashing around chimneys, vents and skylights, worn pipe boots. Size depends on how far the water has travelled and whether the decking is wet.",
    },
    {
      name: "Full roof replacement",
      scope:
        "Tearing off the old roof down to the decking, replacing damaged wood, and installing underlayment, flashing and new roofing. Size depends on the area of the roof, its pitch, the number of layers to remove and the material.",
    },
    {
      name: "Storm damage inspection and repair",
      scope:
        "Inspecting after hail or high wind, documenting the damage with photos, temporary protection where the roof is open, then repair or replacement, often alongside an insurance claim.",
    },
    {
      name: "Gutter, fascia and soffit work",
      scope:
        "Repairing or replacing gutters and downspouts and the boards they hang on. Often added to a roof job, sometimes a job of its own.",
    },
    {
      name: "Roof inspection and maintenance",
      scope:
        "A check of shingles, flashing, vents and attic ventilation before a sale, after a storm or as yearly upkeep, with small fixes made on the spot.",
    },
  ],
  customerLanguage: [
    {
      phrase: "there's a water stain on my ceiling",
      meaning:
        "A leak that has been active for a while; the entry point is often uphill from the stain. Ask whether it is dripping now and which room it is in.",
    },
    {
      phrase: "shingles are in my yard",
      meaning:
        "Wind damage; the underlayment or decking may be exposed. Ask when it happened and whether rain is expected.",
    },
    {
      phrase: "my gutters are full of little black rocks",
      meaning:
        "Granule loss: the shingles are near the end of their life. Usually a replacement conversation, not a repair.",
    },
    {
      phrase: "the roof is sagging",
      meaning:
        "Possible structural damage to the decking or framing. Treat as urgent and ask whether anyone is in the rooms below.",
    },
    {
      phrase: "the insurance adjuster is coming out",
      meaning:
        "A claim is open. The customer wants a contractor present or a written scope; ask for the date of the visit.",
    },
  ],
  urgencySignals: [
    { signal: "Water is coming into the house right now", level: "emergency" },
    { signal: "A tree or a large limb is on the roof", level: "emergency" },
    { signal: "Part of the roof is open or tarped and rain is forecast", level: "urgent" },
    { signal: "A leak that only shows in heavy rain", level: "urgent" },
    { signal: "Planning a replacement in the coming months", level: "routine" },
    { signal: "An inspection before selling or buying a home", level: "routine" },
  ],
  qualificationQuestions: [
    {
      question: "What is going on with the roof?",
      why: "Separates a repair from a replacement from an inspection.",
    },
    {
      question: "Is water getting inside at the moment?",
      why: "Decides how fast someone has to come out.",
    },
    { question: "What is the address or ZIP code of the property?", why: "Service area." },
    {
      question: "Roughly how old is the roof, and what is it made of?",
      why: "A roof near the end of its life is replaced, not patched; the material decides the crew.",
    },
    { question: "Do you own the home?", why: "Only the owner can approve roof work." },
    {
      question: "Is an insurance claim involved, and has an adjuster been out?",
      why: "Changes the process, the paperwork and the timeline.",
    },
  ],
  objections: [
    {
      objection: "Can't you just patch it?",
      response:
        "Often a repair is all it needs. The team looks at the whole roof first and says honestly whether a repair will hold, so you are not paying twice.",
    },
    {
      objection: "I'm getting a few other quotes.",
      response:
        "That is sensible for a job this size. A written scope from an inspection makes the quotes comparable line by line.",
    },
    {
      objection: "My insurance should pay for this.",
      response:
        "The team can document the damage and meet the adjuster. What the policy covers is the insurer's decision, so nobody should promise you a covered roof before they have ruled.",
    },
    {
      objection: "I want to wait until spring.",
      response:
        "Waiting is fine for a roof that is not leaking. If water is getting in, a temporary repair now protects the decking and the ceiling until the full job.",
    },
  ],
  seasonalPatterns: [
    "Hail and wind season in spring and early summer brings a rush of inspections and claims; lead times grow for weeks after a large storm.",
    "Late summer and autumn are the busiest months for planned replacements, before cold weather.",
    "In freezing weather asphalt shingles do not seal well, so replacements slow down and emergency repairs dominate.",
  ],
  priceNorms: [
    {
      job: "Leak repair",
      lowUsd: 400,
      highUsd: 1900,
      unit: "per repair",
      region: "US national",
      notes:
        "Depends on access, flashing work and whether decking has to be replaced. 2026 figures.",
    },
    {
      job: "Asphalt shingle roof replacement",
      lowUsd: 9500,
      highUsd: 24_000,
      unit: "per roof",
      region: "Mountain West",
      notes:
        "Typical single-family home; steep roofs, extra layers to remove and impact-rated shingles are at the upper end. 2026 figures.",
    },
    {
      job: "Standing-seam metal roof replacement",
      lowUsd: 24_000,
      highUsd: 55_000,
      unit: "per roof",
      region: "US national",
      notes: "Material gauge and roof complexity move the price most.",
    },
  ],
  permitsAndRegulations: [
    "Most cities and counties require a building permit for a full re-roof and inspect the finished work; the contractor normally pulls the permit.",
    "Many jurisdictions limit how many layers of roofing may stay on a house, so a second layer usually has to come off.",
    "Roofing contractors are licensed or registered in many states, and the rules differ from state to state.",
  ],
  vocabulary: [
    { term: "Square", definition: "100 square feet of roof; roofs are measured and priced by it." },
    {
      term: "Flashing",
      definition: "Metal that seals the joints around chimneys, vents, skylights and walls.",
    },
    {
      term: "Decking",
      definition: "The wood surface under the roofing that everything is nailed to.",
    },
    {
      term: "Underlayment",
      definition: "The water-resistant layer between the decking and the shingles.",
    },
    { term: "Pitch", definition: "How steep the roof is." },
    {
      term: "Tear-off",
      definition: "Removing the old roofing before the new roof goes on.",
    },
  ],
  sources: [...ROOFING_SOURCES],
};

export const PEST_CONTROL_SOURCES: readonly PlaybookSource[] = [
  {
    title: "Common household pests and how professionals treat them",
    url: "https://pest-management-association.example/homeowners/common-pests",
  },
  {
    title: "Pest control prices: one-time visits and service plans",
    url: "https://home-cost-guide.example/pest-control/prices",
  },
  {
    title: "Pesticide applicator licensing and safety rules",
    url: "https://environmental-agency.example/pesticides/applicator-certification",
  },
  {
    title: "Termites: signs of activity and treatment options",
    url: "https://university-extension.example/entomology/termites",
  },
];

export const PEST_CONTROL_PLAYBOOK: PlaybookDocument = {
  commonJobs: [
    {
      name: "General pest treatment",
      scope:
        "Treating a home for ants, roaches, spiders and similar pests, inside and around the foundation. Size depends on the size of the home and how established the problem is.",
    },
    {
      name: "Rodent control",
      scope:
        "Inspecting for mice or rats, trapping, and sealing the gaps they use to get in. Usually takes several visits.",
    },
    {
      name: "Termite inspection and treatment",
      scope:
        "Inspecting the structure for termites and damage, then a liquid barrier, bait stations or, for some species, fumigation. The species and the construction of the home decide the method.",
    },
    {
      name: "Bed bug treatment",
      scope:
        "Confirming the infestation, then heat or chemical treatment of the affected rooms, with a follow-up visit. Preparation by the resident is part of the job.",
    },
    {
      name: "Stinging insect and wildlife removal",
      scope:
        "Removing wasp or hornet nests, bee swarms, or animals such as squirrels and raccoons from attics and crawl spaces, and closing the entry points.",
    },
    {
      name: "Recurring service plan",
      scope:
        "Scheduled visits through the year that keep common pests out, with free return visits between them in most plans.",
    },
  ],
  customerLanguage: [
    {
      phrase: "I keep finding droppings in the kitchen",
      meaning:
        "Rodents or large roaches. Ask what the droppings look like and whether there is scratching in the walls at night.",
    },
    {
      phrase: "we're getting bitten at night",
      meaning:
        "Possibly bed bugs, sometimes fleas. Ask which rooms and whether they have seen the insects.",
    },
    {
      phrase: "there are flying ants coming out of the wall",
      meaning:
        "May be termite swarmers. Ask whether the wings are all the same length and whether there are wings on the window sills.",
    },
    {
      phrase: "I hear something in the attic",
      meaning: "Rodents or wildlife. Ask what time of day and how heavy it sounds.",
    },
    {
      phrase: "the store-bought spray isn't working",
      meaning:
        "An established problem that has outlasted home treatment; the customer is ready for a professional.",
    },
  ],
  urgencySignals: [
    {
      signal:
        "A wasp or hornet nest where people come and go, and someone in the home is allergic to stings",
      level: "emergency",
    },
    { signal: "A wild animal is inside the living space", level: "emergency" },
    { signal: "Bed bugs, or rodents seen in the kitchen", level: "urgent" },
    { signal: "Termite swarmers or damaged wood found", level: "urgent" },
    { signal: "Ants or spiders that keep coming back", level: "routine" },
    { signal: "Wants a preventive plan or an inspection for a home sale", level: "routine" },
  ],
  qualificationQuestions: [
    {
      question: "What are you seeing, and where in the home?",
      why: "Identifies the pest and how far it has spread.",
    },
    {
      question: "How long has it been going on?",
      why: "A new sighting and an established infestation are different jobs.",
    },
    { question: "What is the ZIP code of the property?", why: "Service area." },
    {
      question: "Is it a house, an apartment or a business?",
      why: "Decides the treatment, and in rentals who has to approve it.",
    },
    {
      question: "Are there children, pets or anyone with health sensitivities in the home?",
      why: "Decides which products and precautions the technician plans for.",
    },
    {
      question: "Do you own the home, or do you rent?",
      why: "In a rental the landlord is often responsible and has to agree.",
    },
  ],
  objections: [
    {
      objection: "Are the chemicals safe for my kids and pets?",
      response:
        "It is the right thing to ask. The technician uses products approved for homes, tells you where they were applied and how long to keep children and pets away, and can plan around sensitivities you mention.",
    },
    {
      objection: "I don't want to be locked into a contract.",
      response:
        "Many problems can be handled with a one-time treatment. The team explains what a plan adds, and you choose after the first visit.",
    },
    {
      objection: "Can't I just do this myself?",
      response:
        "For a few ants, often yes. For rodents, termites or bed bugs, home treatments usually push the problem around instead of ending it, which costs more time in the end.",
    },
    {
      objection: "Do you guarantee they won't come back?",
      response:
        "No honest company can promise that no pest ever returns. The team explains what its service includes if they do come back, and puts that in writing.",
    },
  ],
  seasonalPatterns: [
    "Ants, wasps and mosquitoes peak from spring through late summer.",
    "Rodents move indoors when the weather turns cold in autumn, and calls rise with the first cold nights.",
    "Termite swarms appear in spring in most of the country, often after rain.",
  ],
  priceNorms: [
    {
      job: "One-time general pest treatment",
      lowUsd: 150,
      highUsd: 400,
      unit: "per visit",
      region: "US national",
      notes: "Depends on the size of the home and the pest. 2026 figures.",
    },
    {
      job: "Recurring service plan",
      lowUsd: 40,
      highUsd: 75,
      unit: "per month",
      region: "US national",
      notes:
        "Quarterly or every-other-month visits billed monthly; an initial visit often costs more.",
    },
    {
      job: "Termite treatment",
      lowUsd: 600,
      highUsd: 3000,
      unit: "per home",
      region: "Southeast",
      notes: "Liquid barrier or bait system for a typical house; fumigation costs more.",
    },
  ],
  permitsAndRegulations: [
    "Companies and technicians who apply pesticides for hire are licensed or certified by their state, and the requirements differ from state to state.",
    "Many home sales and some loans call for a wood-destroying insect inspection report; the form and who may sign it are set by the state.",
    "Bees and some wildlife are protected in places, which can require relocation instead of extermination.",
  ],
  vocabulary: [
    {
      term: "Integrated pest management",
      definition:
        "Solving a pest problem with inspection, sealing and cleaning first, and pesticides only where needed.",
    },
    { term: "Exclusion", definition: "Sealing the gaps pests use to get into a building." },
    {
      term: "Bait station",
      definition: "A tamper-resistant box that holds bait for rodents or termites.",
    },
    {
      term: "Swarmers",
      definition: "Winged termites or ants that leave a colony to start new ones.",
    },
    {
      term: "Re-entry time",
      definition: "How long people and pets stay out of a treated area.",
    },
    { term: "Harborage", definition: "A place where pests hide and breed." },
  ],
  sources: [...PEST_CONTROL_SOURCES],
};

let counter = 0;
const nextId = (prefix: string) => {
  counter += 1;
  return `${prefix}_fixture_${String(counter).padStart(4, "0")}`;
};

function block(value: Record<string, unknown>): ModelContentBlock {
  return value as unknown as ModelContentBlock;
}

/** A search the model ran and what it returned, as two content blocks. */
export function searchBlocks(
  query: string,
  results: readonly PlaybookSource[],
): ModelContentBlock[] {
  const id = nextId("srvtoolu");
  return [
    block({ type: "server_tool_use", id, name: "web_search", input: { query } }),
    block({
      type: "web_search_tool_result",
      tool_use_id: id,
      content: results.map((result) => ({
        type: "web_search_result",
        url: result.url,
        title: result.title,
        encrypted_content: `encrypted:${result.url}`,
        page_age: "October 2, 2026",
      })),
    }),
  ];
}

/** A search that came back as an error (HTTP 200 with an error object, as the API does). */
export function failedSearchBlocks(query: string, errorCode: string): ModelContentBlock[] {
  const id = nextId("srvtoolu");
  return [
    block({ type: "server_tool_use", id, name: "web_search", input: { query } }),
    block({
      type: "web_search_tool_result",
      tool_use_id: id,
      content: { type: "web_search_tool_result_error", error_code: errorCode },
    }),
  ];
}

/** A sentence of the model's notes with a citation of one search result. */
export function citedNote(note: string, source: PlaybookSource): ModelContentBlock {
  return block({
    type: "text",
    text: note,
    citations: [
      {
        type: "web_search_result_location",
        url: source.url,
        title: source.title,
        encrypted_index: `index:${source.url}`,
        cited_text: note.slice(0, 150),
      },
    ],
  });
}

/** The three research steps of a run: every source is returned by a search and cited once. */
export function researchResponses(
  trade: string,
  sources: readonly PlaybookSource[],
): ModelResponse[] {
  const topics = [
    "common jobs and customer language",
    "urgency and qualifying",
    "prices, seasons and permits",
  ];
  return topics.map((topic, index) => {
    // Spread the pages over the steps; the last step gets what is left.
    const share = sources.filter((_, position) => position % topics.length === index);
    const found = share.length > 0 ? share : sources.slice(0, 1);
    return scriptedResponse(
      [
        ...searchBlocks(`${trade} ${topic}`, found),
        ...found.map((source) => citedNote(`Notes on ${topic}: see ${source.title}.`, source)),
      ],
      { usage: { inputTokens: 9000 + index * 4000, outputTokens: 700 } },
    );
  });
}

/** The model's call of `submit_playbook`. */
export function submitResponse(document: unknown): ModelResponse {
  return scriptedResponse([toolUse("submit_playbook", document)], {
    usage: { inputTokens: 21_000, outputTokens: 5200 },
  });
}

/** A whole successful generation: three research steps, then the document. */
export function scriptedPlaybookRun(
  trade: string,
  document: PlaybookDocument,
  sources: readonly PlaybookSource[] = document.sources,
): ScriptedStep[] {
  return [...researchResponses(trade, sources), submitResponse(document)];
}
