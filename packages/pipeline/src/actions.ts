import {
  type ActionHandler,
  type ActionOutcome,
  EngineAction,
  type EngineActionType,
  type Logger,
  type ToolRuntime,
} from "@repo/core";

/**
 * The action-handler registry (ARCHITECTURE §7). Each `EngineAction` type has at most one
 * handler, registered at the composition root by the chunk that owns the behaviour (C5 lead
 * fields and not-a-fit, C12 scheduling, C13 follow-ups, emergencies and handoff, C4 photos
 * and ending). Until its owner registers one, an action gets the default below.
 */
/** A handler for any one action type (`ActionHandler<"update_lead_fields">`, ...). */
export type AnyActionHandler = {
  [TType in EngineActionType]: ActionHandler<TType>;
}[EngineActionType];

export interface ActionHandlerRegistry {
  register(handler: AnyActionHandler): void;
  find(type: EngineActionType): AnyActionHandler | undefined;
  types(): EngineActionType[];
}

export function createActionHandlerRegistry(
  handlers: readonly AnyActionHandler[] = [],
): ActionHandlerRegistry {
  const byType = new Map<EngineActionType, AnyActionHandler>();
  const registry: ActionHandlerRegistry = {
    register(handler) {
      if (byType.has(handler.type)) {
        throw new Error(`A handler for the ${handler.type} action is already registered.`);
      }
      byType.set(handler.type, handler);
    },
    find: (type) => byType.get(type),
    types: () => [...byType.keys()],
  };
  for (const handler of handlers) registry.register(handler);
  return registry;
}

/**
 * What an action without a registered handler returns. Scheduling is refused so the reply
 * says the team will be in touch instead of promising a time (BUILD_PLAN, "Who registers
 * what"); everything else is accepted and recorded with the turn as `deferred`.
 */
export function defaultActionOutcome(type: EngineActionType): ActionOutcome {
  if (type === "offer_times" || type === "book_meeting") {
    return {
      status: "rejected",
      message:
        "Online booking is not available. Tell the customer the team will contact them to find a time.",
      data: null,
    };
  }
  return {
    status: "deferred",
    message: "Recorded. The team will follow up on it.",
    data: null,
  };
}

/**
 * The `ToolRuntime` the engine receives. Every action is validated again with the contract
 * schema (the model's tool input is untrusted), then given to its handler. A handler error
 * becomes a `failed` outcome, so the model is told not to promise the result instead of the
 * whole turn failing.
 */
export function createToolRuntime(options: {
  readonly registry: ActionHandlerRegistry;
  readonly logger: Logger;
}): ToolRuntime {
  const { registry, logger } = options;
  return {
    async execute(action, context) {
      const parsed = EngineAction.safeParse(action);
      if (!parsed.success) {
        logger.warn("action.invalid", {
          toolCallId: context.toolCallId,
          paths: parsed.error.issues.map((issue) => issue.path.join(".")),
        });
        return {
          status: "rejected",
          message: "The action was not valid and was not carried out.",
          data: null,
        };
      }
      const valid = parsed.data;
      const handler = registry.find(valid.type);
      if (handler === undefined) return defaultActionOutcome(valid.type);
      try {
        // The registry is keyed by type, so this handler takes exactly this action.
        return await (handler as ActionHandler).handle(valid, context);
      } catch (error) {
        logger.error("action.failed", { type: valid.type, toolCallId: context.toolCallId, error });
        return {
          status: "failed",
          message: "The action could not be completed. Do not promise its result.",
          data: null,
        };
      }
    },
  };
}
