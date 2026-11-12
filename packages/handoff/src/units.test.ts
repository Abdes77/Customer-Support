import { describe, expect, it } from "vitest";

import { settingsWith } from "@repo/settings";

import { timeZoneOfPhone } from "./area-codes";
import { ackToken, escalationTwiml, parseAckToken } from "./alerts/deliver";
import { alertSendTime, recipientsFor } from "./alerts/plan";
import { renderLeadAlert } from "./alerts/render";
import { planSteps, chainFromSettings, policyFromSettings } from "./emergency/policy";
import type { ConversationFacts } from "./facts";
import { nudgeDelayMinutes, windowAllows } from "./follow-ups/plan";
import { matchKeyword } from "./opt-out";
import { inertLinks, plainBlock, plainLine } from "./text";
import {
  customerTimeZone,
  followUpsNeedBusinessHours,
  nextAllowedMoment,
  parseIsoDuration,
  quietHoursEnd,
} from "./time";
import { createRecordingTransports } from "./testing";
import { createTwilioClient, twilioSignature, verifyTwilioSignature } from "./transports/twilio";
import { createFakeTwilio, createFakeWhatsAppGraph } from "./testing";
import { createWhatsAppAlertTransport, whatsappParameter } from "./transports/whatsapp";

const values = settingsWith({}).values;

describe("customer time zone", () => {
  it("maps US area codes to their zone and leaves the rest to the business", () => {
    expect(timeZoneOfPhone("+15125550199")).toBe("America/Chicago");
    expect(timeZoneOfPhone("+12125550100")).toBe("America/New_York");
    expect(timeZoneOfPhone("+14155550100")).toBe("America/Los_Angeles");
    expect(timeZoneOfPhone("+16025550100")).toBe("America/Phoenix");
    expect(timeZoneOfPhone("+13035550100")).toBe("America/Denver");
    expect(timeZoneOfPhone("+19075550100")).toBe("America/Anchorage");
    expect(timeZoneOfPhone("+18085550100")).toBe("Pacific/Honolulu");
    // Large codes, and split codes by the zone of most of their numbers.
    expect(timeZoneOfPhone("+13015550100")).toBe("America/New_York");
    expect(timeZoneOfPhone("+14025550100")).toBe("America/Chicago");
    expect(timeZoneOfPhone("+14055550100")).toBe("America/Chicago");
    expect(timeZoneOfPhone("+19315550100")).toBe("America/Chicago");
    expect(timeZoneOfPhone("+13085550100")).toBe("America/Chicago");
    expect(timeZoneOfPhone("+18505550100")).toBe("America/Chicago");
    expect(timeZoneOfPhone("+14485550100")).toBe("America/Chicago");
    expect(timeZoneOfPhone("+19155550100")).toBe("America/Denver");
    // Toll-free, Canadian and foreign numbers are unknown.
    expect(timeZoneOfPhone("+18005550100")).toBeNull();
    expect(timeZoneOfPhone("+14165550100")).toBeNull();
    expect(timeZoneOfPhone("+447700900123")).toBeNull();
    expect(timeZoneOfPhone(null)).toBeNull();
  });

  it("prefers the contact's zone, then the area code when the setting asks, then the business", () => {
    const base = { phone: "+14155550100", businessTimeZone: "America/New_York" };
    expect(
      customerTimeZone({ ...base, contactTimeZone: "America/Denver", mode: "phone_area_code" }),
    ).toBe("America/Denver");
    expect(customerTimeZone({ ...base, contactTimeZone: null, mode: "phone_area_code" })).toBe(
      "America/Los_Angeles",
    );
    expect(customerTimeZone({ ...base, contactTimeZone: null, mode: "business" })).toBe(
      "America/New_York",
    );
    expect(customerTimeZone({ ...base, contactTimeZone: "Not/AZone", mode: "business" })).toBe(
      "America/New_York",
    );
  });
});

