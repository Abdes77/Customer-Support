import { redirect } from "next/navigation";

import { logger } from "@repo/core";

import { getSessionUser } from "@/server/auth";
import { listDemoBusinesses } from "@/server/demo/site";

export const dynamic = "force-dynamic";

/**
 * The front door. Someone who is signed in goes to the admin panel's business list. A visitor
 * who is not lands on the public demo site when a business is listed there, and otherwise on
 * the sign-in page (through the business list, which asks for it).
 */
export default async function HomePage() {
  if ((await getSessionUser()) === null) {
    let listed = 0;
    try {
      listed = (await listDemoBusinesses()).length;
    } catch (error) {
      // The front door still opens when the listing cannot be read.
      logger.error("demo.listing_failed", { error });
    }
    if (listed > 0) redirect("/demo");
  }
  redirect("/businesses");
}
