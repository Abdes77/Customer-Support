import type { KnowledgeCategory } from "@repo/core";

/** The categories of business facts, in words. */
export const CATEGORY_LABELS: Readonly<Record<KnowledgeCategory, string>> = {
  services: "Services",
  service_area: "Service area",
  hours: "Hours",
  licenses: "Licenses and insurance",
  warranties: "Warranties",
  financing: "Financing",
  team: "Team",
  brands: "Brands",
  reviews: "Reviews",
  differentiators: "What sets them apart",
  pricing: "Pricing",
  policies: "Policies",
  faq: "Questions and answers",
  other: "Other",
};

/** Where a fact came from, in words. A web address is shown as its host. */
export function sourceText(source: string | null): string {
  switch (source) {
    case null:
      return "Unknown source";
    case "manual":
      return "Entered by hand";
    case "csv_import":
      return "CSV import";
    case "api":
      return "Import API";
    case "website":
      return "Website";
    default:
      try {
        return `Website: ${new URL(source).host}`;
      } catch {
        return source.slice(0, 60);
      }
  }
}
