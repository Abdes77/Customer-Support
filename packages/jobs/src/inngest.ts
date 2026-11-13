import { Inngest, NonRetriableError, RetryAfterError } from "inngest";

import { createLogger, EVENT_CATALOG, ExternalServiceError, type Logger } from "@repo/core";

import {
  isCronJob,
  type JobContext,
  type JobDefinition,
  type JobEventEnvelope,
  type StepTools,
} from "./definition";
import { describeJobError, InvalidJobPayloadError, isPermanentError, retryAfterMs } from "./errors";
import type { AnyJobEvent, EventSender } from "./events";

/** The Inngest app id. Never change it: Inngest keys functions and history by it. */
export const INNGEST_APP_ID = "home-services-reply-bot";

export interface InngestClientOptions {
  /** INNGEST_EVENT_KEY. Not needed against the dev server. */
  readonly eventKey?: string;
  /** INNGEST_DEV: use the local Inngest dev server. */
  readonly isDev?: boolean;
  /** INNGEST_BASE_URL: where the dev server listens, when not on its default port. */
  readonly baseUrl?: string;
  /** Deployed commit, shown in the Inngest dashboard. */
  readonly appVersion?: string;
  /** Tests inject a fetch. */
  readonly fetch?: typeof fetch;
}

export type InngestClient = Inngest;

export function createInngestClient(options: InngestClientOptions = {}): InngestClient {
  return new Inngest({
    id: INNGEST_APP_ID,
    ...(options.eventKey === undefined ? {} : { eventKey: options.eventKey }),
    ...(options.isDev === undefined ? {} : { isDev: options.isDev }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

/** Sends events through Inngest. A failure is a retryable `ExternalServiceError`. */
export function createInngestEventSender(client: InngestClient): EventSender {
  return {
    async send(events: readonly AnyJobEvent[]) {
      if (events.length === 0) return;
      try {
        await client.send(
          events.map((event) => ({ name: event.name, id: event.id, data: event.data })),
        );
      } catch (error) {
        throw new ExternalServiceError("Sending events to Inngest failed.", {
          provider: "inngest",
          cause: error,
          retryable: true,
        });
      }
    },
  };
}

/** Turns our error conventions into the ones Inngest understands. */
export function toInngestError(error: unknown): unknown {
  const described = describeJobError(error);
  if (isPermanentError(error)) {
    return new NonRetriableError(described.message, { cause: described });
  }
  const delay = retryAfterMs(error);
  if (delay !== null) {
    return new RetryAfterError(described.message, Math.max(1000, delay), { cause: described });
  }
  return error;
}

/** The subset of Inngest's step tools the definitions use. */
interface InngestStep {
  run(id: string, fn: () => Promise<unknown>): Promise<unknown>;
  sleep(id: string, time: number): Promise<void>;
  sleepUntil(id: string, time: Date): Promise<void>;
}

function adaptStep(step: InngestStep): StepTools {
  return {
    async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
      const result = await step.run(id, async () => {
        try {
          const value = await fn();
          return value === undefined ? null : value;
        } catch (error) {
          throw toInngestError(error);
        }
      });
      return result as T;
    },
    sleep: (id, durationMs) => step.sleep(id, Math.max(0, Math.round(durationMs))),
    sleepUntil: (id, until) => step.sleepUntil(id, until),
  };
}

function validate(definition: JobDefinition, name: string, data: unknown): unknown {
  if (isCronJob(definition)) return {};
  const parsed = EVENT_CATALOG[definition.trigger.event].safeParse(data);
  if (!parsed.success) {
    throw new InvalidJobPayloadError(
      name,
      parsed.error.issues.map((issue) => issue.path.join(".")),
    );
  }
  return parsed.data;
}

interface InngestEventLike {
  readonly name: string;
  readonly id?: string;
  readonly data: unknown;
}

interface InngestFailureEventLike {
  readonly data: { readonly run_id: string; readonly event: InngestEventLike };
}

/** Builds one Inngest function per definition, for `serve()`. */
export function toInngestFunctions(
  client: InngestClient,
  definitions: readonly JobDefinition[],
  options: { readonly logger?: Logger } = {},
): ReturnType<InngestClient["createFunction"]>[] {
  const baseLogger = options.logger ?? createLogger();
  return definitions.map((definition) => {
    const logger = baseLogger.child({ functionId: definition.id });
    const trigger = isCronJob(definition)
      ? { cron: definition.trigger.cron }
      : { event: definition.trigger.event };
    const debounce = isCronJob(definition) ? undefined : definition.debounce;
    const concurrency = isCronJob(definition) ? undefined : definition.concurrency;
    const hasFailureHandler = definition.onFailure !== undefined;

    const config = {
      id: definition.id,
      name: definition.name,
      retries: definition.retries,
      triggers: [trigger],
      ...(debounce === undefined ? {} : { debounce: { ...debounce } }),
      ...(concurrency === undefined ? {} : { concurrency: [{ ...concurrency }] }),
      ...(!hasFailureHandler
        ? {}
        : {
            onFailure: async ({ event, error }: { event: unknown; error: Error }) => {
              const failure = event as InngestFailureEventLike;
              const original = failure.data.event;
              const runLogger = logger.child({ runId: failure.data.run_id });
              let data: unknown;
              try {
                data = validate(definition, original.name, original.data);
              } catch {
                runLogger.error("job.invalid_payload", { eventName: original.name });
                return;
              }
              await (definition as { onFailure(ctx: unknown): Promise<void> }).onFailure({
                event: { name: original.name, id: original.id ?? null, data },
                error: describeJobError(error),
                runId: failure.data.run_id,
                logger: runLogger,
              });
            },
          }),
    };

    const handler = async (ctx: {
      event: InngestEventLike;
      step: unknown;
      runId: string;
      attempt: number;
    }) => {
      const runLogger = logger.child({ runId: ctx.runId });
      try {
        const data = validate(definition, ctx.event.name, ctx.event.data);
        const event: JobEventEnvelope<unknown> = {
          name: ctx.event.name,
          id: ctx.event.id ?? null,
          data,
        };
        const jobContext: JobContext<unknown> = {
          event,
          step: adaptStep(ctx.step as InngestStep),
          runId: ctx.runId,
          attempt: ctx.attempt,
          logger: runLogger,
        };
        return await (
          definition as { handler(ctx: JobContext<unknown>): Promise<unknown> }
        ).handler(jobContext);
      } catch (error) {
        throw toInngestError(error);
      }
    };

    return client.createFunction(config as never, handler as never);
  });
}
