import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEngine, type ModelMessageParam, PROMPT_VERSION } from "@repo/ai";
import {
  createScriptedModelClient,
  type ScriptedModelClient,
  scriptedResponse,
  text,
  toolUse,
} from "@repo/ai/testing";
import {
  CHANNEL_CAPABILITIES,
  type ConversationId,
  type ExecutedAction,
  type ToolExecutionContext,
  type TraceId,
} from "@repo/core";
import {
  attachments,
  conversations,
  conversationTurns,
  eq,
  knowledgeItems,
  modelCalls,
} from "@repo/db";
import {
  createKnowledgeRetriever,
  savePlaybookVersion,
  setPlaybookOverride,
} from "@repo/knowledge";
import { ROOFING_PLAYBOOK } from "@repo/knowledge/testing";
import { loadSettings } from "@repo/settings/server";

import { loadBusinessProfile } from "../ports/loaders";
import { createHarness, type Harness, message, type TestTenant } from "../testing/harness";
import { createDomainComposition } from "./index";

/**
 * The domain composition with the real conversation engine: a conversation through the
 * webhook, the jobs, the engine (with a scripted model) and the send path, and the three
 * action handlers and the guard that the engine's chunk registers.
 */

let h: Harness;
let model: ScriptedModelClient;

beforeAll(async () => {
  model = createScriptedModelClient();
  h = await createHarness({ model });
  const engine = createEngine({ model });
  h.engine.respond = (input, ports) => engine.respond(input, ports);
});

