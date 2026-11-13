import { describe, expect, it } from "vitest";

import { buildSettingsView, findSetting } from "@repo/settings";

import { maskEmail, maskEntry, maskPhone, maskUrl, sensitiveSummary } from "./mask";
import { isSameOriginHeaders } from "./origin";
import { toFailure } from "./result";
import { toScreenView } from "./settings-view";
import { createLogger, NotFoundError, TenantAccessError, ValidationError } from "@repo/core";

/* The admin panel's server helpers (C15) that decide what reaches the browser. */

const headers = (values: Record<string, string>) => new Headers(values);
const quiet = createLogger({ level: "error", sink: () => {} });

describe("cross-site check for server actions", () => {
  const app = "https://admin.example.com";
  it("lets same-origin requests through", () => {
    expect(
      isSameOriginHeaders(
        headers({ origin: app, host: "admin.example.com", "sec-fetch-site": "same-origin" }),
        app,
      ),
    ).toBe(true);
    expect(
      isSameOriginHeaders(
        headers({ origin: "http://127.0.0.1:3100", host: "127.0.0.1:3100" }),
        undefined,
      ),
    ).toBe(true);
  });
  it("refuses another site, and a sibling subdomain", () => {
    expect(
      isSameOriginHeaders(
        headers({ origin: "https://evil.example", host: "admin.example.com" }),
        app,
      ),
    ).toBe(false);
    expect(
      isSameOriginHeaders(
        headers({
          origin: "https://other.example.com",
          host: "admin.example.com",
          "sec-fetch-site": "same-site",
        }),
        app,
      ),
    ).toBe(false);
    expect(
      isSameOriginHeaders(
        headers({ host: "admin.example.com", "sec-fetch-site": "cross-site" }),
        app,
      ),
    ).toBe(false);
  });
});

describe("masking of sensitive values", () => {
  it("never shows a whole address or number", () => {
    expect(maskEmail("dana@example.com")).toBe("d•••@example.com");
    expect(maskPhone("+15125550142")).toBe("••• 0142");
    expect(maskUrl("https://hooks.zapier.com/hooks/catch/123/abc")).toBe("hooks.zapier.com/•••");
  });

  it("masks an alert contact by its field description", () => {
    const definition = findSetting("emergency.escalation_chain")!;
    const item = definition.field.kind === "list" ? definition.field.item : undefined;
    const masked = maskEntry(
      {
        name: "Dana",
        phone: "+15125550142",
        email: "dana@example.com",
        alert_by: ["sms", "email"],
      },
      0,
      item,
    );
    expect(masked.label).toBe("Dana");
    expect(masked.details.join(" ")).not.toContain("5125550142");
    expect(masked.details.join(" ")).not.toContain("dana@");
    expect(masked.details).toContain("Text message, Email");
    // Unknown text of a private entry stays hidden.
    expect(maskEntry({ name: "Zap", secret: "s3cr3t" }, 0).details).toEqual(["secret set"]);
  });

  it("summarizes", () => {
    expect(sensitiveSummary([])).toBe("None");
    expect(sensitiveSummary([{}, {}])).toBe("2 entries");
    expect(sensitiveSummary("")).toBe("Not set");
    expect(sensitiveSummary("x")).toBe("Set");
  });
});

describe("the settings screen's view model", () => {
  it("sends no value of a sensitive setting to the browser", () => {
    const contact = {
      name: "Dana",
      phone: "+15125550142",
      email: "dana@example.com",
      alert_by: ["sms"],
    };
    const view = buildSettingsView(
      "business",
      {
        business: [
          { key: "emergency.escalation_chain", value: [contact], version: 3, updatedAt: null },
          { key: "persona.bot_name", value: "Riley", version: 1, updatedAt: null },
        ],
      },
      { editor: { kind: "user", role: "agency_member" } },
    );
    const screen = toScreenView(view);
    const json = JSON.stringify(screen);
    expect(json).not.toContain("5125550142");
    expect(json).not.toContain("dana@example.com");
    const chain = screen.entries.find((entry) => entry.key === "emergency.escalation_chain")!;
    expect(chain).toMatchObject({
      sensitive: true,
      value: null,
      summary: "1 entry",
      source: "business",
    });
    expect(chain.override).toMatchObject({ version: 3, value: null });
    const name = screen.entries.find((entry) => entry.key === "persona.bot_name")!;
    expect(name).toMatchObject({
      sensitive: false,
      value: "Riley",
      source: "business",
      editable: true,
    });
    // Every declared setting is on the screen.
    expect(screen.entries.length).toBe(view.entries.length);
  });
});

describe("action errors", () => {
  it("turns errors into sentences without internals", () => {
    expect(
      toFailure(
        new ValidationError("Bad.", {
          details: { problems: [{ field: "name", message: "Enter the name." }] },
        }),
        quiet,
        "t",
      ),
    ).toEqual({
      ok: false,
      error: "Bad.",
      problems: [{ path: ["name"], message: "Enter the name." }],
    });
    expect(toFailure(new NotFoundError("Business not found."), quiet, "t")).toEqual({
      ok: false,
      error: "Business not found.",
    });
    expect(toFailure(new TenantAccessError("secret detail"), quiet, "t")).toEqual({
      ok: false,
      error: "You do not have permission to do that.",
    });
    const unexpected = toFailure(new Error("connection string postgres://..."), quiet, "t");
    expect(JSON.stringify(unexpected)).not.toContain("postgres");
  });
});