describe("quiet hours and allowed moments", () => {
  const quiet = { enabled: true, start: "21:00", end: "08:00" };

  it("finds the end of quiet hours across midnight, in the customer's zone", () => {
    // 10:30 PM in Chicago (04:30Z next day) → 8:00 AM Chicago.
    expect(quietHoursEnd(new Date("2026-11-11T04:30:00Z"), "America/Chicago", quiet)).toEqual(
      new Date("2026-11-11T14:00:00Z"),
    );
    // 6:00 AM in Chicago → 8:00 AM the same day.
    expect(quietHoursEnd(new Date("2026-11-11T12:00:00Z"), "America/Chicago", quiet)).toEqual(
      new Date("2026-11-11T14:00:00Z"),
    );
    // Noon is not quiet; a disabled window never is.
    expect(quietHoursEnd(new Date("2026-11-11T18:00:00Z"), "America/Chicago", quiet)).toBeNull();
    expect(
      quietHoursEnd(new Date("2026-11-11T04:30:00Z"), "America/Chicago", {
        ...quiet,
        enabled: false,
      }),
    ).toBeNull();
  });

  it("keeps the wall clock on a daylight-saving night", () => {
    // Sunday March 8, 2026: clocks spring forward at 2:00 AM in New York. At 1:00 AM EST
    // (06:00Z) quiet hours end at 8:00 AM EDT (12:00Z).
    expect(quietHoursEnd(new Date("2026-03-08T06:00:00Z"), "America/New_York", quiet)).toEqual(
      new Date("2026-03-08T12:00:00Z"),
    );
    // Sunday November 1, 2026: clocks fall back. 1:30 AM EDT (05:30Z) → 8:00 AM EST (13:00Z).
    expect(quietHoursEnd(new Date("2026-11-01T05:30:00Z"), "America/New_York", quiet)).toEqual(
      new Date("2026-11-01T13:00:00Z"),
    );
  });

  it("moves a nudge out of quiet hours, and into business hours when it has to wait for them", () => {
    const input = {
      values,
      customerTimeZone: "America/Chicago",
      businessTimeZone: "America/Chicago",
    };
    // Tuesday 11 PM in Chicago (05:00Z Wed) → 8:00 AM, which is also opening time.
    expect(
      nextAllowedMoment({
        ...input,
        from: new Date("2026-11-11T05:00:00Z"),
        businessHoursOnly: false,
      }),
    ).toEqual(new Date("2026-11-11T14:00:00Z"));
    // Saturday noon: allowed any time outside quiet hours...
    const saturday = new Date("2026-11-14T18:00:00Z");
    expect(nextAllowedMoment({ ...input, from: saturday, businessHoursOnly: false })).toEqual(
      saturday,
    );
    // ...but with business hours only, Monday 8:00 AM.
    expect(nextAllowedMoment({ ...input, from: saturday, businessHoursOnly: true })).toEqual(
      new Date("2026-11-16T14:00:00Z"),
    );
    // A customer two zones west: 7:30 AM in Los Angeles is still quiet for them.
    expect(
      nextAllowedMoment({
        ...input,
        customerTimeZone: "America/Los_Angeles",
        from: new Date("2026-11-10T15:30:00Z"),
        businessHoursOnly: true,
      }),
    ).toEqual(new Date("2026-11-10T16:00:00Z"));
    // Wednesday November 11 is Veterans Day: closed, so Thursday 8:00 AM in Chicago.
    expect(
      nextAllowedMoment({
        ...input,
        from: new Date("2026-11-11T15:30:00Z"),
        businessHoursOnly: true,
      }),
    ).toEqual(new Date("2026-11-12T14:00:00Z"));
  });

  it("waits for business hours when the after-hours mode keeps the bot quiet", () => {
    expect(followUpsNeedBusinessHours(values)).toBe(false);
    expect(
      followUpsNeedBusinessHours({ ...values, "follow_up.send_window": "business_hours" }),
    ).toBe(true);
    expect(followUpsNeedBusinessHours({ ...values, "hours.after_hours_mode": "silent" })).toBe(
      true,
    );
    expect(followUpsNeedBusinessHours({ ...values, "hours.after_hours_mode": "auto_reply" })).toBe(
      true,
    );
  });

  it("holds qualified-lead alerts overnight only for the kinds the setting covers", () => {
    const held = {
      ...values,
      "alerts.hold_overnight": { enabled: true, start: "21:00", end: "07:00" },
    };
    const night = new Date("2026-11-11T04:00:00Z"); // 10 PM in Chicago
    expect(alertSendTime(held, "lead_qualified", "America/Chicago", night)).toEqual(
      new Date("2026-11-11T13:00:00Z"),
    );
    expect(alertSendTime(held, "handoff", "America/Chicago", night)).toEqual(night);
    expect(alertSendTime(held, "emergency", "America/Chicago", night)).toEqual(night);
    expect(alertSendTime(values, "lead_qualified", "America/Chicago", night)).toEqual(night);
  });
});

