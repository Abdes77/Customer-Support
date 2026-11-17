import type { KnowledgeCategory } from "@repo/core";
import { businesses, type DemoBusinessRef, eq, getDatabase } from "@repo/db";
import { listKnowledgeItems } from "@repo/knowledge";
import { loadSettings } from "@repo/settings/server";

/*
 * What the public demo site (`/demo`) shows. It lists only businesses that switched their
 * "Public demo page" setting on (`channels.widget.demo_page`), and of those only what a
 * business puts on its own website anyway: its name, place, phone and the facts in its
 * knowledge. Nothing about customers, leads or settings beyond the chat's look is read here;
 * the lead panel gets its data from the chat's own session (`/api/widget/v1/demo/lead`).
 */

export type DemoListing = DemoBusinessRef;

export interface DemoFact {
  readonly title: string;
  readonly content: string;
}

export interface DemoBusinessPage {
  readonly listing: DemoListing;
  readonly phone: string | null;
  readonly botName: string;
  /** The chat's color, used as the page's accent. */
  readonly color: string;
  readonly facts: Readonly<Partial<Record<KnowledgeCategory, readonly DemoFact[]>>>;
  /** Lines a visitor can send with one click. */
  readonly prompts: readonly string[];
}

const PROMPTS: Readonly<Record<string, readonly string[]>> = {
  roofing: [
    "Water is dripping through my bedroom ceiling",
    "We had hail last week. Can someone check the roof?",
    "How much does a new roof cost?",
  ],
  hvac: [
    "My furnace quit and the house is getting cold",
    "The AC runs but blows warm air",
    "Our furnace is 20 years old. Replace or repair?",
  ],
  plumbing: [
    "My water heater is leaking in the garage",
    "The kitchen sink won't drain",
    "I think I smell gas near the water heater",
  ],
  electrical: [
    "Half the outlets in my kitchen stopped working",
    "I need an EV charger in my garage",
    "There's a burning smell coming from the breaker panel",
  ],
  remodeling: [
    "We want to redo our kitchen this spring",
    "Can you turn our tub into a walk-in shower?",
    "What does a bathroom remodel cost?",
  ],
  general: [
    "I need help with a problem at my house",
    "Do you work in my area?",
    "How much do you charge?",
  ],
};

/** The trade's sample questions; a trade the list does not know gets the general ones. */
export function demoPrompts(segmentSlug: string | null): readonly string[] {
  const slug = segmentSlug ?? "";
  for (const [trade, prompts] of Object.entries(PROMPTS)) {
    if (trade !== "general" && slug.includes(trade)) return prompts;
  }
  if (/heat|cool|air/.test(slug)) return PROMPTS["hvac"]!;
  if (/kitchen|bath|remodel/.test(slug)) return PROMPTS["remodeling"]!;
  if (/electric/.test(slug)) return PROMPTS["electrical"]!;
  if (/plumb/.test(slug)) return PROMPTS["plumbing"]!;
  if (/roof/.test(slug)) return PROMPTS["roofing"]!;
  return PROMPTS["general"]!;
}

/** The businesses on the demo site, oldest first. */
export async function listDemoBusinesses(): Promise<DemoListing[]> {
  return getDatabase().directory.listDemoBusinesses();
}

/** One business's demo page, or null when no listed business has this address. */
export async function loadDemoBusiness(slug: string): Promise<DemoBusinessPage | null> {
  const db = getDatabase();
  const listing = (await db.directory.listDemoBusinesses()).find((entry) => entry.slug === slug);
  if (listing === undefined) return null;
  return db.forBusiness(listing.businessId, { agencyId: listing.agencyId }).run(async (ctx) => {
    const [row] = await ctx.tx
      .select({ phone: businesses.phone })
      .from(businesses)
      .where(eq(businesses.id, listing.businessId))
      .limit(1);
    const { values } = await loadSettings(ctx, ctx.tenant);
    const facts: Partial<Record<KnowledgeCategory, DemoFact[]>> = {};
    for (const item of await listKnowledgeItems(ctx, listing.businessId)) {
      (facts[item.category] ??= []).push({ title: item.title, content: item.content });
    }
    return {
      listing,
      phone: row?.phone ?? null,
      botName: values["persona.bot_name"],
      color: values["channels.widget.primary_color"],
      facts,
      prompts: demoPrompts(listing.segmentSlug),
    };
  });
}
