import { defineCategory, group, setting, type SettingDraft } from "../define";
import { f } from "../fields";

/** The default model of the product (docs/SPEC.md). */
export const DEFAULT_MODEL = "claude-fable-5-2";

/** Offered in the model picker. The field accepts any Claude model id, so new ones need no release. */
export const SUGGESTED_MODELS = [
  "claude-fable-5-2",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
] as const;

/** The values of `output_config.effort` in the Claude API. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * The tasks a model is called for. `ModelCallRecord.purpose` uses the same names, so spend
 * can be reported per task.
 */
export const MODEL_TASKS = [
  "reply",
  "follow_up",
  "photo_analysis",
  "lead_report",
  "playbook",
  "knowledge_extraction",
] as const;
export type ModelTask = (typeof MODEL_TASKS)[number];

const TASKS: Readonly<
  Record<ModelTask, { readonly label: string; readonly what: string; readonly effort: EffortLevel }>
> = {
  reply: { label: "Replies", what: "writes the replies to customers", effort: "medium" },
  follow_up: { label: "Follow-ups", what: "writes nudges and reminders", effort: "medium" },
  photo_analysis: {
    label: "Photo analysis",
    what: "looks at the photos customers send",
    effort: "medium",
  },
  lead_report: { label: "Lead reports", what: "writes the lead report", effort: "high" },
  playbook: {
    label: "Playbook generation",
    what: "researches and writes the industry playbook of a new segment",
    effort: "high",
  },
  knowledge_extraction: {
    label: "Knowledge extraction",
    what: "turns imported data and website pages into knowledge facts",
    effort: "medium",
  },
};

type TaskSettings = {
  readonly [K in ModelTask as `model.${K}.model`]: SettingDraft<string>;
} & {
  readonly [K in ModelTask as `model.${K}.effort`]: SettingDraft<EffortLevel>;
};

function taskSettings(): TaskSettings {
  const drafts: Record<string, SettingDraft> = {};
  for (const task of MODEL_TASKS) {
    const { label, what, effort } = TASKS[task];
    Object.assign(
      drafts,
      group(label, {
        [`model.${task}.model`]: setting({
          label: `${label}: model`,
          help: `The Claude model that ${what}.`,
          field: f.text({
            format: "model_id",
            minLength: 1,
            maxLength: 80,
            suggestions: SUGGESTED_MODELS,
          }),
          default: DEFAULT_MODEL,
        }),
        [`model.${task}.effort`]: setting({
          label: `${label}: effort`,
          help: "How hard the model thinks. Higher effort is slower and costs more; for customer replies it also means a longer wait.",
          field: f.select(EFFORT_LEVELS),
          default: effort,
        }),
      }),
    );
  }
  return drafts as TaskSettings;
}

/**
 * Model and effort per task. Consumed by the model client (C4) and every chunk that calls
 * it. Requests follow docs/ARCHITECTURE.md §5 whatever is chosen here.
 */
export const modelSettings = defineCategory("model", {
  ...taskSettings(),
  ...group("Requests", {
    "model.reply_max_output_tokens": setting({
      label: "Room for a reply",
      help: "The most tokens one reply request may produce, thinking included. Too little cuts replies off and forces a retry; this is a ceiling, not a target.",
      field: f.integer({ min: 2000, max: 64_000, step: 1000, unit: "tokens" }),
      default: 16_000,
    }),
    "model.max_tool_rounds": setting({
      label: "Steps per reply",
      help: "How many rounds of actions (updating the lead, looking up times, analyzing a photo) the model may take before it must answer.",
      field: f.integer({ min: 1, max: 15, unit: "rounds" }),
      default: 6,
    }),
    "model.server_side_fallbacks": setting({
      label: "Fallback model",
      help: "When the model declines a request, the Claude API retries it on a fallback model inside the same call, so the customer still gets an answer. If the fallback declines too, the conversation goes to a person.",
      field: f.boolean(),
      default: true,
    }),
    "model.cache_ttl": setting({
      label: "Prompt cache lifetime",
      help: "How long the stable part of a business's prompt stays cached between requests. One hour costs more to write and pays off for businesses with few conversations a day.",
      field: f.select([
        ["5m", "5 minutes"],
        ["1h", "1 hour"],
      ]),
      default: "5m",
    }),
  }),
});
