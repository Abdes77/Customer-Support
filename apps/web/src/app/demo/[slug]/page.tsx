import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache, type CSSProperties } from "react";

import type { KnowledgeCategory } from "@repo/core";

import { OpenChatButton, PromptChips } from "@/components/demo/chat-actions";
import { ChatSnippet } from "@/components/demo/chat-snippet";
import { LeadPanel } from "@/components/demo/lead-panel";
import { type DemoBusinessPage, type DemoFact, loadDemoBusiness } from "@/server/demo/site";

/*
 * One business's page on the public demo site: its "website", drawn from its own profile and
 * knowledge, with its real chat embedded the way a business embeds it, and a panel that shows
 * the lead the assistant builds from the visitor's conversation. Public: no sign-in. Only a
 * business whose "Public demo page" setting is on has such a page.
 */

export const dynamic = "force-dynamic";

const load = cache(loadDemoBusiness);

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const page = await load((await params).slug);
  return { title: page === null ? "Demo" : `${page.listing.name}: assistant demo` };
}

const HEADLINES: readonly (readonly [RegExp, string])[] = [
  [/roof/, "Roof repair and replacement you can count on."],
  [/hvac|heat|cool|air/, "Heating and cooling, fixed right the first time."],
  [/plumb/, "Plumbing problems solved, start to finish."],
  [/electric/, "Safe, clean electrical work for your home."],
  [/kitchen|bath|remodel/, "Kitchens and baths, designed and built by one team."],
];

function headline(segmentSlug: string | null): string {
  const slug = segmentSlug ?? "";
  return HEADLINES.find(([pattern]) => pattern.test(slug))?.[1] ?? "Local help for your home.";
}

const DETAIL_SECTIONS: readonly (readonly [KnowledgeCategory, string])[] = [
  ["licenses", "Licensed and insured"],
  ["warranties", "Warranty"],
  ["financing", "Financing"],
  ["pricing", "Estimates and pricing"],
  ["policies", "How we work"],
  ["brands", "Brands"],
];

function place(page: DemoBusinessPage): string | null {
  const { city, state } = page.listing;
  if (city === null) return state;
  return state === null ? city : `${city}, ${state}`;
}

function FactText({ facts }: { readonly facts: readonly DemoFact[] }) {
  return (
    <>
      {facts.map((fact, index) => (
        <p key={index} className="text-sm leading-6 text-slate-600">
          {fact.content}
        </p>
      ))}
    </>
  );
}

