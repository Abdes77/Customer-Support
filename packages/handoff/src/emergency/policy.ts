import type { AppSettings } from "@repo/settings";

/**
 * The emergency escalation chain as a plan, worked out in code from a snapshot of the
 * settings taken when the chain starts (pure; no clock).
 *
 * For each round (`emergency.rounds`), for each person of the business's chain in order:
 * alert them by their channels, wait `emergency.acknowledge_minutes`, then (with
 * `emergency.call_unacknowledged`) call them and wait a short while for the keypress, then
 * the next person. After the rounds, the agency's fallback contacts the same way, once.
 * Every person is called at most once per round, so nobody is called in a loop.
 */

export type AlertBy = "sms" | "whatsapp" | "email";

export interface ChainContact {
  readonly name: string;
  readonly phone: string;
  readonly email: string;
  readonly alertBy: readonly AlertBy[];
  readonly source: "business" | "agency";
}

export interface ChainPolicy {
  readonly ackMinutes: number;
  readonly call: boolean;
  readonly rounds: number;
  /** How long a call is given to be answered and acknowledged before the next person. */
  readonly callWaitMinutes: number;
}

export interface ChainStep {
  readonly index: number;
  readonly kind: "alert" | "call";
  /** Index into the chain snapshot. */
  readonly contact: number;
  /** Zero-based round; the agency's fallback contacts are in round `rounds`. */
  readonly round: number;
  /** Minutes to wait after this step before the next one. */
  readonly waitMinutes: number;
}

/** A call rings for 30 s and plays its message; two minutes covers answering and pressing 1. */
export const CALL_WAIT_MINUTES = 2;

export function chainFromSettings(values: AppSettings): ChainContact[] {
  const map = (
    list: AppSettings["emergency.escalation_chain"],
    source: ChainContact["source"],
  ): ChainContact[] =>
    list.map((contact) => ({
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      alertBy: contact.alert_by.filter((by) => by !== "email" || contact.email.length > 0),
      source,
    }));
  return [
    ...map(values["emergency.escalation_chain"], "business"),
    ...map(values["emergency.fallback_contacts"], "agency"),
  ];
}

export function policyFromSettings(values: AppSettings): ChainPolicy {
  return {
    ackMinutes: values["emergency.acknowledge_minutes"],
    call: values["emergency.call_unacknowledged"],
    rounds: values["emergency.rounds"],
    callWaitMinutes: CALL_WAIT_MINUTES,
  };
}

export function planSteps(chain: readonly ChainContact[], policy: ChainPolicy): ChainStep[] {
  const steps: ChainStep[] = [];
  const add = (contact: number, round: number) => {
    steps.push({
      index: steps.length,
      kind: "alert",
      contact,
      round,
      waitMinutes: policy.ackMinutes,
    });
    if (policy.call) {
      steps.push({
        index: steps.length,
        kind: "call",
        contact,
        round,
        waitMinutes: policy.callWaitMinutes,
      });
    }
  };
  const business = chain.flatMap((contact, index) =>
    contact.source === "business" ? [index] : [],
  );
  const agency = chain.flatMap((contact, index) => (contact.source === "agency" ? [index] : []));
  for (let round = 0; round < policy.rounds; round += 1) {
    for (const index of business) add(index, round);
  }
  for (const index of agency) add(index, policy.rounds);
  return steps;
}
