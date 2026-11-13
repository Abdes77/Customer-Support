import { defineCategory, setting } from "../define";
import { f } from "../fields";

export const PRICING_DISCLOSURE_MODES = ["never", "ranges", "exact"] as const;

/**
 * Whether and how the bot talks about prices. Consumed by the engine (C4). Whatever is
 * chosen here, the bot never invents a price: it quotes only what the business's knowledge
 * (or, when allowed, the segment playbook) contains.
 */
export const pricingSettings = defineCategory("pricing", {
  "pricing.disclosure": setting({
    label: "Price disclosure",
    help: "How much the bot may say about prices.",
    field: f.select([
      [
        "never",
        "Never",
        "The bot gives no numbers. It explains that the team quotes after seeing the job.",
      ],
      [
        "ranges",
        "Ranges",
        "The bot may give price ranges that are in the business's knowledge, as estimates.",
      ],
      [
        "exact",
        "Exact prices",
        "The bot may quote the listed prices from the business's knowledge, and ranges where no exact price exists.",
      ],
    ]),
    default: "never",
  }),
  "pricing.use_playbook_ranges": setting({
    label: "Use industry price ranges",
    help: "When the business's own knowledge has no price for a job, the bot may give the typical regional range from the segment playbook, clearly as a general figure. Applies only when disclosure is set to ranges or exact.",
    field: f.boolean(),
    default: false,
  }),
  "pricing.deflection_guidance": setting({
    label: "Answer when prices are not disclosed",
    help: "How the bot answers a price question it may not answer with numbers. Guidance, not a script.",
    field: f.text({ multiline: true, minLength: 1, maxLength: 600 }),
    default:
      "Say that the price depends on the details of the job and that the team gives an exact quote once they have seen it. Then ask the next question that gets the customer closer to that quote.",
  }),
  "pricing.disclaimer": setting({
    label: "Disclaimer with every price",
    help: "Added, in the bot's own words, whenever it mentions a number.",
    field: f.text({ minLength: 1, maxLength: 300 }),
    default: "The final price is confirmed after the team has looked at the job.",
  }),
  "pricing.estimate_policy": setting({
    label: "Estimates",
    help: "What the bot says about the cost of an estimate or a site visit.",
    field: f.select([
      ["not_stated", "Say nothing unless the knowledge covers it"],
      ["free", "Estimates are free"],
      ["paid", "Estimates cost the fee below"],
      ["credited", "The fee below is credited toward the job"],
    ]),
    default: "not_stated",
    clientEditable: true,
  }),
  "pricing.estimate_fee_usd": setting({
    label: "Estimate fee",
    help: "The fee for an estimate or site visit, when estimates are paid or credited.",
    field: f.nullable(f.number({ min: 0, max: 10_000, step: 5, unit: "USD" }), "Not set"),
    default: null,
    clientEditable: true,
  }),
  "pricing.service_call_fee_usd": setting({
    label: "Service-call fee",
    help: "The diagnostic or trip fee. The bot mentions it when a customer asks what a visit costs, unless disclosure is set to never.",
    field: f.nullable(f.number({ min: 0, max: 10_000, step: 5, unit: "USD" }), "Not set"),
    default: null,
    clientEditable: true,
  }),
  "pricing.promotions": setting({
    label: "Current offers",
    help: "Offers the bot may mention when price comes up. It never makes up a discount and never mentions an offer after its end date.",
    field: f.list(
      f.object({
        title: { label: "Offer", field: f.text({ minLength: 1, maxLength: 120 }) },
        details: {
          label: "Conditions",
          field: f.text({ multiline: true, maxLength: 400 }),
        },
        ends_on: {
          label: "Ends on",
          field: f.nullable(f.text({ format: "date", minLength: 10 }), "No end date"),
        },
      }),
      { itemLabel: "offer", maxItems: 10, unique: "title" },
    ),
    default: [],
    clientEditable: true,
  }),
  "pricing.negotiation": setting({
    label: "Requests for a discount",
    help: "What the bot does when a customer asks for a better price or a price match. It never agrees to a price on its own.",
    field: f.select([
      ["refer_to_team", "Say the team will discuss it", "The request is noted in the lead report."],
      ["decline", "Say prices are not negotiable"],
    ]),
    default: "refer_to_team",
  }),
});