describe("follow-up cadence", () => {
  it("takes the n-th wait and repeats the last one", () => {
    expect(nudgeDelayMinutes([120, 1200], 1)).toBe(120);
    expect(nudgeDelayMinutes([120, 1200], 2)).toBe(1200);
    expect(nudgeDelayMinutes([120, 1200], 5)).toBe(1200);
  });

  it("respects the channel's window: templates on WhatsApp only when one is set", () => {
    const last = new Date("2026-11-10T16:00:00Z");
    const inside = new Date("2026-11-11T15:00:00Z");
    const outside = new Date("2026-11-11T17:00:00Z");
    expect(windowAllows("whatsapp", last, inside, values)).toBe(true);
    expect(windowAllows("whatsapp", last, outside, values)).toBe(false);
    expect(
      windowAllows("whatsapp", last, outside, {
        ...values,
        "channels.whatsapp.follow_up_template": "nudge_v1",
      }),
    ).toBe(true);
    expect(windowAllows("messenger", last, outside, values)).toBe(false);
    expect(windowAllows("email", last, outside, values)).toBe(true);
  });

  it("reads ISO durations", () => {
    expect(parseIsoDuration("PT2H")).toBe(7_200_000);
    expect(parseIsoDuration("P1D")).toBe(86_400_000);
    expect(parseIsoDuration("P1DT30M")).toBe(86_400_000 + 1_800_000);
    expect(parseIsoDuration("PT")).toBeNull();
    expect(parseIsoDuration("tomorrow")).toBeNull();
    expect(parseIsoDuration("P0D")).toBeNull();
  });
});

describe("opt-out words", () => {
  const keywords = values["follow_up.opt_out_keywords"];

  it("matches a message that consists of a keyword, whatever its case and punctuation", () => {
    expect(matchKeyword("STOP", keywords)).toBe("stop");
    expect(matchKeyword(" Stop. ", keywords)).toBe("stop");
    expect(matchKeyword("stop!!", keywords)).toBe("stop");
    expect(matchKeyword("Opt  out", keywords)).toBe("opt out");
    expect(matchKeyword("“Unsubscribe”", keywords)).toBe("unsubscribe");
  });

  it("matches the short requests that mean the same", () => {
    expect(matchKeyword("Please stop", keywords)).toBe("stop");
    expect(matchKeyword("STOP texting me", keywords)).toBe("stop");
    expect(matchKeyword("stop messaging me please!", keywords)).toBe("stop");
    expect(matchKeyword("Unsubscribe me", keywords)).toBe("unsubscribe");
    expect(matchKeyword("remove me please", keywords)).toBe("remove me");
    expect(matchKeyword("Start please", values["follow_up.opt_in_keywords"])).toBe("start");
  });

  it("does not match a sentence that merely contains one", () => {
    expect(matchKeyword("please don't stop the work", keywords)).toBeNull();
    expect(matchKeyword("Can you stop by tomorrow?", keywords)).toBeNull();
    expect(matchKeyword("stop the leak please", keywords)).toBeNull();
    expect(matchKeyword("please don't stop", keywords)).toBeNull();
    expect(matchKeyword("the water won't stop", keywords)).toBeNull();
    expect(matchKeyword("", keywords)).toBeNull();
    expect(matchKeyword(null, keywords)).toBeNull();
  });
});

