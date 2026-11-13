import type { ActionHandler, ActionOutcome, ToolExecutionContext } from "@repo/core";
import type { AppSettings } from "@repo/settings";

import { type BookingRequest, createBookingService, dryRunVerdict } from "./bookings";
import type { SchedulingDeps } from "./deps";

/*
 * The engine's scheduling actions (C4 declared them; C12 handles them), registered in the
 * pipeline's domain composition. Each decides with the turn's settings snapshot and the
 * stored state, never on the model's word: the routing decision, the details required before
 * booking, the calendar and the other bookings are all checked here. The outcome goes back
 * to the model as the tool result.
 *
 * In dry-run mode (invariant I8) a handler answers what the settings allow and writes and
 * calls nothing.
 */

function requestOf(context: ToolExecutionContext): BookingRequest | null {
  const conversationId = context.trace.conversationId;
  if (conversationId === null) return null;
  return {
    tenant: { agencyId: context.trace.agencyId, businessId: context.trace.businessId },
    conversationId,
    traceId: context.trace.traceId,
    now: new Date(context.now),
    // The engine checked the snapshot against the registry before it called any tool.
    values: context.settings.values as unknown as AppSettings,
    mode: context.mode,
  };
}

/** A dry run gets the settings' verdict only, or what would happen. */
function dryRun(
  type: "offer_times" | "book_meeting" | "cancel_meeting",
  context: ToolExecutionContext,
): ActionOutcome {
  return (
    dryRunVerdict(type, context.settings.values as unknown as AppSettings) ?? {
      status: "applied",
      message: "Dry run: nothing was booked or changed.",
      data: null,
    }
  );
}

const NO_CONVERSATION: ActionOutcome = {
  status: "rejected",
  message: "There is no conversation to book for.",
  data: null,
};

export type SchedulingActionHandler =
  ActionHandler<"offer_times"> | ActionHandler<"book_meeting"> | ActionHandler<"cancel_meeting">;

export function schedulingActionHandlers(deps: SchedulingDeps): SchedulingActionHandler[] {
  const service = createBookingService(deps);
  const offer: ActionHandler<"offer_times"> = {
    type: "offer_times",
    async handle(action, context) {
      if (context.mode === "dry_run") return dryRun(action.type, context);
      const request = requestOf(context);
      if (request === null) return NO_CONVERSATION;
      return service.offerTimes({ ...request, preference: action.preference, count: action.count });
    },
  };
  const book: ActionHandler<"book_meeting"> = {
    type: "book_meeting",
    async handle(action, context) {
      if (context.mode === "dry_run") return dryRun(action.type, context);
      const request = requestOf(context);
      if (request === null) return NO_CONVERSATION;
      return service.book({ ...request, slotId: action.slotId });
    },
  };
  const cancel: ActionHandler<"cancel_meeting"> = {
    type: "cancel_meeting",
    async handle(action, context) {
      if (context.mode === "dry_run") return dryRun(action.type, context);
      const request = requestOf(context);
      if (request === null) return NO_CONVERSATION;
      return service.cancel({ ...request, reason: action.reason });
    },
  };
  return [offer, book, cancel];
}
