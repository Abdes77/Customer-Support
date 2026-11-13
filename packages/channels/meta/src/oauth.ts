import { z } from "zod";

import { ValidationError } from "@repo/core";

import type { GraphClient } from "./graph";

const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
});

export interface ExchangedToken {
  readonly accessToken: string;
  /** Null for a token that does not expire (a business integration system user token). */
  readonly expiresInSeconds: number | null;
}

/**
 * Exchanges the code from Embedded Signup or Facebook Login for Business for a business
 * token (`GET /oauth/access_token`, server to server; the code is valid for 30 seconds).
 * The app secret travels as Meta documents it, in the query of this one request, which is
 * never logged.
 */
export async function exchangeCode(
  graph: GraphClient,
  options: {
    readonly appId: string;
    readonly appSecret: string;
    readonly code: string;
    readonly redirectUri?: string;
  },
): Promise<ExchangedToken> {
  if (options.code.length === 0 || options.code.length > 2000) {
    throw new ValidationError("Invalid authorization code.");
  }
  const result = await graph.request(
    {
      method: "GET",
      path: "/oauth/access_token",
      query: {
        client_id: options.appId,
        client_secret: options.appSecret,
        code: options.code,
        ...(options.redirectUri === undefined ? {} : { redirect_uri: options.redirectUri }),
      },
    },
    TokenResponse,
  );
  return {
    accessToken: result.access_token,
    expiresInSeconds: result.expires_in ?? null,
  };
}

/**
 * Turns a short-lived user token (Facebook Login with a user-token configuration) into a
 * long-lived one (`grant_type=fb_exchange_token`, about 60 days). Page tokens read with a
 * long-lived user token do not expire. A business integration system user token (the
 * System-user configuration) already does not expire and needs no exchange.
 */
export async function exchangeForLongLivedToken(
  graph: GraphClient,
  options: { readonly appId: string; readonly appSecret: string; readonly token: string },
): Promise<ExchangedToken> {
  const result = await graph.request(
    {
      method: "GET",
      path: "/oauth/access_token",
      query: {
        grant_type: "fb_exchange_token",
        client_id: options.appId,
        client_secret: options.appSecret,
        fb_exchange_token: options.token,
      },
    },
    TokenResponse,
  );
  return { accessToken: result.access_token, expiresInSeconds: result.expires_in ?? null };
}
