import { createHash } from "node:crypto";

import { settingsWith } from "@repo/settings";

import { describeSituation } from "../engine/situation";
import { testBusiness, testInput, testTurn } from "../testing/fixtures";
import { buildPrompt } from "./build";
import { CURRENT_REPLY_PROMPT } from "./core";

/**
 * A fixed, representative request rendered with the current code: default settings, the
 * roofing test business, two exchanges of history, one new message. Its hash changes when
 * anything that reaches the model changes: the core prompt, a tool, the wording of a rule
 * rendered from a setting, the layout of the history or the turn context.
 *
 * `render.test.ts` compares it with the value recorded for the current `RENDER_VERSION`, so
 * a change to the prompt cannot ship without a version that says so.
 */
export function sampleRequest() {
  const { business, facts } = testBusiness("roofing");
  const settings = settingsWith({});
  const input = testInput({
    business,
    settings,
    channel: "whatsapp",
    now: "2026-11-10T17:00:00.000Z",
    customer: { name: "Pat", phone: "+13035550111", email: null },
    history: [
      testTurn("customer", "Hi, my roof is leaking over the kitchen.", "2026-11-10T16:50:00.000Z"),
      testTurn(
        "bot",
        "I'm Alex, the virtual assistant for Summit Roofing Co. Sorry about the leak! Is water coming in right now?",
        "2026-11-10T16:50:20.000Z",
      ),
    ],
    pending: [
      testTurn(
        "customer",
        "Not right now, only when it rains. ZIP is 80215.",
        "2026-11-10T16:59:00.000Z",
      ),
    ],
    lead: {
      id: null,
      status: "qualifying",
      fields: {
        service_type: {
          key: "service_type",
          value: "roof leak repair",
          confidence: 1,
          evidence: "my roof is leaking",
          updatedAt: "2026-11-10T16:50:10.000Z",
        },
      },
      routing: null,
    },
  });
  const situation = describeSituation(input, settings.values);
  return buildPrompt({
    input,
    values: settings.values,
    situation,
    coreFacts: facts.filter((item) => item.category !== "pricing"),
    turnFacts: facts.filter((item) => item.category === "pricing"),
    model: settings.values["model.reply.model"],
    strictTools: true,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The hash of the core prompt text alone. */
export function corePromptHash(text: string = CURRENT_REPLY_PROMPT.text): string {
  return sha256(text);
}

/** The hash of the whole sample request: tools, system blocks and messages. */
export function renderFingerprint(): string {
  const request = sampleRequest();
  return sha256(JSON.stringify([request.tools, request.system, request.messages]));
}