describe("plain text for alerts", () => {
  it("flattens customer text, strips markup and makes links inert", () => {
    expect(plainLine("Hi <b>there</b>\nvisit https://evil.example/x now")).toBe(
      "Hi ‹b›there‹/b› visit https[:]//evil[.]example/x now",
    );
    expect(inertLinks("call me at www.scam.com")).toBe("call me at www[.]scam[.]com");
    expect(plainLine("a".repeat(300), 20)).toHaveLength(20);
    expect(plainLine("tab\there‮reversed")).toBe("tab here reversed");
    expect(plainBlock("## Who\n<script>x</script>\n\n\n\nnext")).toBe(
      "## Who\n‹script›x‹/script›\n\nnext",
    );
  });

  it("renders a lead alert from the settings with the conversation link and no customer links", () => {
    const facts: ConversationFacts = {
      conversationId: "5d7f9b1c-3e5a-4c7e-9a1b-2c4e6f8a0b04" as never,
      contactId: "7e9a1c3d-5f7b-4d9f-8b3d-4e6f8a0c2d05" as never,
      channel: "whatsapp",
      status: "open",
      metadata: {},
      lastInboundAt: null,
      business: { name: "Summit Roofing", timeZone: "America/Chicago" },
      contact: {
        name: "Pat <b>Lee</b>",
        phone: "+15125550199",
        email: null,
        timeZone: null,
        optedOutAt: null,
        isBlocked: false,
      },
      lead: {
        id: "1c3e5a7b-9d1f-4b3d-a5f7-6a8c0e2f4b06" as never,
        status: "qualified",
        routingOutcome: "book_meeting",
        score: 84,
        band: "hot",
        service: "roof leak, see http://evil.example",
      },
      report: { summary: "Hot lead; click https://phish.example", markdown: "## Who\nPat" },
    };
    const rendered = renderLeadAlert({
      kind: "lead_qualified",
      facts,
      values,
      link: "https://app.example/inbox/5d7f9b1c-3e5a-4c7e-9a1b-2c4e6f8a0b04",
    });
    expect(rendered.sms).toBe(
      "Hot lead for Summit Roofing (84): Pat ‹b›Lee‹/b›, roof leak, see http[:]//evil[.]example, via WhatsApp. https://app.example/inbox/5d7f9b1c-3e5a-4c7e-9a1b-2c4e6f8a0b04",
    );
    expect(rendered.email.text).toContain("Summary: Hot lead; click https[:]//phish[.]example");
    expect(rendered.email.text).not.toContain("https://phish");
    const hidden = renderLeadAlert({
      kind: "handoff",
      facts,
      values: { ...values, "alerts.include_contact_details": false },
      link: "https://app.example/inbox/x",
    });
    expect(hidden.sms.startsWith("Needs a person: ")).toBe(true);
    expect(hidden.sms).not.toContain("Pat");
    expect(hidden.email.text).not.toContain("+15125550199");
  });

  it("chooses recipients by their own events and the business's switch", () => {
    const people = {
      ...values,
      "alerts.recipients": [
        {
          name: "Owner",
          email: "owner@example.com",
          phone: "+15125550100",
          channels: ["sms" as const, "email" as const],
          events: [],
          active: true,
        },
        {
          name: "Office",
          email: "office@example.com",
          phone: "",
          channels: ["email" as const],
          events: ["handoff" as const],
          active: true,
        },
        {
          name: "Away",
          email: "away@example.com",
          phone: "",
          channels: ["email" as const],
          events: [],
          active: false,
        },
      ],
    };
    expect(recipientsFor(people, "lead_qualified").map((r) => r.name)).toEqual(["Owner"]);
    expect(recipientsFor(people, "handoff").map((r) => r.name)).toEqual(["Owner", "Office"]);
    // Switched off for the business: nobody.
    expect(recipientsFor(people, "lead_disqualified")).toEqual([]);
  });
});

