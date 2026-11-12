import type { ModelClient, ModelRequest, ModelResponse, ReplyHints } from "@repo/ai";

import type { CustomerMove, CustomerSimulator, CustomerTurnInput } from "../simulate/customer";

/**
 * Models and customers for tests that drive the real engine: a model whose answers a test
 * decides request by request, and a customer who says exactly what a test tells them to.
 */

/** True when the request continues a tool loop: its last message carries tool results. */
export function afterTools(request: ModelRequest): boolean {
  const last = request.messages.at(-1);
  return (
    last?.role === "user" &&
    Array.isArray(last.content) &&
    last.content.some((block) => block.type === "tool_result")
  );
}

/** The structured facts of the turn the engine attaches to a reply request. */
export function replyHintsOf(request: ModelRequest): ReplyHints {
  const hints = (request.hints as { reply?: ReplyHints } | undefined)?.reply;
  if (hints === undefined) throw new Error("Not a reply request of the engine.");
  return hints;
}

export type Responder = (
  request: ModelRequest,
  call: number,
) => ModelResponse | Promise<ModelResponse>;

/** A model client whose behaviour can be replaced between tests (the sandbox keeps one). */
export function switchableModel(): ModelClient & {
  use(responder: Responder): void;
  readonly requests: ModelRequest[];
} {
  let responder: Responder = () => {
    throw new Error("No responder set for the test model.");
  };
  const requests: ModelRequest[] = [];
  return {
    name: "test-engine",
    requests,
    use(next) {
      responder = next;
      requests.length = 0;
    },
    async call(request) {
      requests.push(request);
      return responder(request, requests.length);
    },
  };
}

type Move = string | Partial<CustomerMove>;

/** A customer who plays the given moves in order, then leaves. Keeps what it was shown. */
export function scriptedCustomer(moves: readonly Move[]): CustomerSimulator & {
  readonly inputs: CustomerTurnInput[];
} {
  const queue = [...moves];
  const inputs: CustomerTurnInput[] = [];
  return {
    model: "scripted-customer",
    inputs,
    async next(input) {
      inputs.push({ ...input, entries: [...input.entries] });
      const move = queue.shift();
      if (move === undefined)
        return { messages: [], photo: false, leave: "nothing_more", replaced: false };
      return typeof move === "string"
        ? { messages: [move], photo: false, leave: null, replaced: false }
        : { messages: [], photo: false, leave: null, replaced: false, ...move };
    },
  };
}
