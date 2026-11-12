import type { IntegrationConnector, IntegrationId } from "@repo/core";

import { createWebhookConnector } from "../webhook/connector";
import type { OAuthApp } from "./common";
import { createGoHighLevelConnector } from "./gohighlevel";
import { createHousecallProConnector } from "./housecall-pro";
import { createHubSpotConnector } from "./hubspot";
import { createJobberConnector } from "./jobber";
import { createServiceTitanConnector, type ServiceTitanApp } from "./servicetitan";

/** A connector whose types are erased: the framework checks credentials and config with its schemas. */
export type AnyConnector = IntegrationConnector<unknown, unknown>;

/** The deployment's vendor apps (from env); null where one is not configured. */
export interface ConnectorApps {
  readonly hubspot: OAuthApp | null;
  readonly gohighlevel: OAuthApp | null;
  readonly jobber: OAuthApp | null;
  readonly servicetitan: ServiceTitanApp | null;
}

export const NO_APPS: ConnectorApps = {
  hubspot: null,
  gohighlevel: null,
  jobber: null,
  servicetitan: null,
};

export type ConnectorRegistry = Readonly<Record<IntegrationId, AnyConnector>>;

export function createConnectorRegistry(apps: ConnectorApps = NO_APPS): ConnectorRegistry {
  return {
    hubspot: createHubSpotConnector({ app: apps.hubspot }),
    gohighlevel: createGoHighLevelConnector({ app: apps.gohighlevel }),
    jobber: createJobberConnector({ app: apps.jobber }),
    housecall_pro: createHousecallProConnector(),
    servicetitan: createServiceTitanConnector(apps.servicetitan),
    webhook: createWebhookConnector(),
  };
}
