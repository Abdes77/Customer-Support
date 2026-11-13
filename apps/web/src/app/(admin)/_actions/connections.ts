"use server";

import { revalidatePath } from "next/cache";

import { getDatabase } from "@repo/db";

import { type ActionResult, runAction } from "@/server/admin";
import { type ConnectionActions, createConnectionActions } from "@/server/connections";
import { getEmail } from "@/server/email";
import { getIntegrations } from "@/server/integrations";
import { getMetaPages } from "@/server/meta-pages";
import { getScheduling } from "@/server/scheduling";
import { getWhatsApp } from "@/server/whatsapp";

/*
 * The connection pages' server actions (C16): the cross-site check and the session
 * (`runAction`), then `@/server/connections`, which allows agency staff of the business only.
 */

const actions = (): ConnectionActions =>
  createConnectionActions({
    db: getDatabase(),
    whatsapp: getWhatsApp(),
    metaPages: getMetaPages(),
    email: getEmail(),
    scheduling: getScheduling(),
    integrations: getIntegrations(),
  });

function refresh(input: unknown): void {
  const id = (input as { businessId?: unknown } | null)?.businessId;
  if (typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)) {
    revalidatePath(`/businesses/${id}/channels`);
    revalidatePath(`/businesses/${id}/integrations`);
  }
}

type Value<K extends keyof ConnectionActions> = Awaited<ReturnType<ConnectionActions[K]>>;

export async function widgetSetUpAction(
  input: unknown,
): Promise<ActionResult<Value<"widgetSetUp">>> {
  return runAction("connections.widgetSetUp", async (session) => {
    const value = await actions().widgetSetUp(session, input);
    refresh(input);
    return value;
  });
}

export async function widgetRotateAction(
  input: unknown,
): Promise<ActionResult<Value<"widgetRotate">>> {
  return runAction("connections.widgetRotate", async (session) => {
    const value = await actions().widgetRotate(session, input);
    refresh(input);
    return value;
  });
}

export async function widgetEnableAction(
  input: unknown,
): Promise<ActionResult<Value<"widgetEnable">>> {
  return runAction("connections.widgetEnable", async (session) => {
    const value = await actions().widgetEnable(session, input);
    refresh(input);
    return value;
  });
}

export async function whatsappDisconnectAction(
  input: unknown,
): Promise<ActionResult<Value<"whatsappDisconnect">>> {
  return runAction("connections.whatsappDisconnect", async (session) => {
    const value = await actions().whatsappDisconnect(session, input);
    refresh(input);
    return value;
  });
}

export async function whatsappSyncTemplatesAction(
  input: unknown,
): Promise<ActionResult<Value<"whatsappSyncTemplates">>> {
  return runAction("connections.whatsappSyncTemplates", async (session) => {
    const value = await actions().whatsappSyncTemplates(session, input);
    refresh(input);
    return value;
  });
}

export async function whatsappAddSuggestedTemplateAction(
  input: unknown,
): Promise<ActionResult<Value<"whatsappAddSuggestedTemplate">>> {
  return runAction("connections.whatsappAddSuggestedTemplate", async (session) => {
    const value = await actions().whatsappAddSuggestedTemplate(session, input);
    refresh(input);
    return value;
  });
}

export async function metaDisconnectAction(
  input: unknown,
): Promise<ActionResult<Value<"metaDisconnect">>> {
  return runAction("connections.metaDisconnect", async (session) => {
    const value = await actions().metaDisconnect(session, input);
    refresh(input);
    return value;
  });
}

export async function emailSyncAction(input: unknown): Promise<ActionResult<Value<"emailSync">>> {
  return runAction("connections.emailSync", async (session) => {
    const value = await actions().emailSync(session, input);
    refresh(input);
    return value;
  });
}

export async function emailDisconnectAction(
  input: unknown,
): Promise<ActionResult<Value<"emailDisconnect">>> {
  return runAction("connections.emailDisconnect", async (session) => {
    const value = await actions().emailDisconnect(session, input);
    refresh(input);
    return value;
  });
}

export async function calendarListAction(
  input: unknown,
): Promise<ActionResult<Value<"calendarList">>> {
  return runAction("connections.calendarList", async (session) => {
    const value = await actions().calendarList(session, input);
    return value;
  });
}

export async function calendarSetAction(
  input: unknown,
): Promise<ActionResult<Value<"calendarSet">>> {
  return runAction("connections.calendarSet", async (session) => {
    const value = await actions().calendarSet(session, input);
    refresh(input);
    return value;
  });
}

export async function calendarDisconnectAction(
  input: unknown,
): Promise<ActionResult<Value<"calendarDisconnect">>> {
  return runAction("connections.calendarDisconnect", async (session) => {
    const value = await actions().calendarDisconnect(session, input);
    refresh(input);
    return value;
  });
}

export async function crmUpdateConfigAction(
  input: unknown,
): Promise<ActionResult<Value<"crmUpdateConfig">>> {
  return runAction("connections.crmUpdateConfig", async (session) => {
    const value = await actions().crmUpdateConfig(session, input);
    refresh(input);
    return value;
  });
}

export async function crmTestAction(input: unknown): Promise<ActionResult<Value<"crmTest">>> {
  return runAction("connections.crmTest", async (session) => {
    const value = await actions().crmTest(session, input);
    refresh(input);
    return value;
  });
}

export async function crmDisconnectAction(
  input: unknown,
): Promise<ActionResult<Value<"crmDisconnect">>> {
  return runAction("connections.crmDisconnect", async (session) => {
    const value = await actions().crmDisconnect(session, input);
    refresh(input);
    return value;
  });
}

export async function deliveryRetryAction(
  input: unknown,
): Promise<ActionResult<Value<"deliveryRetry">>> {
  return runAction("connections.deliveryRetry", async (session) => {
    const value = await actions().deliveryRetry(session, input);
    refresh(input);
    return value;
  });
}

export async function mappingPreviewAction(
  input: unknown,
): Promise<ActionResult<Value<"mappingPreview">>> {
  return runAction("connections.mappingPreview", async (session) => {
    const value = await actions().mappingPreview(session, input);
    return value;
  });
}

export async function webhookTestAction(
  input: unknown,
): Promise<ActionResult<Value<"webhookTest">>> {
  return runAction("connections.webhookTest", async (session) => {
    const value = await actions().webhookTest(session, input);
    refresh(input);
    return value;
  });
}

export async function webhookRevealAction(
  input: unknown,
): Promise<ActionResult<Value<"webhookReveal">>> {
  return runAction("connections.webhookReveal", async (session) => {
    const value = await actions().webhookReveal(session, input);
    return value;
  });
}

export async function webhookRotateAction(
  input: unknown,
): Promise<ActionResult<Value<"webhookRotate">>> {
  return runAction("connections.webhookRotate", async (session) => {
    const value = await actions().webhookRotate(session, input);
    refresh(input);
    return value;
  });
}
