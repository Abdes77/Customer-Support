import type { Metadata } from "next";

import { ModelNotice } from "@/components/demo/model-notice";
import { type DemoListing, demoPrompts, listDemoBusinesses } from "@/server/demo/site";

/*
 * The public demo site's front page: what the assistant does, and one card per sample
 * business to try it on. Public: no sign-in. It lists only businesses whose "Public demo
 * page" setting is on; `pnpm demo:setup` stores a set of sample ones.
 */

export const metadata: Metadata = {
  title: "AI assistant demo",
  description:
    "Chat with an AI assistant that answers customers of home-services businesses, qualifies them and writes up the lead.",
};
export const dynamic = "force-dynamic";

const POINTS: readonly (readonly [string, string])[] = [
  [
    "It knows the business",
    "Services, service area, hours, warranties, financing: the assistant answers from what the business has told it, and says so when it does not know instead of guessing.",
  ],
  [
    "It qualifies while it helps",
    "One or two natural questions at a time: what the job is, where, how soon, who decides. Every answer is scored against what that business counts as a good lead.",
  ],
  [
    "It follows the owner's rules",
    "No prices unless the owner allows them. Emergencies get safety steps first and reach a person. Hot leads get booked, the rest get a call back, and every one comes with a written report.",
  ],
];

function place(listing: DemoListing): string {
  return [listing.city, listing.state].filter((part) => part !== null).join(", ");
}

function Card({ listing }: { readonly listing: DemoListing }) {
  const sample = demoPrompts(listing.segmentSlug)[0];
  return (
    <li>
      {/* A full page load on purpose: the chat script belongs to one business per page. */}
      <a
        href={`/demo/${listing.slug}`}
        className="group flex h-full flex-col rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 transition hover:shadow-lg hover:ring-slate-300 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none"
        data-testid="demo-card"
      >
        <p className="text-xs font-semibold tracking-wider text-emerald-700 uppercase">
          {listing.segmentName ?? "Home services"}
        </p>
        <h3 className="mt-2 text-xl font-bold tracking-tight text-slate-900">{listing.name}</h3>
        <p className="text-sm text-slate-500">{place(listing)}</p>
        {sample === undefined ? null : (
          <p className="mt-4 flex-1 text-sm leading-6 text-slate-600">
            Try: <span className="text-slate-900 italic">“{sample}”</span>
          </p>
        )}
        <p className="mt-5 text-sm font-semibold text-slate-900">
          Open the demo{" "}
          <span aria-hidden className="inline-block transition-transform group-hover:translate-x-1">
            →
          </span>
        </p>
      </a>
    </li>
  );
}

export default async function DemoHomeRoute() {
  const listings = await listDemoBusinesses();
  const agency = listings[0]?.agencyName ?? null;

  return (
    <div className="min-h-screen bg-stone-100 text-slate-900">
      <ModelNotice />
      <header className="bg-slate-950 text-white">
        <div className="mx-auto max-w-6xl px-4 pt-6 pb-16 sm:px-6 sm:pb-20">
          <p className="text-sm font-semibold text-slate-300">
            {agency ?? "AI assistant"}
            <span className="ml-2 rounded-full bg-emerald-400/15 px-2 py-0.5 text-xs font-semibold text-emerald-300">
              Live demo
            </span>
          </p>
          <h1 className="mt-12 max-w-3xl text-4xl font-bold tracking-tight text-balance sm:text-5xl">
            Every customer message answered in under a minute. Every lead scored before you call
            back.
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-300">
            This is an AI assistant for home-services businesses. It replies the way someone in your
            office would, finds out what your crew needs to know, and hands you a written report.
            Pick a trade below and talk to it like a customer.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 sm:px-6">
        {listings.length === 0 ? (
          <div
            className="-mt-8 rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200"
            data-testid="demo-empty"
          >
            <h2 className="text-lg font-bold">The demo is not set up yet</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              No business is listed here. Store the sample businesses with{" "}
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">pnpm demo:setup</code>,
              or switch on “Public demo page” in the settings of a business that has its website
              chat connected.
            </p>
          </div>
        ) : (
          <ul className="-mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {listings.map((listing) => (
              <Card key={listing.businessId} listing={listing} />
            ))}
          </ul>
        )}

        <section className="py-16">
          <h2 className="text-2xl font-bold tracking-tight">What to look for</h2>
          <div className="mt-6 grid gap-8 md:grid-cols-3">
            {POINTS.map(([title, text]) => (
              <div key={title}>
                <h3 className="font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{text}</p>
              </div>
            ))}
          </div>
          <p className="mt-10 max-w-3xl text-sm leading-6 text-slate-600">
            Next to each chat, a panel shows what the business would see in its inbox: the score,
            the answers with the customer&apos;s own words, the next step and the report. Try being
            a great lead, then a price shopper, then someone with a real emergency.
          </p>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <p className="mx-auto max-w-6xl px-4 py-6 text-xs leading-5 text-slate-500 sm:px-6">
          The businesses on this page are samples made for the demo, not real companies. What you
          write in a chat is stored as a demo conversation: please do not enter real personal
          details.
        </p>
      </footer>
    </div>
  );
}
