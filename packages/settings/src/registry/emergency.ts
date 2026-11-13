import { BUSINESS_ONLY, defineCategory, GLOBAL_ONLY, setting } from "../define";
import { f } from "../fields";
import { variables } from "../templates";

export const EMERGENCY_SEVERITIES = ["life_safety", "urgent"] as const;

/** One person in an escalation chain. Shared by the business chain and the agency fallback. */
const escalationContact = f.object(
  {
    name: { label: "Name", field: f.text({ minLength: 1, maxLength: 80 }) },
    phone: {
      label: "Mobile number",
      help: "Used for text messages, WhatsApp and the phone call.",
      field: f.text({ format: "phone", minLength: 1 }),
    },
    email: {
      label: "Email",
      help: "Needed only when email is one of the ways to alert this person.",
      field: f.text({ format: "email" }),
    },
    alert_by: {
      label: "Alert by",
      field: f.multiSelect(
        [
          ["sms", "Text message"],
          ["whatsapp", "WhatsApp"],
          ["email", "Email"],
        ],
        { minItems: 1 },
      ),
    },
  },
  {
    check: (contact) =>
      contact.alert_by.includes("email") && contact.email === ""
        ? [{ path: ["email"], message: "Add an email address, or remove email from the alerts." }]
        : [],
  },
);

/**
 * Emergencies. Consumed by the engine (C4: detection, safety instructions, the
 * `escalate_emergency` action whose `emergencyClass` is a `key` from `emergency.classes`)
 * and by the escalation chain (C13).
 */
