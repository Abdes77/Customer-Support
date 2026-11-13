import { z } from "zod";

/**
 * What a WhatsApp connection stores. The credentials are encrypted in
 * `channel_connection_secrets` and only ever decrypted inside the step that calls Meta; the
 * config is the non-secret description of the number, shown in the admin panel.
 */
export const WhatsAppCredentials = z.object({
  /** Business integration system user token from Embedded Signup. */
  accessToken: z.string().min(1),
  /** The two-step verification PIN set when the number was registered. */
  pin: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type WhatsAppCredentials = z.infer<typeof WhatsAppCredentials>;

export const WhatsAppConfig = z.object({
  /** The WhatsApp Business Account (Meta now also calls it the Messaging account). */
  businessAccountId: z.string().min(1),
  phoneNumberId: z.string().min(1),
  displayPhoneNumber: z.string().nullable().default(null),
  verifiedName: z.string().nullable().default(null),
  /** The client's Meta business portfolio, when Embedded Signup reported it. */
  businessPortfolioId: z.string().nullable().default(null),
  qualityRating: z.string().nullable().default(null),
});
export type WhatsAppConfig = z.infer<typeof WhatsAppConfig>;

/** Graph ids are digits; anything else in a path segment is refused. */
export const GraphId = z.string().regex(/^\d{1,30}$/, "Not a Meta id.");