describe("emergency chain plan", () => {
  it("alerts, waits, calls each person in order, for every round, then the agency", () => {
    const chainValues = {
      ...values,
      "emergency.escalation_chain": [
        { name: "Ann", phone: "+15125550101", email: "", alert_by: ["sms" as const] },
        {
          name: "Bob",
          phone: "+15125550102",
          email: "bob@example.com",
          alert_by: ["whatsapp" as const, "email" as const],
        },
      ],
      "emergency.fallback_contacts": [
        { name: "Agency", phone: "+15125550109", email: "", alert_by: ["sms" as const] },
      ],
      "emergency.rounds": 2,
    };
    const chain = chainFromSettings(chainValues);
    const steps = planSteps(chain, policyFromSettings(chainValues));
    expect(steps.map((step) => `${step.kind}:${chain[step.contact]!.name}:${step.round}`)).toEqual([
      "alert:Ann:0",
      "call:Ann:0",
      "alert:Bob:0",
      "call:Bob:0",
      "alert:Ann:1",
      "call:Ann:1",
      "alert:Bob:1",
      "call:Bob:1",
      "alert:Agency:2",
      "call:Agency:2",
    ]);
    expect(steps[0]?.waitMinutes).toBe(5);
    expect(steps[1]?.waitMinutes).toBe(2);
    // Without calls, each person is alerted once per round and nobody is called.
    const noCalls = planSteps(chain, {
      ...policyFromSettings(chainValues),
      call: false,
      rounds: 1,
    });
    expect(noCalls.map((step) => step.kind)).toEqual(["alert", "alert", "alert"]);
    // Email is only used for a person with an address.
    expect(
      chainFromSettings({
        ...chainValues,
        "emergency.escalation_chain": [
          {
            name: "Cy",
            phone: "+15125550103",
            email: "",
            alert_by: ["email" as const, "sms" as const],
          },
        ],
      })[0]?.alertBy,
    ).toEqual(["sms"]);
  });

  it("builds an escaped call with a keypress and never a customer's words", () => {
    const xml = escalationTwiml({
      businessName: "Summit <Roofing> & Co",
      emergencyLabel: "Gas smell",
      gatherUrl: "https://app.example/api/handoff/twilio/voice?alert=a&t=b",
    });
    expect(xml).toContain("Summit &lt;Roofing&gt; &amp; Co");
    expect(xml).toContain('action="https://app.example/api/handoff/twilio/voice?alert=a&amp;t=b"');
    expect(xml).toContain('numDigits="1"');
  });

  it("reads only well-formed acknowledgement tokens", () => {
    const id = "6f8b0d2f-4b6d-4f8b-a0d2-7b9d1f3b5d15";
    const secret = "A".repeat(43);
    expect(parseAckToken(ackToken(id, secret))).toEqual({ alertId: id, secret });
    expect(parseAckToken(`${id}.short`)).toBeNull();
    expect(parseAckToken(`../${id}.${secret}`)).toBeNull();
  });
});

