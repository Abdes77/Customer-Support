/**
 * Outside services on this machine for the channel journeys (C18), started by the app server
 * script: Meta's Graph API (the fakes of C9 and C10 behind one HTTP server, which the app
 * reaches through `DEV_META_GRAPH_URL`) and an IMAP/SMTP server (C11's ImapKit server, which
 * IMAP/SMTP inboxes may use through `DEV_LOCAL_MAIL_PORTS`). The specs read what the app sent
 * and hand mail to the inbox through `/__e2e/...` on the same HTTP server.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";

import { type LocalMailServer, startLocalMailServer } from "@repo/channel-email/testing";
import { createFakeMetaGraph } from "@repo/channel-messenger-instagram/testing";
import { createFakeGraph } from "@repo/channel-whatsapp/testing";

export interface GraphCallRecord {
  readonly method: string;
  readonly path: string;
  readonly token: string | null;
  readonly json: Record<string, unknown> | null;
}

export interface RunningFakes {
  readonly mail: LocalMailServer;
  stop(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakes(options: {
  readonly port: number;
  readonly whatsappPhoneNumberIds: readonly string[];
  readonly mailAddress: string;
  readonly mailPassword: string;
}): Promise<RunningFakes> {
  const whatsapp = createFakeGraph();
  const pages = createFakeMetaGraph();
  const calls: GraphCallRecord[] = [];
  const mail = await startLocalMailServer({
    address: options.mailAddress,
    password: options.mailPassword,
  });

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const raw = await readBody(request);

      // Control endpoints for the specs.
      if (url.pathname === "/__e2e/graph/calls") {
        reply(200, calls);
        return;
      }
      if (url.pathname === "/__e2e/mail/messages") {
        reply(200, mail.messages(url.searchParams.get("folder") ?? "INBOX"));
        return;
      }
      if (url.pathname === "/__e2e/mail/deliver" && request.method === "POST") {
        reply(200, mail.deliver(raw));
        return;
      }

      // Meta's Graph API: WhatsApp's calls name the phone number (or carry
      // `messaging_product: "whatsapp"`); everything else is Messenger and Instagram.
      let json: Record<string, unknown> | null;
      try {
        json = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        json = null;
      }
      const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      calls.push({
        method: request.method ?? "GET",
        path,
        token: headers.get("authorization")?.replace(/^Bearer /, "") ?? null,
        json,
      });
      const isWhatsApp =
        json?.["messaging_product"] === "whatsapp" ||
        options.whatsappPhoneNumberIds.some((id) => path.startsWith(`/${id}`));
      const target = isWhatsApp ? whatsapp : pages;
      const answer = await target.fetch(`https://graph.facebook.com${url.pathname}${url.search}`, {
        method: request.method ?? "GET",
        headers,
        ...(raw.length > 0 ? { body: raw } : {}),
      });
      response.writeHead(answer.status, {
        "content-type": answer.headers.get("content-type") ?? "application/json",
      });
      response.end(Buffer.from(await answer.arrayBuffer()));
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve));

  return {
    mail,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await mail.stop();
    },
  };
}
