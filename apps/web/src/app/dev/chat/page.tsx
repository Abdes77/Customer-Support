import { randomUUID } from "node:crypto";

import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";

import { asc, businesses } from "@repo/db";

import { requireAccess, userDatabase } from "@/server/auth";
import { getServerPipeline } from "@/server/pipeline";

import { DevChat } from "./chat";

export const metadata: Metadata = { title: "Test chat" };
export const dynamic = "force-dynamic";

const VISITOR = /^[A-Za-z0-9_-]{8,64}$/;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

const JOBS_NOTE = {
  inngest: "Replies run on Inngest.",
  local: "Replies run inside this server process (Inngest is not configured).",
  unconfigured:
    "Background jobs are not configured, so the bot cannot reply. See docs/HUMAN_TODO.md.",
} as const;

/**
 * Chat with any business of your agency as a customer would, through the "test" channel:
 * the message goes through the webhook path, the reply function and the send function like
 * a WhatsApp or website message. Agency staff only.
 */
export default async function DevChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, access } = await requireAccess("/dev/chat");
  const staffOf = new Set(access.agencies.map((agency) => agency.agencyId as string));
  const rows =
    staffOf.size === 0
      ? []
      : await userDatabase(user).run(({ tx }) =>
          tx
            .select({ id: businesses.id, name: businesses.name, agencyId: businesses.agencyId })
            .from(businesses)
            .orderBy(asc(businesses.name)),
        );
  const list = rows.filter((row) => staffOf.has(row.agencyId));
  if (list.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-12">
        <h1 className="text-2xl font-semibold">Test chat</h1>
        <p className="mt-4 text-slate-600">
          The test chat is for agency staff, and needs at least one business in your agency.
        </p>
      </main>
    );
  }

  const params = await searchParams;
  const businessId = list.find((row) => row.id === first(params["business"]))?.id ?? list[0]!.id;
  const visitor = first(params["visitor"]);
  if (visitor === undefined || !VISITOR.test(visitor)) {
    // The visitor id lives in the address, so a reload keeps the conversation.
    redirect(`/dev/chat?business=${businessId}&visitor=dev-${randomUUID()}` as Route);
  }
  const server = getServerPipeline();

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Test chat</h1>
        <p className="text-sm text-slate-600">
          Write as a customer. {JOBS_NOTE[server.mode]} The reply engine is the echo stub until the
          conversation engine is installed.
        </p>
      </header>
      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-sm font-medium text-slate-800">
          Business
          <select
            name="business"
            defaultValue={businessId}
            className="mt-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-base"
          >
            {list.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-50"
        >
          Open
        </button>
        <a
          href={`/dev/chat?business=${businessId}`}
          className="ml-auto text-sm font-medium text-blue-700 underline"
        >
          New conversation
        </a>
      </form>
      <DevChat
        key={`${businessId}:${visitor}`}
        businessId={businessId}
        visitorId={visitor}
        available={server.testChannel !== null}
      />
    </main>
  );
}