function Site({ page }: { readonly page: DemoBusinessPage }) {
  const { listing, facts, botName } = page;
  const where = place(page);
  const services = facts.services ?? [];
  const reviews = facts.reviews ?? [];
  const about = [...(facts.differentiators ?? []), ...(facts.team ?? [])];
  const details = DETAIL_SECTIONS.filter(([category]) => (facts[category]?.length ?? 0) > 0);
  const address = `www.${listing.slug.replaceAll(/[^a-z0-9]/g, "")}.example`;

  return (
    <div className="overflow-hidden rounded-2xl bg-white shadow-xl ring-1 ring-slate-200">
      {/* A browser window around the sample website. */}
      <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-100 px-4 py-2.5">
        <div className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-slate-300" />
          <span className="size-2.5 rounded-full bg-slate-300" />
          <span className="size-2.5 rounded-full bg-slate-300" />
        </div>
        <div className="min-w-0 flex-1 truncate rounded-md bg-white px-3 py-1 text-xs text-slate-500 ring-1 ring-slate-200">
          {address}
        </div>
      </div>

      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-4 sm:px-10">
        <p className="text-lg font-bold tracking-tight text-slate-900">
          <span
            aria-hidden
            className="mr-2 inline-block size-3 rounded-sm bg-[var(--accent)] align-baseline"
          />
          {listing.name}
        </p>
        {page.phone === null ? null : (
          <p className="text-sm font-semibold text-slate-700">{page.phone}</p>
        )}
      </header>

      <section className="border-y border-slate-100 bg-gradient-to-b from-slate-50 to-white px-6 py-12 sm:px-10 sm:py-16">
        <p className="text-sm font-semibold tracking-wide text-[var(--accent)] uppercase">
          {[listing.segmentName, where].filter((part) => part !== null).join(" · ")}
        </p>
        {/* Narrow enough to stay clear of the open chat in the corner on a laptop screen. */}
        <h1 className="mt-3 max-w-md text-3xl font-bold tracking-tight text-balance text-slate-900 sm:text-4xl 2xl:max-w-xl">
          {headline(listing.segmentSlug)}
        </h1>
        <p className="mt-4 max-w-md text-base leading-7 text-slate-600 2xl:max-w-xl">
          {where === null ? "Tell" : `Serving ${listing.city ?? where} and nearby. Tell`} {botName},
          our assistant, what is going on. It answers right away, day or night.
        </p>
        <div className="mt-6">
          <OpenChatButton
            className="inline-flex h-11 items-center rounded-lg bg-[var(--accent)] px-5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 focus-visible:outline-none"
            data-testid="demo-open-chat"
          >
            Chat with {botName}
          </OpenChatButton>
        </div>
        <div className="mt-8 max-w-md 2xl:max-w-xl">
          <p className="mb-2 text-xs font-semibold tracking-wider text-slate-500 uppercase">
            Or try one of these
          </p>
          <PromptChips prompts={page.prompts} />
        </div>
      </section>

      {services.length === 0 ? null : (
        <section className="px-6 py-10 sm:px-10">
          <h2 className="text-xl font-bold tracking-tight text-slate-900">What we do</h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {services.map((service, index) => (
              <div key={index} className="rounded-xl border border-slate-200 p-4">
                {service.title === "" ? null : (
                  <h3 className="font-semibold text-slate-900">{service.title}</h3>
                )}
                <p className="mt-1 text-sm leading-6 text-slate-600">{service.content}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {(facts.service_area ?? []).length + (facts.hours ?? []).length === 0 ? null : (
        <section className="grid gap-8 bg-slate-50 px-6 py-10 sm:grid-cols-2 sm:px-10">
          {(facts.service_area ?? []).length === 0 ? null : (
            <div>
              <h2 className="text-base font-bold text-slate-900">Service area</h2>
              <div className="mt-2 space-y-2">
                <FactText facts={facts.service_area ?? []} />
              </div>
            </div>
          )}
          {(facts.hours ?? []).length === 0 ? null : (
            <div>
              <h2 className="text-base font-bold text-slate-900">Hours</h2>
              <div className="mt-2 space-y-2">
                <FactText facts={facts.hours ?? []} />
              </div>
            </div>
          )}
        </section>
      )}

      {details.length === 0 ? null : (
        <section className="px-6 py-10 sm:px-10">
          <h2 className="text-xl font-bold tracking-tight text-slate-900">Good to know</h2>
          <dl className="mt-5 grid gap-x-8 gap-y-6 sm:grid-cols-2">
            {details.map(([category, title]) => (
              <div key={category}>
                <dt className="font-semibold text-slate-900">{title}</dt>
                <dd className="mt-1 space-y-2">
                  <FactText facts={facts[category] ?? []} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {about.length + reviews.length === 0 ? null : (
        <section className="grid gap-8 bg-slate-50 px-6 py-10 sm:grid-cols-2 sm:px-10">
          {about.length === 0 ? null : (
            <div>
              <h2 className="text-base font-bold text-slate-900">About us</h2>
              <div className="mt-2 space-y-2">
                <FactText facts={about} />
              </div>
            </div>
          )}
          {reviews.length === 0 ? null : (
            <div>
              <h2 className="text-base font-bold text-slate-900">From our customers</h2>
              <div className="mt-2 space-y-2">
                <FactText facts={reviews} />
              </div>
            </div>
          )}
        </section>
      )}

      <footer className="border-t border-slate-200 px-6 py-5 text-xs leading-5 text-slate-500 sm:px-10">
        {listing.name} is a sample business made for this demo. It is not a real company: the
        people, phone number, reviews and credentials on this page are invented.
      </footer>
    </div>
  );
}

export default async function DemoBusinessRoute({
  params,
}: {
  readonly params: Promise<{ slug: string }>;
}) {
  const page = await load((await params).slug);
  if (page === null) notFound();
  const { listing } = page;
  // A color from the business's settings (always "#rrggbb"); the page falls back to slate.
  const accent = /^#[0-9a-f]{6}$/i.test(page.color) ? page.color : "#334155";

  return (
    <div
      className="min-h-screen bg-stone-100"
      style={{ "--accent": accent } as CSSProperties}
      data-testid="demo-business"
    >
      <div className="bg-slate-950 text-slate-200">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2.5 text-sm sm:px-6">
          {/* A full page load on purpose: the chat script belongs to one business per page. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/demo" className="font-medium text-white hover:underline">
            ← All demos
          </a>
          <p className="text-slate-400">
            <span className="font-medium text-emerald-400">Live demo.</span> {listing.name} is a
            sample business; the chat in the corner is the real assistant
            {listing.agencyName === "" ? "" : ` from ${listing.agencyName}`}.
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:grid lg:grid-cols-[340px_minmax(0,1fr)] lg:gap-8">
        <aside className="mb-6 lg:sticky lg:top-6 lg:mb-0 lg:max-h-[calc(100vh-3rem)] lg:self-start lg:overflow-y-auto">
          <LeadPanel widgetKey={listing.widgetKey} botName={page.botName} />
          <p className="mt-3 px-1 text-xs leading-5 text-slate-500">
            What you write here is stored as a demo conversation. Please do not enter real personal
            details.
          </p>
        </aside>
        <Site page={page} />
      </div>

      <ChatSnippet widgetKey={listing.widgetKey} />
    </div>
  );
}