afterAll(async () => {
  await h?.dispose();
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);

function lastText(messageParam: ModelMessageParam | undefined): string {
  if (messageParam === undefined) return "";
  if (typeof messageParam.content === "string") return messageParam.content;
  return (messageParam.content ?? [])
    .map((block) =>
      block.type === "text"
        ? block.text
        : block.type === "tool_result" && typeof block.content === "string"
          ? block.content
          : "",
    )
    .join("\n");
}

async function turnsOf(tenant: TestTenant) {
  return h.t.admin
    .select()
    .from(conversationTurns)
    .where(eq(conversationTurns.businessId, tenant.tenant.businessId))
    .orderBy(conversationTurns.ordinal);
}

function actionsOf(turn: { actions: unknown[] } | undefined): ExecutedAction[] {
  return (turn?.actions ?? []) as ExecutedAction[];
}

async function handlerContext(
  tenant: TestTenant,
  conversationId: string,
  mode: "live" | "dry_run",
): Promise<ToolExecutionContext> {
  return h.t.db.forBusiness(tenant.tenant.businessId).run(async (ctx) => {
    const business = await loadBusinessProfile(ctx);
    return {
      trace: {
        traceId: "0e000000-0000-4000-8000-0000000000aa" as TraceId,
        ...tenant.tenant,
        conversationId: conversationId as ConversationId,
      },
      mode,
      toolCallId: "toolu_direct",
      now: new Date().toISOString(),
      settings: await loadSettings(ctx, tenant.tenant),
      channel: {
        id: "test",
        capabilities: CHANNEL_CAPABILITIES.test,
        window: { open: true, closesAt: null },
      },
      business: business!,
    };
  });
}

describe("a conversation through the pipeline and the real engine", () => {
  it("answers through webhook, jobs, engine and send, and records turn and model calls", async () => {
    const tenant = await h.newTenant();
    const before = model.requests.length;
    model.push(
      scriptedResponse(
        [
          toolUse("update_lead_fields", {
            fields: [
              {
                key: "service_type",
                value: "roof leak repair",
                confidence: 1,
                evidence: "roof is leaking",
              },
              { key: "service_area", value: "80215", confidence: 1, evidence: "ZIP 80215" },
            ],
          }),
        ],
        { usage: { inputTokens: 900, outputTokens: 80, cacheCreationInputTokens: 7000 } },
      ),
      scriptedResponse([text("Sorry about the leak! How soon do you need someone out?")], {
        usage: { inputTokens: 200, outputTokens: 30, cacheReadInputTokens: 7000 },
      }),
    );

    const response = await h.deliver(tenant, [message("My roof is leaking, ZIP 80215")]);
    expect(response.status).toBe(200);
    await h.idle();

    const rows = await h.messagesOf(tenant);
    expect(rows.map((row) => [row.direction, row.author, row.status])).toEqual([
      ["inbound", "customer", "received"],
      ["outbound", "bot", "sent"],
    ]);
    // The first reply carries the AI disclosure (added by the output guard).
    expect(rows[1]?.text).toBe(
      `I'm Alex, the virtual assistant for ${(await businessName(tenant)).replace(/\.$/, "")}. Sorry about the leak! How soon do you need someone out?`,
    );
    expect(h.transport.textsFor(rows[0]!.conversationId)).toEqual([rows[1]?.text]);

    const [turn] = await turnsOf(tenant);
    expect(turn).toMatchObject({
      status: "replied",
      engineOutcome: "replied",
      promptVersion: PROMPT_VERSION,
      inputTokens: 1100,
      outputTokens: 110,
      cacheReadInputTokens: 7000,
      cacheCreationInputTokens: 7000,
    });
    // Lead scoring (C5) handled the fields: stored, and still qualifying.
    expect(actionsOf(turn).map((entry) => [entry.action.type, entry.outcome.status])).toEqual([
      ["update_lead_fields", "applied"],
    ]);
    expect(lastText(model.requests[before + 1]?.messages.at(-1))).toContain(
      "Routing decision: none yet",
    );

    // Every model call is stored with its input, output, tokens, cache reads and latency.
    const calls = await h.t.admin
      .select()
      .from(modelCalls)
      .where(eq(modelCalls.businessId, tenant.tenant.businessId))
      .orderBy(modelCalls.startedAt, modelCalls.createdAt);
    expect(calls).toHaveLength(2);
    expect(
      calls.map((call) => [call.purpose, call.mode, call.promptVersion, call.stopReason]),
    ).toEqual([
      ["reply", "live", PROMPT_VERSION, "tool_use"],
      ["reply", "live", PROMPT_VERSION, "end_turn"],
    ]);
    expect(calls[1]).toMatchObject({
      model: "claude-fable-5-2",
      effort: "medium",
      cacheReadInputTokens: 7000,
      settingsVersion: turn?.settingsVersion,
      traceId: turn?.traceId,
      conversationId: rows[0]?.conversationId,
    });
    expect(calls[1]?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls[0]?.costMicroUsd).toBeGreaterThan(0);
    expect(JSON.stringify(calls[0]?.request)).toContain("You answer customer messages");
    expect(JSON.stringify(calls[1]?.response)).toContain("Sorry about the leak!");

    // The engine saw what the channel knows about the customer.
    const first = model.requests[before];
    expect(lastText(first?.messages.at(-1))).toContain('name "Pat"');
    expect(first?.system[2]?.text).toContain("Trade: Roofing");
  });

  it("gives the engine the facts of the business and nobody else's", async () => {
    const tenant = await h.newTenant();
    const other = await h.newTenant();
    await h.t.admin.insert(knowledgeItems).values([
      {
        ...tenant.tenant,
        category: "services",
        title: "Services",
        content: "Roof repair and full replacement.",
        position: 1,
      },
      {
        ...tenant.tenant,
        category: "warranties",
        title: "Warranty",
        content: "10-year workmanship warranty on replacements.",
        position: 2,
      },
      {
        ...tenant.tenant,
        category: "faq",
        title: "Metal roofs",
        content: "We install standing-seam metal roofs.",
        position: 3,
      },
      {
        ...tenant.tenant,
        category: "services",
        title: "Old",
        content: "Chimney sweeping.",
        status: "archived",
      },
      {
        ...other.tenant,
        category: "faq",
        title: "Metal roofs",
        content: "SECRET of another business about metal roofs.",
      },
    ]);
    const retriever = createKnowledgeRetriever({ db: h.t.db });
    const core = await retriever.coreFacts(tenant.tenant.businessId);
    // The product's category order (services, warranties, FAQ), not the alphabet's.
    expect(core.map((fact) => fact.title)).toEqual(["Services", "Warranty", "Metal roofs"]);
    const found = await retriever.retrieve({
      businessId: tenant.tenant.businessId,
      text: "Do you do metal roofs? What's the warranty?",
      limit: 5,
    });
    // The two facts the message is about lead: one matches its words best, the other is the
    // kind of fact it asks for. "roofs" also finds the services fact, which is fine.
    expect(
      found
        .slice(0, 2)
        .map((fact) => fact.title)
        .sort(),
    ).toEqual(["Metal roofs", "Warranty"]);
    expect(JSON.stringify([core, found])).not.toContain("SECRET");
    expect(JSON.stringify([core, found])).not.toContain("Chimney");
    expect(
      await retriever.retrieve({ businessId: tenant.tenant.businessId, text: "?!", limit: 5 }),
    ).toEqual([]);

    // Through the pipeline: core categories in the business section, the rest per turn.
    const before = model.requests.length;
    model.push(scriptedResponse([text("Yes, we install metal roofs.")]));
    await h.deliver(tenant, [message("do you install metal roofs")]);
    await h.idle();
    const request = model.requests[before];
    expect(request?.system[2]?.text).toContain("Roof repair and full replacement.");
    expect(request?.system[2]?.text).not.toContain("standing-seam");
    expect(lastText(request?.messages.at(-1))).toContain(
      "- [faq] Metal roofs: We install standing-seam metal roofs.",
    );
  });

  it("gives the engine the segment's playbook with the business's own sections, and price norms only as the pricing settings allow", async () => {
    const tenant = await h.newTenant();
    const sibling = await h.newTenant();
    const playbookOf = async (target: TestTenant, customer: string) => {
      const before = model.requests.length;
      model.push(scriptedResponse([text("Thanks, noted.")]));
      await h.deliver(target, [message(customer)]);
      await h.idle();
      return model.requests[before]?.system[1]?.text ?? "";
    };

    // No playbook stored yet: the engine's built-in document for the trade.
    expect(await playbookOf(tenant, "hello")).toContain("roofing (built-in placeholder)");

    const { agencyId, businessId } = tenant.tenant;
    const profile = await h.t.db.forBusiness(businessId).run((ctx) => loadBusinessProfile(ctx));
    await h.t.db.forAgency(agencyId).run((ctx) =>
      savePlaybookVersion(ctx, {
        segmentId: profile!.segment.id,
        document: ROOFING_PLAYBOOK,
        origin: "generated",
        requireComplete: true,
      }),
    );
    const stored = await playbookOf(tenant, "my roof leaks");
    expect(stored).toContain('source="roofing v1"');
    expect(stored).toContain("- Storm damage inspection and repair:");
    expect(stored).toContain('"Can\'t you just patch it?"');
    // Default settings never disclose prices: the price norms are not in the prompt at all.
    expect(stored).not.toContain("Price norms");
    expect(stored).not.toContain("$9,500");
    expect(stored).not.toContain("24,000");

    // The business allows industry ranges: now, and only now, the figures are shown.
    await h.setSettings(tenant.tenant, {
      "pricing.disclosure": "ranges",
      "pricing.use_playbook_ranges": true,
    });
    const priced = await playbookOf(tenant, "what does a new roof cost");
    expect(priced).toContain(
      "- Asphalt shingle roof replacement: $9,500 to $24,000 per roof (Mountain West)",
    );
    // Another agency's business of the same trade has its own segment and no playbook.
    expect(await playbookOf(sibling, "hi")).toContain("built-in placeholder");

    // The business replaces one section; the rest still follows the segment.
    await h.t.db.forBusiness(businessId).run((ctx) =>
      setPlaybookOverride(ctx, {
        tenant: tenant.tenant,
        section: "objections",
        content: [{ objection: "Are you local?", response: "Yes, the crew is based in Lakewood." }],
      }),
    );
    const own = await playbookOf(tenant, "are you local");
    expect(own).toContain("roofing v1, with this business's own sections");
    expect(own).toContain('"Are you local?": Yes, the crew is based in Lakewood.');
    expect(own).not.toContain("Can't you just patch it?");
    expect(own).toContain("- Storm damage inspection and repair:");
  });
});

async function businessName(tenant: TestTenant): Promise<string> {
  const profile = await h.t.db
    .forBusiness(tenant.tenant.businessId)
    .run((ctx) => loadBusinessProfile(ctx));
  return profile!.name;
}

describe("request_photo", () => {
  it("lets the bot ask as often as the business allows, then refuses", async () => {
    const tenant = await h.newTenant({ "photos.max_requests": 2 });
    const ask = () => [
      scriptedResponse([toolUse("request_photo", { subject: "the stain on the ceiling" })]),
      scriptedResponse([text("Could you send a photo of the stain?")]),
    ];
    for (const customer of ["My ceiling has a stain", "ok", "what now"]) {
      model.push(...ask());
      await h.deliver(tenant, [message(customer)]);
      await h.idle();
    }
    const turns = await turnsOf(tenant);
    expect(turns.map((turn) => actionsOf(turn)[0]?.outcome.status)).toEqual([
      "applied",
      "applied",
      "rejected",
    ]);
    expect(actionsOf(turns[2])[0]?.outcome.message).toContain("already asked for photos 2 times");
  });
});

describe("analyze_photos", () => {
  it("looks at a photo of the conversation and keeps what it saw with the attachment", async () => {
    const tenant = await h.newTenant();
    h.transport.media.set("media-ceiling", { bytes: JPEG, mimeType: "image/jpeg" });
    const before = model.requests.length;
    // Replies are scripted by purpose: the handler's photo call sits between the two reply calls.
    model.push(
      (request) => {
        const context = lastText(request.messages.at(-1));
        const id = /Photos not looked at yet: ([0-9a-f-]+)\./.exec(context)?.[1];
        return scriptedResponse([
          toolUse("analyze_photos", {
            attachment_ids: [id ?? "missing"],
            question: "Where is the stain?",
          }),
        ]);
      },
      scriptedResponse([
        text("Photo 1: A brown water stain about two feet wide on a white ceiling."),
      ]),
      scriptedResponse([text("Thanks for the photo! That helps the team.")]),
    );
    await h.deliver(tenant, [
      message("here is the ceiling", {
        attachments: [
          {
            kind: "image",
            mimeType: "image/jpeg",
            fileName: "ceiling.jpg",
            sizeBytes: JPEG.byteLength,
            source: { type: "provider_media", mediaId: "media-ceiling" },
          },
        ],
      }),
    ]);
    await h.idle();

    const [turn] = await turnsOf(tenant);
    expect(turn?.status).toBe("replied");
    const [executed] = actionsOf(turn);
    expect(executed).toMatchObject({
      action: { type: "analyze_photos", question: "Where is the stain?" },
      outcome: {
        status: "applied",
        data: {
          description: "Photo 1: A brown water stain about two feet wide on a white ceiling.",
        },
      },
    });
    const stored = await h.t.admin
      .select()
      .from(attachments)
      .where(eq(attachments.businessId, tenant.tenant.businessId));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.analysis).toBe(
      "Photo 1: A brown water stain about two feet wide on a white ceiling.",
    );
    expect(stored[0]?.analyzedAt).toBeInstanceOf(Date);

    // The photo call went to the model with the image, under its own purpose and prompt.
    const photoRequest = model.requests[before + 1];
    expect(photoRequest?.purpose).toBe("photo_analysis");
    expect(JSON.stringify(photoRequest?.messages)).toContain(Buffer.from(JPEG).toString("base64"));
    const calls = await h.t.admin
      .select({ purpose: modelCalls.purpose, promptVersion: modelCalls.promptVersion })
      .from(modelCalls)
      .where(eq(modelCalls.businessId, tenant.tenant.businessId));
    expect(calls.map((call) => call.purpose).sort()).toEqual(["photo_analysis", "reply", "reply"]);

    // Next turn: the photo appears in the history as its description, and is not offered again.
    const next = model.requests.length;
    model.push(scriptedResponse([text("You're welcome!")]));
    await h.deliver(tenant, [message("thanks")]);
    await h.idle();
    const history = JSON.stringify(model.requests[next]?.messages);
    expect(history).toContain('state=\\"analyzed\\">Photo 1: A brown water stain');
    expect(history).not.toContain("Photos not looked at yet");
  });

  it("refuses photos of another conversation, and writes nothing in a dry run", async () => {
    const tenant = await h.newTenant();
    const stranger = await h.newTenant();
    h.transport.media.set("media-a", { bytes: JPEG, mimeType: "image/jpeg" });
    const withPhoto = (text_: string) =>
      message(text_, {
        attachments: [
          {
            kind: "image",
            mimeType: "image/jpeg",
            fileName: "a.jpg",
            sizeBytes: JPEG.byteLength,
            source: { type: "provider_media", mediaId: "media-a" },
          },
        ],
      });
    model.push(scriptedResponse([text("Thanks!")]), scriptedResponse([text("Thanks!")]));
    await h.deliver(tenant, [withPhoto("mine")]);
    await h.deliver(stranger, [withPhoto("theirs")]);
    await h.idle();

    const [mine] = await h.t.admin
      .select()
      .from(attachments)
      .where(eq(attachments.businessId, tenant.tenant.businessId));
    const [theirs] = await h.t.admin
      .select()
      .from(attachments)
      .where(eq(attachments.businessId, stranger.tenant.businessId));
    const [conversation] = await h.conversationsOf(tenant);
    const handlers = createDomainComposition({
      db: h.t.db,
      logger: h.pipeline.context.logger,
      model,
      storage: h.pipeline.context.storage,
    }).actions;
    const analyze = handlers.find("analyze_photos")!;

    // An attachment of another business is simply not there.
    const live = await handlerContext(tenant, conversation!.id, "live");
    expect(
      await analyze.handle(
        { type: "analyze_photos", attachmentIds: [theirs!.id], question: "?" } as never,
        live,
      ),
    ).toMatchObject({ status: "rejected" });

    // Dry run: the model is asked, the description comes back, nothing is stored.
    model.push(scriptedResponse([text("Photo 1: A ceiling.")]));
    const dry = await handlerContext(tenant, conversation!.id, "dry_run");
    expect(
      await analyze.handle(
        { type: "analyze_photos", attachmentIds: [mine!.id], question: "?" } as never,
        dry,
      ),
    ).toMatchObject({ status: "applied", data: { description: "Photo 1: A ceiling." } });
    const [after] = await h.t.admin.select().from(attachments).where(eq(attachments.id, mine!.id));
    expect(after?.analysis).toBeNull();
    expect(after?.analyzedAt).toBeNull();
  });
});