describe("Twilio", () => {
  it("signs like Twilio's documented example and checks in constant time", () => {
    const params = {
      CallSid: "CA1234567890ABCDE",
      Caller: "+14158675310",
      Digits: "1234",
      From: "+14158675310",
      To: "+18005551212",
    };
    const url = "https://example.com/myapp.php?foo=1&bar=2";
    expect(twilioSignature("12345", url, params)).toBe("L/OH5YylLD5NRKLltdqwSvS0BnU=");
    expect(
      verifyTwilioSignature({
        authToken: "12345",
        url,
        params,
        signature: "L/OH5YylLD5NRKLltdqwSvS0BnU=",
      }),
    ).toBe(true);
    expect(
      verifyTwilioSignature({
        authToken: "12345",
        url,
        params: { ...params, Digits: "1" },
        signature: "L/OH5YylLD5NRKLltdqwSvS0BnU=",
      }),
    ).toBe(false);
    expect(verifyTwilioSignature({ authToken: "12345", url, params, signature: null })).toBe(false);
    // Voice callbacks are signed without an explicit https port.
    const withPort = "https://example.com:443/myapp.php?foo=1&bar=2";
    expect(
      verifyTwilioSignature({
        authToken: "12345",
        url: withPort,
        params,
        signature: twilioSignature("12345", url, params),
      }),
    ).toBe(true);
  });

  it("sends texts and calls through the REST API with basic auth", async () => {
    const fake = createFakeTwilio();
    const client = createTwilioClient({
      accountSid: "AC123",
      authToken: "token",
      fromNumber: "+15125550000",
      messagingServiceSid: null,
      fetch: fake.fetch,
      baseUrl: "https://api.twilio.test",
    });
    const sms = await client.sms.send({
      to: "+15125550101",
      body: "EMERGENCY",
      statusCallbackUrl: "https://app.example/api/handoff/twilio/status?alert=x",
    });
    expect(sms).toMatchObject({ ok: true });
    const call = await client.voice.call({
      to: "+15125550101",
      twiml: "<Response/>",
      statusCallbackUrl: null,
    });
    expect(call).toMatchObject({ ok: true });
    expect(fake.messages()[0]?.params).toMatchObject({
      To: "+15125550101",
      From: "+15125550000",
      Body: "EMERGENCY",
      StatusCallback: "https://app.example/api/handoff/twilio/status?alert=x",
    });
    expect(fake.calls()[0]?.params).toMatchObject({ Twiml: "<Response/>", Timeout: "30" });
    expect(fake.requests[0]?.authorization).toBe(
      `Basic ${Buffer.from("AC123:token").toString("base64")}`,
    );
    fake.failNext(400, 21211);
    expect(await client.sms.send({ to: "+1", body: "x", statusCallbackUrl: null })).toEqual({
      ok: false,
      retryable: false,
      code: "21211",
      message: "Twilio refused the message (HTTP 400).",
    });
    fake.failNext(503, 20500);
    expect(
      await client.sms.send({ to: "+15125550101", body: "x", statusCallbackUrl: null }),
    ).toMatchObject({ ok: false, retryable: true });
  });

  it("sends WhatsApp alerts as the approved template with one flat parameter", async () => {
    const fake = createFakeWhatsAppGraph();
    const transport = createWhatsAppAlertTransport({
      phoneNumberId: "1234",
      accessToken: "wa-token",
      template: "staff_alert",
      language: "en_US",
      graphVersion: "v27.0",
      fetch: fake.fetch,
    });
    expect(await transport.send({ to: "+15125550101", text: "Line one\nline   two" })).toEqual({
      ok: true,
      providerId: "wamid.fake1",
    });
    expect(fake.requests[0]?.url).toBe("https://graph.facebook.com/v27.0/1234/messages");
    expect(fake.requests[0]?.authorization).toBe("Bearer wa-token");
    expect(fake.requests[0]?.body).toMatchObject({
      to: "15125550101",
      type: "template",
      template: {
        name: "staff_alert",
        components: [{ type: "body", parameters: [{ type: "text", text: "Line one · line two" }] }],
      },
    });
    expect(whatsappParameter("a\tb")).toBe("a · b");
  });

  it("records what the test transports were asked to send", async () => {
    const transports = createRecordingTransports({ missing: ["voice"] });
    expect(transports.voice).toBeNull();
    await transports.sms?.send({ to: "+1", body: "hi", statusCallbackUrl: null });
    expect(transports.sent).toEqual([{ channel: "sms", to: "+1", text: "hi" }]);
  });
});
