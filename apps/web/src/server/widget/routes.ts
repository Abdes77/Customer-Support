import type { WidgetPhoto, WidgetService } from "@repo/channel-widget/server";

import {
  bearerToken,
  edgeLimit,
  errorResponse,
  invalid,
  MAX_UPLOAD_BYTES,
  outcomeResponse,
  readCapped,
  readJson,
  requestInfo,
  tooLarge,
  withWidget,
} from "./http";

/*
 * The handlers behind `/api/widget/v1/*`, written against an injectable service so they can
 * be tested without the app. Each route file binds one of these to the process's service.
 */

type Get = () => WidgetService | null;

export function configHandler(getWidget?: Get) {
  return (request: Request) =>
    withWidget(
      request,
      "config",
      async (widget) => {
        const limited = edgeLimit(request, "config");
        if (limited !== null) return limited;
        const key = new URL(request.url).searchParams.get("key") ?? "";
        const outcome = await widget.config(key, requestInfo(request));
        // Cached briefly by the visitor's browser: one request per page view at most.
        return outcomeResponse(request, outcome, "private, max-age=60");
      },
      getWidget,
    );
}

export function sessionHandler(getWidget?: Get) {
  return (request: Request) =>
    withWidget(
      request,
      "session",
      async (widget) => {
        const limited = edgeLimit(request, "session");
        if (limited !== null) return limited;
        const body = await readJson(request);
        if (!body.ok)
          return errorResponse(request, body.status, body.status === 413 ? tooLarge : invalid);
        return outcomeResponse(
          request,
          await widget.startSession(body.value, requestInfo(request)),
        );
      },
      getWidget,
    );
}

export function profileHandler(getWidget?: Get) {
  return (request: Request) =>
    withWidget(
      request,
      "profile",
      async (widget) => {
        const body = await readJson(request);
        if (!body.ok)
          return errorResponse(request, body.status, body.status === 413 ? tooLarge : invalid);
        return outcomeResponse(
          request,
          await widget.saveProfile(bearerToken(request), body.value, requestInfo(request)),
        );
      },
      getWidget,
    );
}

export function listMessagesHandler(getWidget?: Get) {
  return (request: Request) =>
    withWidget(
      request,
      "messages.list",
      async (widget) => {
        const after = new URL(request.url).searchParams.get("after");
        return outcomeResponse(
          request,
          await widget.listMessages(bearerToken(request), after, requestInfo(request)),
        );
      },
      getWidget,
    );
}

export function postMessageHandler(getWidget?: Get) {
  return (request: Request) =>
    withWidget(
      request,
      "messages.post",
      async (widget) => {
        const token = bearerToken(request);
        const type = request.headers.get("content-type") ?? "";
        if (type.startsWith("multipart/form-data")) {
          const bytes = await readCapped(request, MAX_UPLOAD_BYTES);
          if (bytes === null) return errorResponse(request, 413, tooLarge);
          let form: FormData;
          try {
            form = await new Response(bytes, { headers: { "content-type": type } }).formData();
          } catch {
            return errorResponse(request, 400, invalid);
          }
          const file = form.get("photo");
          let photo: WidgetPhoto | null = null;
          if (file !== null) {
            if (typeof file === "string") return errorResponse(request, 400, invalid);
            photo = {
              bytes: new Uint8Array(await file.arrayBuffer()),
              fileName: file.name || null,
            };
          }
          const text = form.get("text");
          return outcomeResponse(
            request,
            await widget.postMessage(
              token,
              { id: form.get("id"), text: typeof text === "string" ? text : null, photo },
              requestInfo(request),
            ),
          );
        }
        const body = await readJson(request);
        if (!body.ok)
          return errorResponse(request, body.status, body.status === 413 ? tooLarge : invalid);
        const value = (body.value ?? {}) as { id?: unknown; text?: unknown };
        return outcomeResponse(
          request,
          await widget.postMessage(
            token,
            { id: value.id, text: value.text ?? null, photo: null },
            requestInfo(request),
          ),
        );
      },
      getWidget,
    );
}