describe("end_conversation", () => {
  it("keeps the bot silent after 'stop_replying' until a person clears the mark", async () => {
    const tenant = await h.newTenant();
    model.push(
      scriptedResponse([
        toolUse("mark_not_a_fit", { category: "spam", reason: "Bulk advertising." }),
        toolUse("end_conversation", { reason: "Spam.", disposition: "stop_replying" }),
      ]),
      scriptedResponse([text("<no_reply/>")]),
    );
    await h.deliver(tenant, [message("WIN A FREE CRUISE click here")]);
    await h.idle();
    const [conversation] = await h.conversationsOf(tenant);
    expect(conversation?.metadata["ended"]).toMatchObject({
      disposition: "stop_replying",
      reason: "Spam.",
    });
    expect(conversation?.status).toBe("open");

    const calls = model.requests.length;
    await h.deliver(tenant, [message("hello??")]);
    await h.idle();
    // No model call, no reply: the guard stopped the turn.
    expect(model.requests).toHaveLength(calls);
    const turns = await turnsOf(tenant);
    expect(turns.map((turn) => turn.status)).toEqual(["no_reply", "skipped"]);
    expect((await h.messagesOf(tenant)).filter((row) => row.direction === "outbound")).toHaveLength(
      0,
    );
  });

  it("lets the customer's next message reopen a conversation that had simply ended", async () => {
    const tenant = await h.newTenant();
    model.push(
      scriptedResponse([
        toolUse("end_conversation", { reason: "Customer said goodbye.", disposition: "completed" }),
      ]),
      scriptedResponse([text("You're welcome, take care!")]),
      scriptedResponse([text("Of course! What else can I help with?")]),
    );
    await h.deliver(tenant, [message("thanks, bye")]);
    await h.idle();
    let [conversation] = await h.conversationsOf(tenant);
    expect(conversation?.metadata["ended"]).toMatchObject({ disposition: "completed" });

    await h.deliver(tenant, [message("oh, one more thing")]);
    await h.idle();
    [conversation] = await h.conversationsOf(tenant);
    expect(conversation?.metadata["ended"]).toBeUndefined();
    const sent = (await h.messagesOf(tenant)).filter((row) => row.direction === "outbound");
    expect(sent.map((row) => row.status)).toEqual(["sent", "sent"]);
  });

  it("writes nothing in a dry run (invariant I8)", async () => {
    const tenant = await h.newTenant();
    model.push(scriptedResponse([text("Hello!")]));
    await h.deliver(tenant, [message("hi")]);
    await h.idle();
    const [conversation] = await h.conversationsOf(tenant);
    const handlers = createDomainComposition({
      db: h.t.db,
      logger: h.pipeline.context.logger,
      model,
    }).actions;
    const context = await handlerContext(tenant, conversation!.id, "dry_run");
    expect(
      await handlers
        .find("end_conversation")!
        .handle(
          { type: "end_conversation", reason: "x", disposition: "stop_replying" } as never,
          context,
        ),
    ).toMatchObject({ status: "applied" });
    expect(
      await handlers
        .find("request_photo")!
        .handle({ type: "request_photo", subject: "x" } as never, context),
    ).toMatchObject({ status: "applied" });
    const [after] = await h.t.admin
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation!.id));
    expect(after?.metadata).toEqual(conversation?.metadata);
  });
});
