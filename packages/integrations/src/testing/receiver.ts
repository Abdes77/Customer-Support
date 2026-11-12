import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { verifyWebhookSignature } from "../webhook/sign";

/*
 * A local webhook receiver (plain HTTP on 127.0.0.1), standing in for Zapier, Make or the
 * agency's own system: it records every request, checks the signature with the secret it is
 * given, and answers with the statuses it is told to (then 200).
 */

export interface ReceivedWebhook {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly json: unknown;
  readonly signature: ReturnType<typeof verifyWebhookSignature> | null;
}

export interface WebhookReceiver {
  readonly url: string;
  readonly port: number;
  readonly received: ReceivedWebhook[];
  /** The statuses of the next answers, in order (then 200). */
  answerWith(...statuses: number[]): void;
  /** The secret signatures are checked against (null: not checked). */
  setSecret(secret: string | null): void;
  close(): Promise<void>;
}

export async function startWebhookReceiver(
  options: {
    readonly secret?: string | null;
    readonly now?: () => Date;
    readonly path?: string;
  } = {},
): Promise<WebhookReceiver> {
  const received: ReceivedWebhook[] = [];
  const queue: number[] = [];
  let secret = options.secret ?? null;
  const now = options.now ?? (() => new Date());
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers[name] = value;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        parsed = null;
      }
      received.push({
        headers,
        body,
        json: parsed,
        signature:
          secret === null
            ? null
            : verifyWebhookSignature(secret, headers["x-hsrb-signature"] ?? null, body, now()),
      });
      const status = queue.shift() ?? 200;
      response.writeHead(
        status,
        status >= 300 && status < 400 ? { location: "http://127.0.0.1:1/x" } : {},
      );
      response.end(status === 200 ? '{"ok":true}' : "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}${options.path ?? "/hooks/lead"}`,
    port,
    received,
    answerWith: (...statuses) => queue.push(...statuses),
    setSecret: (value) => {
      secret = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