export const emergencySettings = defineCategory("emergency", {
  "emergency.enabled": setting({
    label: "Emergency handling",
    help: "The bot watches every message for emergencies, puts safety instructions first and alerts the escalation chain. When off, the bot still gives life-safety instructions but nobody is alerted.",
    field: f.boolean(),
    default: true,
  }),
  "emergency.classes": setting({
    label: "Emergency classes",
    help: "The situations treated as emergencies. The bot recognizes them by meaning; the phrases are examples of how customers describe them. For a life-safety class the safety instructions are the first thing the bot says, before any question.",
    field: f.list(
      f.object({
        key: {
          label: "Key",
          help: "Identifier used in alerts, reports and analytics.",
          field: f.text({ format: "slug", minLength: 2, maxLength: 40 }),
        },
        label: { label: "Name", field: f.text({ minLength: 1, maxLength: 60 }) },
        severity: {
          label: "Severity",
          field: f.select([
            ["life_safety", "Life safety", "People may be in danger right now."],
            ["urgent", "Urgent", "Property damage is getting worse by the hour."],
          ]),
        },
        phrases: {
          label: "How customers describe it",
          field: f.stringList({ itemLabel: "phrase", maxItems: 30 }),
        },
        safety_instructions: {
          label: "Safety instructions",
          help: "What the customer should do right now. The bot gives these instructions as written.",
          field: f.text({ multiline: true, minLength: 1, maxLength: 700 }),
        },
        enabled: { label: "Active", field: f.boolean() },
      }),
      { itemLabel: "emergency class", maxItems: 30, unique: "key" },
    ),
    default: [
      {
        key: "gas_leak",
        label: "Gas smell or gas leak",
        severity: "life_safety",
        phrases: ["smell gas", "gas leak", "rotten egg smell", "hissing near the gas line"],
        safety_instructions:
          "Leave the building right now and take everyone with you. Don't use light switches, appliances or anything that could spark on the way out. Once you are outside, call 911 or your gas utility's emergency line.",
        enabled: true,
      },
      {
        key: "carbon_monoxide",
        label: "Carbon monoxide",
        severity: "life_safety",
        phrases: ["CO alarm going off", "carbon monoxide detector", "everyone feels dizzy"],
        safety_instructions:
          "Get everyone, pets included, outside into fresh air right now and call 911. Don't go back in until the fire department says it is safe.",
        enabled: true,
      },
      {
        key: "fire_or_smoke",
        label: "Fire or smoke",
        severity: "life_safety",
        phrases: ["something is on fire", "smoke coming from", "flames", "smoldering"],
        safety_instructions:
          "Get everyone out and call 911 now. Don't go back inside for any reason.",
        enabled: true,
      },
      {
        key: "electrical_hazard",
        label: "Sparking or electrical burning smell",
        severity: "life_safety",
        phrases: [
          "sparks from the outlet",
          "burning smell from the panel",
          "outlet is hot",
          "got shocked",
          "exposed wires",
        ],
        safety_instructions:
          "Stay away from anything that is sparking, smoking or hot, and don't touch it. If you can reach the breaker panel safely, switch off that breaker or the main. If you see flames or someone was shocked, call 911.",
        enabled: true,
      },
      {
        key: "structural_damage",
        label: "Tree on the house or structural damage",
        severity: "life_safety",
        phrases: [
          "tree fell on the house",
          "ceiling is caving in",
          "roof collapsed",
          "wall is bowing",
        ],
        safety_instructions:
          "Get everyone out of the damaged part of the house and stay out. Keep well away from any downed power lines, and call 911 if anyone is hurt or lines are down.",
        enabled: true,
      },
      {
        key: "flooding",
        label: "Burst pipe or flooding",
        severity: "urgent",
        phrases: ["pipe burst", "water pouring", "basement is flooding", "water everywhere"],
        safety_instructions:
          "If you can reach it safely, shut off the water at the main valve. Stay out of standing water near outlets or appliances, and switch off power to that area at the breaker panel only if the panel is dry and easy to reach.",
        enabled: true,
      },
      {
        key: "sewage_backup",
        label: "Sewage backup",
        severity: "urgent",
        phrases: [
          "sewage coming up",
          "toilet overflowing with sewage",
          "drains backing up everywhere",
        ],
        safety_instructions:
          "Stop using water in the house (toilets, sinks, washer) so it doesn't get worse, and keep children and pets away from the affected area.",
        enabled: true,
      },
      {
        key: "no_heat",
        label: "No heat in freezing weather",
        severity: "urgent",
        phrases: ["no heat", "furnace stopped", "heater won't turn on", "house is freezing"],
        safety_instructions:
          "If the house is getting dangerously cold, or anyone there is elderly, very young or unwell, go somewhere warm. Never heat the home with an oven, a grill or an outdoor heater. To protect the pipes, let faucets drip and open the cabinet doors under sinks.",
        enabled: true,
      },
      {
        key: "no_cooling",
        label: "No cooling in extreme heat",
        severity: "urgent",
        phrases: ["AC is out", "no air conditioning", "house is over 90 degrees"],
        safety_instructions:
          "If anyone at home is elderly, very young or unwell, move them somewhere cooler and make sure they drink water. Call 911 for signs of heat illness such as confusion or fainting.",
        enabled: true,
      },
      {
        key: "active_roof_leak",
        label: "Active roof leak or storm damage",
        severity: "urgent",
        phrases: [
          "water coming through the ceiling",
          "roof is leaking right now",
          "shingles blew off",
        ],
        safety_instructions:
          "Stay off the roof and away from any sagging ceiling. Move valuables and put a bucket under the leak. If water is near a light fixture or an outlet, switch off power to that room at the breaker panel if you can reach it safely.",
        enabled: true,
      },
    ],
  }),
  "emergency.service_level": setting({
    label: "Emergency service",
    help: "When the business responds to emergencies. The bot promises nothing beyond this.",
    field: f.select([
      ["around_the_clock", "Around the clock"],
      ["business_hours", "During business hours", "Outside them the team responds when it opens."],
      [
        "none",
        "No emergency service",
        "The bot gives safety instructions and suggests an emergency provider or the utility.",
      ],
    ]),
    default: "business_hours",
    clientEditable: true,
  }),
  "emergency.customer_instruction": setting({
    label: "What the customer is told to do",
    help: "After the safety instructions, how the customer reaches help from the business.",
    field: f.select([
      ["team_will_call", "The team will call them", "The bot confirms the number to call."],
      ["call_emergency_line", "Call the emergency line", "The bot gives the number below."],
      ["both", "Both"],
    ]),
    default: "team_will_call",
  }),
  "emergency.phone": setting({
    label: "Emergency phone line",
    help: "The number customers can call in an emergency. Empty: the bot gives no number and says the team will call.",
    field: f.nullable(f.text({ format: "phone", minLength: 1 }), "No emergency line"),
    default: null,
    scopes: BUSINESS_ONLY,
    clientEditable: true,
  }),
  "emergency.collect": setting({
    label: "Details to collect in an emergency",
    help: "Once the customer is safe, the bot asks for these so the team can respond. Qualification questions wait.",
    field: f.multiSelect(
      [
        ["name", "Name"],
        ["phone", "Phone number"],
        ["address", "Address"],
      ],
      { minItems: 1 },
    ),
    default: ["name", "phone", "address"],
  }),
  "emergency.vulnerable_people": setting({
    label: "Vulnerable people at home",
    help: "A no-heat or no-cooling problem is treated as life safety when the customer mentions someone elderly, an infant or a medical condition.",
    field: f.boolean(),
    default: true,
  }),
  "emergency.after_hours_note": setting({
    label: "Note on emergency visits",
    help: 'Something the bot may add about emergency visits, for example "After-hours emergency visits carry an additional fee." Leave it empty to add nothing.',
    field: f.text({ maxLength: 300 }),
    default: "",
    clientEditable: true,
  }),
  "emergency.escalation_chain": setting({
    label: "Escalation chain",
    help: "Who is alerted about an emergency, in order. The first person is alerted at once; if they do not acknowledge in time they are called, and then the next person is alerted.",
    field: f.list(escalationContact, { itemLabel: "contact", maxItems: 8, unique: "phone" }),
    default: [],
    scopes: BUSINESS_ONLY,
    clientEditable: true,
    sensitive: true,
  }),
  "emergency.acknowledge_minutes": setting({
    label: "Time to acknowledge",
    help: "How long each person has to acknowledge an emergency alert before the next step.",
    field: f.integer({ min: 1, max: 60, unit: "minutes" }),
    default: 5,
  }),
  "emergency.call_unacknowledged": setting({
    label: "Call when not acknowledged",
    help: "A person who has not acknowledged in time gets a phone call before the chain moves on.",
    field: f.boolean(),
    default: true,
  }),
  "emergency.rounds": setting({
    label: "Times through the chain",
    help: "How many times the whole chain is tried before the agency's fallback contacts are alerted.",
    field: f.integer({ min: 1, max: 5, unit: "rounds" }),
    default: 2,
  }),
  "emergency.fallback_contacts": setting({
    label: "Agency fallback contacts",
    help: "Agency staff who are alerted when nobody in a business's chain acknowledges an emergency, or when a business has no chain.",
    field: f.list(escalationContact, { itemLabel: "contact", maxItems: 8, unique: "phone" }),
    default: [],
    scopes: GLOBAL_ONLY,
    sensitive: true,
  }),
  "emergency.alert_template": setting({
    label: "Emergency alert text",
    help: "The text message sent to the escalation chain. Instructions for acknowledging are added automatically.",
    field: f.text({
      multiline: true,
      minLength: 1,
      maxLength: 500,
      variables: variables(
        "business_name",
        "emergency",
        "contact_name",
        "contact_phone",
        "summary",
        "link",
      ),
    }),
    default:
      "EMERGENCY for {{business_name}}: {{emergency}}. {{contact_name}}, {{contact_phone}}. {{summary}} {{link}}",
  }),
});
