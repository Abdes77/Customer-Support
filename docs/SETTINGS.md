# Settings

GENERATED from the registry in `packages/settings/src/registry` by `pnpm settings:docs`.
Do not edit by hand: change the registry and run the command. A test fails when this file and
the registry differ.

Everything a business might want different is a setting. This file lists every setting, and
says how settings are resolved, read, changed and added.

## How a value is resolved

Every setting has a default in the registry. A value can be overridden at three scopes, and
the most specific one wins:

1. the registry default,
2. **global**: the agency's own default for all its businesses,
3. **segment**: the default for one industry segment of the agency (set with its playbook),
4. **business**: the override of one business.

The resolver returns, for one business, every value, where each value came from
(`sources`), and a `version`: a fingerprint of the values that is recorded with every turn,
model call and routing decision.

- **Scopes.** The Scopes column says where a setting may be overridden. "all" means global,
  segment and business. Values that describe one business (its ZIP codes, its alert
  recipients) are business only; agency policy is global only.
- **Client may edit.** A "yes" means the business's own users may change the setting for their
  business, when `client_portal.edit_settings` allows it for their role. Client users see
  only these settings. Everything else is changed by agency staff: any staff member at the
  business scope, an agency admin at the global and segment scopes.
- **Stored values are never trusted.** Rows can be written without the store (agency staff can
  reach business-level rows through Supabase's REST API). The resolver validates every row it
  reads. A row with an unknown key, at a scope its setting does not allow, or with a value
  that fails validation is skipped: the value falls back to the next scope down, and the row
  is reported in `issues`, logged, and shown as "not in force" on the settings screen.
- **Changes are versioned and audited.** Every change through the store gets the next version
  number of its key at that scope, a row in the append-only table `setting_versions` (value,
  previous value, author, note) and an entry in the audit log. A reset removes the override
  and is recorded the same way. Sensitive settings (contact lists, webhook addresses) are
  recorded in the audit log without their values.
- **Two values live in columns of the business.** Its time zone is
  `businesses.timezone` and is not a setting. `client_portal.enabled` is a setting on
  screen and in code, but its value is the column `businesses.client_portal_enabled`,
  because row-level security reads it: the resolver reports the column and the store writes it.

## Using settings in code

```ts
import { type AppSettings, channelSetting, settingsWith } from "@repo/settings";
import { createSettingsResolver, loadSettings } from "@repo/settings/server";

// Once per turn. Keep the snapshot; do not resolve again in the middle of a turn.
const settings = await createSettingsResolver({ db }).resolve({ agencyId, businessId });
// ...or inside a transaction you already hold:
const same = await loadSettings(ctx, { agencyId, businessId });

settings.values["pricing.disclosure"];                              // "never" | "ranges" | "exact"
settings.sources["pricing.disclosure"];                             // { scope, version, updatedAt }
channelSetting(settings.values, "follow_up.max_nudges", channel);  // per-channel settings
settings.version;                                                   // store it with what you decide

// Tests and evaluation profiles: defaults plus overrides, validated.
const profile = settingsWith({ "pricing.disclosure": "ranges", "voice.emoji": "never" });
```

- `@repo/settings` is safe in the browser (registry, types, pure resolver, access rules).
  `@repo/settings/server` holds everything that touches the database.
- Changing settings for a signed-in user:
  `createSettingsService({ db }).updateForUser(user, { target, changes, note })`. From a job:
  `applySettingChanges(ctx, { target, changes, actor })`. Never write `setting_values` yourself.
- The settings screen: `service.viewForUser(user, target)` returns, per setting, the value in
  force, its source, the inherited value, the scope's own override and whether the user may
  edit or reset it. Draw the control from the setting's `field`: switch on `kind` (boolean,
  text, number, select, multi_select, list, object, nullable) and recurse into `item`,
  `properties` and `inner`; `blankValue(field)` gives the starting value of a new list
  entry, `checkSettingValue(key, value, scope)` validates in the browser with the same rules
  as the store. A definition holds a Zod schema, so pass setting keys, not definitions, from
  server components to client components, and look the definition up there with
  `findSetting(key)`.
- Text settings with placeholders are filled with `renderTemplate(text, values)`.
- Never read settings in a client user's database context: row-level security hides the
  rows from them, so the engine refuses instead of quietly returning defaults. Use the
  service (`viewForUser`) or the business's system scope after checking their role;
  `clientPermissionAllows(values["client_portal.view_leads"], role)` answers the
  `client_portal.*` permissions.
- Segment starting values: `applySegmentPreset(ctx, { segmentId, slug })` writes the preset
  of a known trade (`SEGMENT_PRESETS`: roofing, hvac, plumbing, electrical, remodeling) as
  ordinary segment overrides when a segment is first served.
- `pnpm db:seed` loads demo settings for the demo agency after the demo data.

## Adding a setting

1. Add one entry to the file of its category in `packages/settings/src/registry`, with
   `setting({ label, help, field, default, scopes?, clientEditable?, sensitive? })`. The key
   starts with the category id. Build the field with `f` (`f.boolean()`, `f.text()`,
   `f.integer()`, `f.select()`, `f.multiSelect()`, `f.list()`, `f.object()`,
   `f.nullable()`); the type of the value follows from it.
2. Run `pnpm settings:docs`.
3. Use it: `settings.values["your.key"]` is typed. The settings screen shows it without any
   UI change.

Prefer several small settings over one large object, so that a business can override one
knob and inherit the rest. Changing the shape of an existing setting makes stored overrides
of the old shape invalid (they are skipped, not migrated): add a new key instead, or migrate
the stored rows in the same change.

## Placeholders

Text settings whose type lists placeholders may contain them as `{{name}}`. Using a
placeholder a setting does not list is a validation error.

| Placeholder | Filled with |
| --- | --- |
| `{{business_name}}` | The business's name. |
| `{{business_phone}}` | The business's main phone number. |
| `{{business_website}}` | The business's website address. |
| `{{bot_name}}` | The bot's name (`persona.bot_name`). |
| `{{contact_name}}` | The customer's name, or "a new contact" when it is not known yet. |
| `{{contact_phone}}` | The customer's phone number, when known. |
| `{{service}}` | The service the customer asked about. |
| `{{channel}}` | The channel of the conversation, for example WhatsApp. |
| `{{score}}` | The lead score, 0 to 100. |
| `{{band}}` | The label of the lead's score band (`scoring.band_labels`). |
| `{{summary}}` | The one-paragraph summary from the lead report. |
| `{{link}}` | Link to the conversation in the admin panel. |
| `{{emergency}}` | The label of the emergency class that was detected. |
| `{{meeting_type}}` | The kind of meeting (`scheduling.meeting_type`). |
| `{{meeting_time}}` | The date and time of the meeting, in the business's time zone. |
| `{{timeframe}}` | When the team gets back to the customer (`routing.contact_later_timeframe`). |

## Catalogue

340 settings in 22 categories.

| Category | Settings | What it covers |
| --- | --- | --- |
| [Lead qualification](#qualification) | 68 | What the bot finds out about a lead, criterion by criterion, and how much each one counts. |
| [Lead scoring](#scoring) | 6 | How the criteria turn into a score from 0 to 100 and into a score band. |
| [Routing](#routing) | 12 | What happens to a lead in each score band: a meeting, a promise to call back, or a polite no. |
| [Persona and AI disclosure](#persona) | 7 | Who the bot is, and how it says that it is an AI. |
| [Voice and style](#voice) | 20 | Tone, reading level, length, emoji and opening messages. |
| [Pricing disclosure](#pricing) | 9 | Whether and how the bot talks about prices. |
| [Photos](#photos) | 10 | When the bot asks for photos and what it does with them. |
| [Guardrails](#guardrails) | 7 | What the bot must not say or promise. |
| [Conversation flow](#conversation) | 16 | Reply timing, conversation limits and how unusual messages are handled. |
| [Emergencies](#emergency) | 14 | Which situations are emergencies, what the bot says and who is alerted. |
| [Hours](#hours) | 8 | Business hours, holidays, after-hours behaviour and quiet hours. |
| [Follow-ups](#follow_up) | 18 | Nudges to customers who stopped replying. |
| [Handoff and human takeover](#handoff) | 10 | When a person takes over a conversation and when the bot resumes. |
| [Alerts](#alerts) | 9 | Who is told about leads, and how. |
| [Scheduling](#scheduling) | 27 | Calendars, meeting slots, booking rules and reminders. |
| [Channels](#channels) | 36 | Options of the website widget, WhatsApp, Instagram, Messenger and email. |
| [CRM and webhooks](#integrations) | 16 | When leads are pushed to a CRM, field mapping and outgoing webhooks. |
| [Knowledge](#knowledge) | 7 | How business knowledge is gathered and used in replies. |
| [Client portal](#client_portal) | 9 | What the business's own users may see and do when they have a login. |
| [Model and effort](#model) | 14 | Which Claude model does each task, and how hard it thinks. |
| [Limits and spend caps](#limits) | 11 | Rate limits and model-spend caps that stop floods and runaway cost. |
| [Data retention](#data) | 6 | How long conversations, files and model records are kept. |

<a id="qualification"></a>

### Lead qualification

What the bot finds out about a lead, criterion by criterion, and how much each one counts.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `qualification.depth` | **Qualification depth.** How thoroughly the bot qualifies before it hands off. Light asks only for the required criteria; thorough works through every enabled criterion. | one of: `light`, `standard`, `thorough` | `"standard"` | all |  |
| `qualification.max_questions` | **Maximum qualification questions.** After this many qualification questions the bot stops asking and routes the lead with what it knows. | whole number, 1 to 25 questions | `8` | all |  |
| `qualification.questions_per_message` | **Questions per message.** The most questions the bot asks in one message. One reads like a conversation; two gets through qualification faster. | whole number, 1 to 2 questions | `2` | all |  |
| `qualification.contact_details` | **Contact details to collect.** The details the bot asks for during the conversation. It never asks again for one the channel already supplies, such as the phone number on WhatsApp. | any of: `name`, `phone`, `email`, `address` | `["name","phone"]` | all |  |
| `qualification.contact_details_timing` | **When to ask for contact details.** When in the conversation the bot asks for the details above. | one of: `early`, `after_interest`, `before_handoff` | `"after_interest"` | all |  |
| `qualification.custom_criteria` | **Custom criteria.** Extra things to find out that are specific to this agency, segment or business, each with its own question and weight. They are scored like the built-in criteria: an answer among the ideal answers earns the full weight. | list (up to 15) of entries, see below | `[]` | all |  |
| `qualification.service_type.enabled` | **Service type: use.** Whether the bot finds out which service the customer needs and the answer counts toward the lead score. | yes / no | `true` | all |  |
| `qualification.service_type.weight` | **Service type: weight.** How much this criterion counts toward the lead score, relative to the other criteria. With 0 the bot still asks but the answer does not move the score. | whole number, 0 to 100 points | `20` | all |  |
| `qualification.service_type.required` | **Service type: required.** The bot keeps working toward an answer, and a lead is not booked into a meeting while the answer is missing. | yes / no | `true` | all |  |
| `qualification.service_type.offered` | **Services to take leads for.** Leads for these services are a match. Leave it empty to use the services listed in the business's knowledge. | list (up to 80) of: text, up to 120 characters | `[]` | all | yes |
| `qualification.service_type.not_offered` | **Services to turn away.** Requests for these services are never a match, even when they are close to something the business does. | list (up to 80) of: text, up to 120 characters | `[]` | all | yes |
| `qualification.service_type.not_offered_action` | **When the service is not offered.** What happens to a lead who needs a service the business does not take. | one of: `contact_later`, `disqualify` | `"disqualify"` | all |  |
| `qualification.job_scope.enabled` | **Job scope: use.** Whether the bot finds out what the job involves and how big it is and the answer counts toward the lead score. | yes / no | `true` | all |  |
| `qualification.job_scope.weight` | **Job scope: weight.** How much this criterion counts toward the lead score, relative to the other criteria. With 0 the bot still asks but the answer does not move the score. | whole number, 0 to 100 points | `15` | all |  |
| `qualification.job_scope.required` | **Job scope: required.** The bot keeps working toward an answer, and a lead is not booked into a meeting while the answer is missing. | yes / no | `true` | all |  |
| `qualification.job_scope.accepted_types` | **Kinds of job to accept.** Leads for other kinds of job are handled as the setting below says. | any of: `repair`, `replacement`, `new_installation`, `maintenance`, `inspection`, `remodel`, `emergency_service` | see below | all |  |
| `qualification.job_scope.other_type_action` | **When the kind of job is not accepted.** What happens to a lead whose job is not one of the accepted kinds. | one of: `lower_score`, `contact_later`, `disqualify` | `"contact_later"` | all |  |
| `qualification.job_scope.details` | **Details to collect about the job.** Specifics the team needs before a visit, in your own words, for example "approximate roof age" or "number of rooms". The segment playbook's questions are used as well. | list (up to 20) of: text, up to 160 characters | `[]` | all | yes |
| `qualification.job_scope.minimum_job_usd` | **Smallest job worth taking.** Jobs that are clearly smaller than this are handled as the setting below says. The bot never tells the customer this number. | whole number, 0 to 1000000 USD, or empty (no minimum) | `null` | all |  |
| `qualification.job_scope.small_job_action` | **When the job is too small.** What happens to a lead whose job is below the minimum. | one of: `accept`, `lower_score`, `contact_later`, `disqualify` | `"lower_score"` | all |  |
| `qualification.service_area.enabled` | **Service area: use.** Whether the bot finds out where the job is and the answer counts toward the lead score. | yes / no | `true` | all |  |
| `qualification.service_area.weight` | **Service area: weight.** How much this criterion counts toward the lead score, relative to the other criteria. With 0 the bot still asks but the answer does not move the score. | whole number, 0 to 100 points | `15` | all |  |
| `qualification.service_area.required` | **Service area: required.** The bot keeps working toward an answer, and a lead is not booked into a meeting while the answer is missing. | yes / no | `true` | all |  |
| `qualification.service_area.ask_for` | **Location to ask for.** How precisely the bot asks where the job is. | one of: `zip_code`, `city`, `full_address` | `"zip_code"` | all |  |
| `qualification.service_area.zip_codes` | **ZIP codes served.** A lead in one of these ZIP codes is in the service area. If ZIP codes, radius, cities and states are all empty, every location is accepted. | list (up to 2000) of: five-digit ZIP code | `[]` | business | yes |
| `qualification.service_area.excluded_zip_codes` | **ZIP codes not served.** Always outside the service area, even inside the radius or a served city. | list (up to 2000) of: five-digit ZIP code | `[]` | business | yes |
| `qualification.service_area.radius_miles` | **Service radius.** A lead within this distance of the center ZIP code is in the service area. | whole number, 1 to 500 miles, or empty (no radius) | `null` | business | yes |
| `qualification.service_area.center_zip` | **Center of the radius.** The ZIP code the radius is measured from. Empty uses the ZIP code of the business address. | five-digit ZIP code, or empty (business address) | `null` | business | yes |
| `qualification.service_area.cities` | **Cities and counties served.** A lead who names one of these places is in the service area. | list (up to 300) of: text, up to 120 characters | `[]` | business | yes |
| `qualification.service_area.states` | **States served.** A lead outside these states is outside the service area. Empty means no restriction by state. | list (up to 51) of: two-letter US state code | `[]` | business | yes |
| `qualification.service_area.out_of_area_action` | **When the job is outside the service area.** What happens to a lead whose job is outside the area. | one of: `accept`, `lower_score`, `contact_later`, `disqualify` | `"disqualify"` | all |  |
| `qualification.timeline.enabled` | **Timeline and urgency: use.** Whether the bot finds out how soon the customer wants the work done and the answer counts toward the lead score. | yes / no | `true` | all |  |
| `qualification.timeline.weight` | **Timeline and urgency: weight.** How much this criterion counts toward the lead score, relative to the other criteria. With 0 the bot still asks but the answer does not move the score. | whole number, 0 to 100 points | `15` | all |  |
| `qualification.timeline.required` | **Timeline and urgency: required.** The bot keeps working toward an answer, and a lead is not booked into a meeting while the answer is missing. | yes / no | `true` | all |  |
| `qualification.timeline.ideal` | **Ideal timelines.** Leads who want the work in one of these time frames earn the full weight. | any of: `emergency`, `this_week`, `this_month`, `one_to_three_months`, `three_to_six_months`, `later`, `just_researching` | `["emergency","this_week","this_month"]` | all |  |
| `qualification.timeline.acceptable` | **Acceptable timelines.** Leads in one of these time frames earn half the weight. Any other time frame earns nothing. | any of: `emergency`, `this_week`, `this_month`, `one_to_three_months`, `three_to_six_months`, `later`, `just_researching` | `["one_to_three_months"]` | all |  |
| `qualification.decision_maker.enabled` | **Decision-maker: use.** Whether the bot finds out whether the customer can approve the work and the answer counts toward the lead score. | yes / no | `true` | all |  |
| `qualification.decision_maker.weight` | **Decision-maker: weight.** How much this criterion counts toward the lead score, relative to the other criteria. With 0 the bot still asks but the answer does not move the score. | whole number, 0 to 100 points | `10` | all |  |
| `qualification.decision_maker.required` | **Decision-maker: required.** The bot keeps working toward an answer, and a lead is not booked into a meeting while the answer is missing. | yes / no | `false` | all |  |
| `qualification.decision_maker.accepted_roles` | **Who counts as a decision-maker.** Leads in one of these roles earn the full weight. | any of: `homeowner`, `landlord`, `property_manager`, `business_owner`, `tenant_with_permission`, `tenant`, `other` | `["homeowner","landlord","property_manager","business_owner"]` | all |  |
| `qualification.decision_maker.not_decision_maker_action` | **When the customer cannot approve the work.** What happens with renters and others who need someone else's approval. | one of: `accept`, `ask_for_owner`, `contact_later`, `disqualify` | `"ask_for_owner"` | all |  |
| `qualification.decision_maker.ask_about_others` | **Ask who else is involved.** The bot asks whether anyone else takes part in the decision (a spouse, a co-owner, an HOA), so the estimate visit can include them. | yes / no | `false` | all |  |
| `qualification.budget.enabled` | **Budget: use.** Whether the bot finds out what the customer expects to spend and the answer counts toward the lead score. | yes / no | `true` | all |  |
| `qualification.budget.weight` | **Budget: weight.** How much this criterion counts toward the lead score, relative to the other criteria. With 0 the bot still asks but the answer does not move the score. | whole number, 0 to 100 points | `10` | all |  |
| `qualification.budget.required` | **Budget: required.** The bot keeps working toward an answer, and a lead is not booked into a meeting while the answer is missing. | yes / no | `false` | all |  |
| `qualification.budget.ask_mode` | **How to ask about budget.** Asking about money early can put customers off; for repairs it is rarely needed, for remodels it usually is. | one of: `never`, `if_raised`, `offer_bands`, `open_question` | `"if_raised"` | all |  |
| `qualification.budget.bands` | **Budget bands.** The ranges a budget is sorted into, and how well each fits the business. An ideal band earns the full weight, an acceptable one half, a poor one nothing. | list (up to 10) of entries, see below | see below | all |  |
| `qualification.budget.minimum_usd` | **Minimum budget.** A lead whose stated budget is below this is handled as the setting below says. The bot never tells the customer this number. | whole number, 0 to 10000000 USD, or empty (no minimum) | `null` | all |  |
| `qualification.budget.below_minimum_action` | **When the budget is below the minimum.** What happens to a lead whose budget is below the minimum. | one of: `accept`, `lower_score`, `contact_later`, `disqualify` | `"lower_score"` | all |  |
| `qualification.property_type.enabled` | **Property type: use.** Whether the bot finds out what kind of property the job is at and the answer counts toward the lead score. | yes / no | `true` | all |  |
| `qualification.property_type.weight` | **Property type: weight.** How much this criterion counts toward the lead score, relative to the other criteria. With 0 the bot still asks but the answer does not move the score. | whole number, 0 to 100 points | `5` | all |  |
| `qualification.property_type.required` | **Property type: required.** The bot keeps working toward an answer, and a lead is not booked into a meeting while the answer is missing. | yes / no | `false` | all |  |
| `qualification.property_type.accepted` | **Property types to accept.** Leads for these kinds of property earn the full weight. | any of: `single_family`, `townhouse`, `condo`, `multi_family`, `mobile_home`, `commercial`, `new_construction` | `["single_family","townhouse","condo","multi_family"]` | all |  |
| `qualification.property_type.other_action` | **When the property type is not accepted.** What happens to a lead whose property is of another kind. | one of: `accept`, `lower_score`, `contact_later`, `disqualify` | `"contact_later"` | all |  |
| `qualification.property_type.ask_age` | **Ask how old the home or system is.** The bot asks roughly how old the home, roof or equipment is when that matters for the job. | yes / no | `false` | all |  |
| `qualification.insurance_claim.enabled` | **Insurance claim: use.** Whether the bot finds out whether an insurance claim is involved and the answer counts toward the lead score. | yes / no | `false` | all |  |
| `qualification.insurance_claim.weight` | **Insurance claim: weight.** How much this criterion counts toward the lead score, relative to the other criteria. With 0 the bot still asks but the answer does not move the score. | whole number, 0 to 100 points | `5` | all |  |
| `qualification.insurance_claim.required` | **Insurance claim: required.** The bot keeps working toward an answer, and a lead is not booked into a meeting while the answer is missing. | yes / no | `false` | all |  |
| `qualification.insurance_claim.preference` | **Insurance work.** How a job paid through an insurance claim fits the business. | one of: `prefer`, `neutral`, `avoid` | `"neutral"` | all |  |
| `qualification.insurance_claim.details` | **Claim details to collect.** What the bot asks once the customer says a claim is involved. | any of: `claim_status`, `insurer`, `adjuster_visit`, `claim_number`, `deductible` | `["claim_status","insurer"]` | all |  |
| `qualification.financing.enabled` | **Financing: use.** Whether the bot finds out whether the customer wants to finance the job and the answer counts toward the lead score. | yes / no | `false` | all |  |
| `qualification.financing.weight` | **Financing: weight.** How much this criterion counts toward the lead score, relative to the other criteria. With 0 the bot still asks but the answer does not move the score. | whole number, 0 to 100 points | `5` | all |  |
| `qualification.financing.required` | **Financing: required.** The bot keeps working toward an answer, and a lead is not booked into a meeting while the answer is missing. | yes / no | `false` | all |  |
| `qualification.financing.mention` | **Mentioning financing.** Whether the bot brings up financing. It only describes plans that are in the business's knowledge and never promises approval. | one of: `never`, `when_asked`, `proactively` | `"when_asked"` | all |  |
| `qualification.financing.interest_effect` | **Effect of financing interest.** How a customer who wants financing is scored. | one of: `positive`, `neutral`, `negative` | `"neutral"` | all |  |
| `qualification.photos.enabled` | **Photos: use.** Whether the bot finds out whether the customer has sent photos of the job (see the Photos category for when the bot asks) and the answer counts toward the lead score. | yes / no | `true` | all |  |
| `qualification.photos.weight` | **Photos: weight.** How much this criterion counts toward the lead score, relative to the other criteria. With 0 the bot still asks but the answer does not move the score. | whole number, 0 to 100 points | `5` | all |  |
| `qualification.photos.required` | **Photos: required.** The bot keeps working toward an answer, and a lead is not booked into a meeting while the answer is missing. | yes / no | `false` | all |  |

<details><summary><code>qualification.custom_criteria</code></summary>

Structure:

- each criterion (up to 15):
  - `key` (Key): identifier (lower-case letters, digits, underscores). Identifier used in lead reports and CRM field mapping.
  - `label` (Name): text, up to 60 characters.
  - `question` (Question): text, up to 300 characters. What the bot should find out, in your own words. The bot phrases it to fit the conversation.
  - `answer_type` (Answer type): one of: `text`, `yes_no`, `choice`.
  - `choices` (Possible answers): list (up to 12) of: text, up to 80 characters. For the answer type "one of the listed answers".
  - `ideal_answers` (Ideal answers): list (up to 12) of: text, up to 80 characters. Answers that earn the full weight. For yes-or-no questions use "yes" or "no".
  - `weight` (Weight): whole number, 0 to 100 points.
  - `required` (Required): yes / no.

</details>

<details><summary><code>qualification.job_scope.accepted_types</code></summary>

Structure:

- any of: `repair`, `replacement`, `new_installation`, `maintenance`, `inspection`, `remodel`, `emergency_service`

Default:

```json
[
  "repair",
  "replacement",
  "new_installation",
  "maintenance",
  "inspection",
  "remodel",
  "emergency_service"
]
```

</details>

<details><summary><code>qualification.timeline.ideal</code></summary>

Structure:

- any of: `emergency`, `this_week`, `this_month`, `one_to_three_months`, `three_to_six_months`, `later`, `just_researching`

</details>

<details><summary><code>qualification.timeline.acceptable</code></summary>

Structure:

- any of: `emergency`, `this_week`, `this_month`, `one_to_three_months`, `three_to_six_months`, `later`, `just_researching`

</details>

<details><summary><code>qualification.decision_maker.accepted_roles</code></summary>

Structure:

- any of: `homeowner`, `landlord`, `property_manager`, `business_owner`, `tenant_with_permission`, `tenant`, `other`

</details>

<details><summary><code>qualification.budget.bands</code></summary>

Structure:

- each band (up to 10):
  - `key` (Key): identifier (lower-case letters, digits, underscores).
  - `label` (Label): text, up to 60 characters.
  - `min_usd` (From): whole number, 0 to 10000000 USD, or empty (no lower end).
  - `max_usd` (To): whole number, 0 to 10000000 USD, or empty (no upper end).
  - `fit` (Fit): one of: `ideal`, `acceptable`, `poor`.

Default:

```json
[
  {"key":"under_1k","label":"Under $1,000","min_usd":null,"max_usd":1000,"fit":"acceptable"},
  {"key":"up_to_5k","label":"$1,000 to $5,000","min_usd":1000,"max_usd":5000,"fit":"ideal"},
  {"key":"up_to_15k","label":"$5,000 to $15,000","min_usd":5000,"max_usd":15000,"fit":"ideal"},
  {"key":"up_to_50k","label":"$15,000 to $50,000","min_usd":15000,"max_usd":50000,"fit":"ideal"},
  {"key":"over_50k","label":"Over $50,000","min_usd":50000,"max_usd":null,"fit":"ideal"}
]
```

</details>

<details><summary><code>qualification.property_type.accepted</code></summary>

Structure:

- any of: `single_family`, `townhouse`, `condo`, `multi_family`, `mobile_home`, `commercial`, `new_construction`

</details>

<details><summary><code>qualification.insurance_claim.details</code></summary>

Structure:

- any of: `claim_status`, `insurer`, `adjuster_visit`, `claim_number`, `deductible`

</details>

<a id="scoring"></a>

### Lead scoring

How the criteria turn into a score from 0 to 100 and into a score band.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `scoring.thresholds` | **Score thresholds.** The lowest score for each band. A lead at or above the hot threshold is hot, at or above the warm threshold warm, and cold below that. Routing decides what each band means. | group of values, see below | `{"hot":70,"warm":40}` | all |  |
| `scoring.band_labels` | **Band names.** What the bands are called in reports, alerts and the admin panel. Customers never see them. | group of values, see below | `{"hot":"Hot","warm":"Warm","cold":"Cold"}` | all |  |
| `scoring.unknown_credit_percent` | **Credit for unanswered criteria.** The share of a criterion's weight a lead earns while that criterion is still unknown. 50 treats an unanswered question as neutral; 0 makes leads earn every point. | whole number, 0 to 100 % | `50` | all |  |
| `scoring.minimum_confidence` | **Minimum confidence.** An answer the bot inferred with less confidence than this counts as unknown. 1 accepts only what the customer stated outright. | number, 0 to 1 | `0.5` | all |  |
| `scoring.adjustments` | **Score adjustments.** Points added or taken off when a signal shows up in the conversation, on top of the criteria. The result stays between 0 and 100. | list (up to 20) of entries, see below | see below | all |  |
| `scoring.auto_disqualify` | **Always disqualify.** Contacts of these kinds are never leads, whatever their score. | any of: `spam`, `solicitation`, `job_seeker`, `wrong_number` | `["spam","solicitation","job_seeker","wrong_number"]` | all |  |

<details><summary><code>scoring.thresholds</code></summary>

Structure:

- `hot` (Hot from): whole number, 1 to 100 points.
- `warm` (Warm from): whole number, 0 to 99 points.

</details>

<details><summary><code>scoring.band_labels</code></summary>

Structure:

- `hot` (Hot): text, up to 30 characters.
- `warm` (Warm): text, up to 30 characters.
- `cold` (Cold): text, up to 30 characters.

</details>

<details><summary><code>scoring.adjustments</code></summary>

Structure:

- each adjustment (up to 20):
  - `signal` (Signal): one of: `emergency`, `existing_customer`, `referral`, `repeat_inquiry`, `shared_phone`, `sent_photos`, `comparing_quotes`, `price_only_inquiry`, `rude_or_abusive`.
  - `points` (Points): whole number, -100 to 100 points.

Default:

```json
[
  {"signal":"emergency","points":15},
  {"signal":"existing_customer","points":10},
  {"signal":"referral","points":10},
  {"signal":"price_only_inquiry","points":-10},
  {"signal":"rude_or_abusive","points":-20}
]
```

</details>

<a id="routing"></a>

### Routing

What happens to a lead in each score band: a meeting, a promise to call back, or a polite no.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `routing.mode` | **Routing mode.** How the outcome of a lead is decided. "Always contact later" tells every lead that the team will be in touch, whatever the score; leads still get a score and a report. | one of: `by_score_band`, `always_contact_later` | `"by_score_band"` | all |  |
| `routing.hot_outcome` | **Hot leads.** What happens to a lead in the hot band. | one of: `book_meeting`, `contact_later`, `disqualify` | `"book_meeting"` | all |  |
| `routing.warm_outcome` | **Warm leads.** What happens to a lead in the warm band. | one of: `book_meeting`, `contact_later`, `disqualify` | `"contact_later"` | all |  |
| `routing.cold_outcome` | **Cold leads.** What happens to a lead in the cold band. | one of: `book_meeting`, `contact_later`, `disqualify` | `"contact_later"` | all |  |
| `routing.booking_requires` | **Details needed before booking.** The bot does not book a meeting until it has these details. | any of: `name`, `phone`, `email`, `address` | `["name","phone"]` | all |  |
| `routing.booking_unavailable_outcome` | **When booking is not possible.** What a lead who should be booked gets when no calendar is connected or no time is free. | one of: `contact_later`, `handoff` | `"contact_later"` | all |  |
| `routing.after_hours_booking` | **Booking outside business hours.** Whether the bot books meetings while the business is closed. | one of: `allowed`, `contact_later` | `"allowed"` | all |  |
| `routing.existing_customer_outcome` | **Existing customers.** What happens when the person is already a customer with a new job in mind. | one of: `by_score`, `contact_later`, `handoff` | `"by_score"` | all |  |
| `routing.contact_later_timeframe` | **When the team gets back.** The time frame the bot promises with "we'll contact you". Keep it honest: the bot repeats it word for word. | text, up to 80 characters | `"within one business day"` | all | yes |
| `routing.contact_later_guidance` | **"We'll contact you" message.** How the bot tells a customer that the team will be in touch. Guidance, not a script: the bot words it to fit the conversation. | text (several lines), up to 600 characters; placeholders: {{business_name}}, {{timeframe}} | see below | all |  |
| `routing.disqualify_guidance` | **Polite-no message.** How the bot turns a customer down. Guidance, not a script. The bot never mentions scores or qualification. | text (several lines), up to 600 characters; placeholders: {{business_name}} | see below | all |  |
| `routing.disqualify_referral` | **Where to send people the business cannot help.** Optional pointer the bot may add to a polite no, for example "For appliance repair, try a local appliance service." Leave it empty to add nothing. | text (several lines), up to 300 characters | `""` | all | yes |

<details><summary><code>routing.contact_later_guidance</code></summary>

Structure:

- text (several lines), up to 600 characters; placeholders: {{business_name}}, {{timeframe}}

Default:

```json
"Thank the customer, say that someone from {{business_name}} will reach out {{timeframe}}, confirm the best number or email to use, and ask if there is anything else the team should know first."
```

</details>

<details><summary><code>routing.disqualify_guidance</code></summary>

Structure:

- text (several lines), up to 600 characters; placeholders: {{business_name}}

Default:

```json
"Thank the customer for reaching out, say plainly and kindly that this is not something {{business_name}} can take on, give the reason in one sentence when it is a simple one (outside the service area, a service we do not offer), and wish them well."
```

</details>

<a id="persona"></a>

### Persona and AI disclosure

Who the bot is, and how it says that it is an AI.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `persona.bot_name` | **Bot name.** The first name the bot introduces itself with and signs emails with. | text, up to 40 characters | `"Alex"` | all | yes |
| `persona.role_title` | **Role.** How the bot describes its job when it introduces itself, for example "virtual assistant" or "office assistant". | text, up to 60 characters | `"virtual assistant"` | all | yes |
| `persona.description` | **Persona.** Who the bot is: background, attitude and how it treats customers. The bot stays in this character for the whole conversation. | text (several lines), up to 1200 characters | see below | all | yes |
| `persona.speaks_as` | **Speaks as.** Whether the bot talks about the business as "we" ("we can come out Tuesday") or as a named person on the team ("I'll get this to our estimator"). | one of: `team_member`, `business` | `"team_member"` | all |  |
| `persona.ai_disclosure` | **AI disclosure.** When the bot says that it is an AI assistant. It never claims to be human under either option: when a customer asks, it answers truthfully. | one of: `upfront`, `when_asked` | `"upfront"` | all |  |
| `persona.ai_disclosure_wording` | **Disclosure wording.** The sentence the bot uses to introduce itself as an AI when disclosure is set to "in its first message". | text, up to 300 characters; placeholders: {{bot_name}}, {{business_name}} | `"I'm {{bot_name}}, the virtual assistant for {{business_name}}."` | all |  |
| `persona.ai_question_answer` | **Answer to "Are you a bot?".** What the bot says when a customer asks whether they are talking to a person or a machine. It must stay truthful; the bot may rephrase it to fit the conversation. | text (several lines), up to 400 characters; placeholders: {{bot_name}}, {{business_name}} | see below | all |  |

<details><summary><code>persona.description</code></summary>

Default:

```json
"A sharp, friendly member of the office team who has helped hundreds of homeowners and knows the trade well. Practical, warm and never pushy: listens first, explains things in plain words and always moves the customer one step closer to getting their problem solved."
```

</details>

<details><summary><code>persona.ai_disclosure_wording</code></summary>

Structure:

- text, up to 300 characters; placeholders: {{bot_name}}, {{business_name}}

</details>

<details><summary><code>persona.ai_question_answer</code></summary>

Structure:

- text (several lines), up to 400 characters; placeholders: {{bot_name}}, {{business_name}}

Default:

```json
"I'm an AI assistant for {{business_name}}. I can take down everything the team needs and bring in a person whenever you'd like."
```

</details>

<a id="voice"></a>

### Voice and style

Tone, reading level, length, emoji and opening messages.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `voice.tone` | **Tone.** The overall tone of the bot's replies. | one of: `friendly`, `professional`, `casual`, `empathetic`, `direct`, `upbeat` | `"friendly"` | all | yes |
| `voice.style_notes` | **Style notes.** Extra guidance on how the bot should sound, in your own words: regional phrases, things the owner always says, things to avoid. Example: "Say 'y'all'. Never say 'unfortunately'." | text (several lines), up to 1200 characters | `""` | all | yes |
| `voice.reading_level` | **Reading level.** How simple the wording is. Trade terms are always explained in plain words at the simple and standard levels. | one of: `simple`, `standard`, `advanced` | `"standard"` | all |  |
| `voice.reply_length` | **Reply length.** How much the bot writes in a chat reply. Emails are written as proper emails regardless; the character limits below are the hard cap. | one of: `brief`, `balanced`, `detailed` | `"brief"` | all |  |
| `voice.max_reply_characters.whatsapp` | **Longest reply on WhatsApp.** Hard limit for one reply on WhatsApp, in characters. A draft over the limit is rewritten shorter before it is sent. | whole number, 80 to 6000 characters | `600` | all |  |
| `voice.max_reply_characters.instagram` | **Longest reply on Instagram.** Hard limit for one reply on Instagram, in characters. A draft over the limit is rewritten shorter before it is sent. | whole number, 80 to 6000 characters | `500` | all |  |
| `voice.max_reply_characters.messenger` | **Longest reply on Messenger.** Hard limit for one reply on Messenger, in characters. A draft over the limit is rewritten shorter before it is sent. | whole number, 80 to 6000 characters | `500` | all |  |
| `voice.max_reply_characters.widget` | **Longest reply on Website chat.** Hard limit for one reply on Website chat, in characters. A draft over the limit is rewritten shorter before it is sent. | whole number, 80 to 6000 characters | `500` | all |  |
| `voice.max_reply_characters.email` | **Longest reply on Email.** Hard limit for one reply on Email, in characters. A draft over the limit is rewritten shorter before it is sent. | whole number, 80 to 6000 characters | `2500` | all |  |
| `voice.max_messages_per_turn` | **Messages per reply.** How many separate chat messages the bot may send in a row when answering (for example a short answer, then a question). Email always gets one. | whole number, 1 to 3 | `2` | all |  |
| `voice.emoji` | **Emoji.** How often the bot uses emoji in chat. Emails and emergency replies never contain emoji. | one of: `never`, `sparingly`, `freely` | `"sparingly"` | all | yes |
| `voice.use_customer_name` | **Use the customer's name.** How often the bot addresses the customer by first name once it knows it. | one of: `never`, `sometimes`, `often` | `"sometimes"` | all |  |
| `voice.humor` | **Humor.** Whether the bot may make a light remark when the customer's mood invites it. It never jokes about a customer's problem, and never in an emergency. | one of: `none`, `light` | `"none"` | all |  |
| `voice.banned_phrases` | **Words and phrases to avoid.** The bot never uses these words or phrases. A reply that contains one is rewritten before it is sent. | list (up to 100) of: text, up to 120 characters | `[]` | all | yes |
| `voice.opening_message.whatsapp` | **Opening message on WhatsApp.** If set, the bot's first reply in a new WhatsApp conversation starts with this text and then answers what the customer wrote. Leave it empty to let the bot write its own greeting. | text (several lines), up to 500 characters; placeholders: {{business_name}}, {{bot_name}} | `""` | all | yes |
| `voice.opening_message.instagram` | **Opening message on Instagram.** If set, the bot's first reply in a new Instagram conversation starts with this text and then answers what the customer wrote. Leave it empty to let the bot write its own greeting. | text (several lines), up to 500 characters; placeholders: {{business_name}}, {{bot_name}} | `""` | all | yes |
| `voice.opening_message.messenger` | **Opening message on Messenger.** If set, the bot's first reply in a new Messenger conversation starts with this text and then answers what the customer wrote. Leave it empty to let the bot write its own greeting. | text (several lines), up to 500 characters; placeholders: {{business_name}}, {{bot_name}} | `""` | all | yes |
| `voice.opening_message.widget` | **Opening message on Website chat.** The first message a visitor sees when they open the website chat, before they have written anything. | text (several lines), up to 500 characters; placeholders: {{business_name}}, {{bot_name}} | see below | all | yes |
| `voice.opening_message.email` | **Opening message on Email.** If set, the bot's first reply in a new Email conversation starts with this text and then answers what the customer wrote. Leave it empty to let the bot write its own greeting. | text (several lines), up to 500 characters; placeholders: {{business_name}}, {{bot_name}} | `""` | all | yes |
| `voice.closing_message` | **Closing message.** How the bot signs off when a conversation is finished. Leave it empty to let the bot close in its own words. | text (several lines), up to 400 characters; placeholders: {{business_name}}, {{bot_name}} | `""` | all | yes |

<details><summary><code>voice.tone</code></summary>

Structure:

- one of: `friendly`, `professional`, `casual`, `empathetic`, `direct`, `upbeat`

</details>

<details><summary><code>voice.opening_message.whatsapp</code></summary>

Structure:

- text (several lines), up to 500 characters; placeholders: {{business_name}}, {{bot_name}}

</details>

<details><summary><code>voice.opening_message.instagram</code></summary>

Structure:

- text (several lines), up to 500 characters; placeholders: {{business_name}}, {{bot_name}}

</details>

<details><summary><code>voice.opening_message.messenger</code></summary>

Structure:

- text (several lines), up to 500 characters; placeholders: {{business_name}}, {{bot_name}}

</details>

<details><summary><code>voice.opening_message.widget</code></summary>

Structure:

- text (several lines), up to 500 characters; placeholders: {{business_name}}, {{bot_name}}

Default:

```json
"Hi! Thanks for stopping by {{business_name}}. What can we help you with today?"
```

</details>

<details><summary><code>voice.opening_message.email</code></summary>

Structure:

- text (several lines), up to 500 characters; placeholders: {{business_name}}, {{bot_name}}

</details>

<details><summary><code>voice.closing_message</code></summary>

Structure:

- text (several lines), up to 400 characters; placeholders: {{business_name}}, {{bot_name}}

</details>

<a id="pricing"></a>

### Pricing disclosure

Whether and how the bot talks about prices.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `pricing.disclosure` | **Price disclosure.** How much the bot may say about prices. | one of: `never`, `ranges`, `exact` | `"never"` | all |  |
| `pricing.use_playbook_ranges` | **Use industry price ranges.** When the business's own knowledge has no price for a job, the bot may give the typical regional range from the segment playbook, clearly as a general figure. Applies only when disclosure is set to ranges or exact. | yes / no | `false` | all |  |
| `pricing.deflection_guidance` | **Answer when prices are not disclosed.** How the bot answers a price question it may not answer with numbers. Guidance, not a script. | text (several lines), up to 600 characters | see below | all |  |
| `pricing.disclaimer` | **Disclaimer with every price.** Added, in the bot's own words, whenever it mentions a number. | text, up to 300 characters | `"The final price is confirmed after the team has looked at the job."` | all |  |
| `pricing.estimate_policy` | **Estimates.** What the bot says about the cost of an estimate or a site visit. | one of: `not_stated`, `free`, `paid`, `credited` | `"not_stated"` | all | yes |
| `pricing.estimate_fee_usd` | **Estimate fee.** The fee for an estimate or site visit, when estimates are paid or credited. | number, 0 to 10000 USD, or empty (not set) | `null` | all | yes |
| `pricing.service_call_fee_usd` | **Service-call fee.** The diagnostic or trip fee. The bot mentions it when a customer asks what a visit costs, unless disclosure is set to never. | number, 0 to 10000 USD, or empty (not set) | `null` | all | yes |
| `pricing.promotions` | **Current offers.** Offers the bot may mention when price comes up. It never makes up a discount and never mentions an offer after its end date. | list (up to 10) of entries, see below | `[]` | all | yes |
| `pricing.negotiation` | **Requests for a discount.** What the bot does when a customer asks for a better price or a price match. It never agrees to a price on its own. | one of: `refer_to_team`, `decline` | `"refer_to_team"` | all |  |

<details><summary><code>pricing.deflection_guidance</code></summary>

Default:

```json
"Say that the price depends on the details of the job and that the team gives an exact quote once they have seen it. Then ask the next question that gets the customer closer to that quote."
```

</details>

<details><summary><code>pricing.promotions</code></summary>

Structure:

- each offer (up to 10):
  - `title` (Offer): text, up to 120 characters.
  - `details` (Conditions): text (several lines), up to 400 characters.
  - `ends_on` (Ends on): date (YYYY-MM-DD), or empty (no end date).

</details>

<a id="photos"></a>

### Photos

When the bot asks for photos and what it does with them.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `photos.request_mode` | **Asking for photos.** Whether the bot asks customers to send photos of the job. | one of: `never`, `when_helpful`, `always` | `"when_helpful"` | all | yes |
| `photos.request_timing` | **When to ask.** The point in the conversation at which the bot asks for photos. | one of: `early`, `after_basics`, `before_handoff` | `"after_basics"` | all |  |
| `photos.max_requests` | **Times to ask.** How many times the bot may ask for photos in one conversation. It never insists: a customer who cannot send one is qualified without. | whole number, 1 to 5 requests | `2` | all |  |
| `photos.subjects` | **What to photograph.** What the bot asks customers to photograph, for example "the damaged area from a few steps back" or "the label on the unit". Empty lets the bot choose from the kind of job. | list (up to 12) of: text, up to 160 characters | `[]` | all | yes |
| `photos.safety_note` | **Safety reminder.** Added whenever the bot asks for a photo, so nobody climbs a roof or opens a panel for a picture. | text, up to 300 characters | see below | all |  |
| `photos.analysis_enabled` | **Analyze photos.** The bot looks at the photos customers send and records what it sees in the lead report. When off, photos are stored for the team and the bot only thanks the customer. | yes / no | `true` | all |  |
| `photos.share_findings` | **Telling the customer what the photo shows.** How much the bot says about a photo. It never diagnoses a problem or names a cause from a picture: that is the team's job on site. | one of: `acknowledge`, `describe` | `"acknowledge"` | all |  |
| `photos.max_per_conversation` | **Photos analyzed per conversation.** Further photos are stored for the team but not analyzed. | whole number, 1 to 40 photos | `10` | all |  |
| `photos.include_in_report` | **Photos in the lead report.** The lead report describes each photo and links to it. | yes / no | `true` | all |  |
| `photos.accept_video` | **Accept videos.** Videos are stored for the team. They are not analyzed; the bot thanks the customer and carries on. | yes / no | `true` | all |  |

<details><summary><code>photos.safety_note</code></summary>

Default:

```json
"Only if it's safe and easy to take: please don't climb up or open anything."
```

</details>

<a id="guardrails"></a>

### Guardrails

What the bot must not say or promise.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `guardrails.unknown_answer` | **When the bot does not know.** What the bot does when the business's knowledge does not answer a customer's question. | one of: `team_will_confirm`, `offer_handoff` | `"team_will_confirm"` | all |  |
| `guardrails.forbidden_topics` | **Topics to stay away from.** The bot does not give opinions or advice on these. It says so in one friendly sentence and returns to the customer's project. | list (up to 40) of: text, up to 120 characters | see below | all |  |
| `guardrails.competitors` | **Talking about competitors.** What the bot does when a customer mentions another company. | one of: `no_comment`, `differentiators_only` | `"no_comment"` | all |  |
| `guardrails.diy_advice` | **Do-it-yourself advice.** Whether the bot gives tips the customer can act on while waiting. Emergency safety instructions are always given. The bot never explains gas, electrical or roof work. | one of: `none`, `safe_first_steps` | `"safe_first_steps"` | all |  |
| `guardrails.allowed_link_domains` | **Websites the bot may link to.** The bot may include links to these domains. Links to the business's own website and to its scheduling page are always allowed; any other link is removed before a reply is sent. | list (up to 40) of: domain name | `[]` | all |  |
| `guardrails.claims_need_knowledge` | **Licenses, warranties and guarantees.** What the bot says about licensing, insurance, warranties and guarantees. | one of: `knowledge_only`, `never_discuss` | `"knowledge_only"` | all |  |
| `guardrails.extra_rules` | **Additional rules.** Further rules the bot must follow, one per line. Example: "Never offer same-day service." They rank below safety rules and above style preferences. A business-level value replaces the agency-wide one, so repeat the rules that should still apply. | text (several lines), up to 1500 characters | `""` | all |  |

<details><summary><code>guardrails.forbidden_topics</code></summary>

Default:

```json
[
  "legal advice",
  "medical advice",
  "whether an insurance policy covers the damage",
  "politics and religion"
]
```

</details>

<a id="conversation"></a>

### Conversation flow

Reply timing, conversation limits and how unusual messages are handled.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `conversation.reply_wait_seconds.whatsapp` | **Wait before replying on WhatsApp.** How long the bot waits after a customer's message on WhatsApp before it answers, so that several quick messages get one reply. Each new message restarts the wait. | whole number, 0 to 900 seconds | `8` | all |  |
| `conversation.reply_wait_seconds.instagram` | **Wait before replying on Instagram.** How long the bot waits after a customer's message on Instagram before it answers, so that several quick messages get one reply. Each new message restarts the wait. | whole number, 0 to 900 seconds | `8` | all |  |
| `conversation.reply_wait_seconds.messenger` | **Wait before replying on Messenger.** How long the bot waits after a customer's message on Messenger before it answers, so that several quick messages get one reply. Each new message restarts the wait. | whole number, 0 to 900 seconds | `8` | all |  |
| `conversation.reply_wait_seconds.widget` | **Wait before replying on Website chat.** How long the bot waits after a customer's message on Website chat before it answers, so that several quick messages get one reply. Each new message restarts the wait. | whole number, 0 to 900 seconds | `4` | all |  |
| `conversation.reply_wait_seconds.email` | **Wait before replying on Email.** How long the bot waits after a customer's message on Email before it answers, so that several quick messages get one reply. Each new message restarts the wait. | whole number, 0 to 900 seconds | `120` | all |  |
| `conversation.max_wait_seconds` | **Longest wait.** A customer who keeps typing is answered after this long at the latest, counted from their first unanswered message. | whole number, 5 to 1800 seconds | `180` | all |  |
| `conversation.typing_indicator` | **Show typing.** The bot shows that it is typing while a reply is being written, on channels that support it. | yes / no | `true` | all |  |
| `conversation.mark_as_read` | **Mark messages as read.** Customer messages are marked as read when the bot starts on its reply, on channels that support it. | yes / no | `true` | all |  |
| `conversation.max_bot_replies` | **Longest conversation.** After this many bot replies in one conversation the bot stops and hands it to a person, so a conversation cannot run on forever. | whole number, 5 to 200 replies | `40` | all |  |
| `conversation.history_messages` | **Messages the bot rereads.** How many of the most recent messages the bot reads before each reply. Older ones are covered by the lead record. Higher is safer for long conversations and costs more. | whole number, 10 to 400 messages | `80` | all |  |
| `conversation.idle_close_hours` | **Close idle conversations after.** A conversation with no message from either side for this long is closed. A customer who writes again later starts a new conversation that still knows the lead. | whole number, 1 to 2160 hours | `168` | all |  |
| `conversation.off_topic` | **Off-topic messages.** What the bot does with questions that have nothing to do with the business. | one of: `redirect`, `brief_answer_then_redirect` | `"redirect"` | all |  |
| `conversation.spam` | **Spam.** What the bot does with obvious spam, scams and bulk advertising. | one of: `no_reply`, `one_polite_reply` | `"no_reply"` | all |  |
| `conversation.existing_customer_requests` | **Questions about existing jobs.** What the bot does when a current customer asks about a job in progress, an invoice or an appointment that it has no information about. | one of: `take_message`, `handoff` | `"take_message"` | all |  |
| `conversation.other_language` | **Messages in another language.** The bot writes English only. This sets what happens when a customer writes in another language. | one of: `reply_in_english`, `handoff` | `"reply_in_english"` | all |  |
| `conversation.profanity` | **Abusive messages.** What the bot does when a customer is abusive toward it, as opposed to upset about a problem. | one of: `stay_calm`, `warn_then_end` | `"stay_calm"` | all |  |

<a id="emergency"></a>

### Emergencies

Which situations are emergencies, what the bot says and who is alerted.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `emergency.enabled` | **Emergency handling.** The bot watches every message for emergencies, puts safety instructions first and alerts the escalation chain. When off, the bot still gives life-safety instructions but nobody is alerted. | yes / no | `true` | all |  |
| `emergency.classes` | **Emergency classes.** The situations treated as emergencies. The bot recognizes them by meaning; the phrases are examples of how customers describe them. For a life-safety class the safety instructions are the first thing the bot says, before any question. | list (up to 30) of entries, see below | see below | all |  |
| `emergency.service_level` | **Emergency service.** When the business responds to emergencies. The bot promises nothing beyond this. | one of: `around_the_clock`, `business_hours`, `none` | `"business_hours"` | all | yes |
| `emergency.customer_instruction` | **What the customer is told to do.** After the safety instructions, how the customer reaches help from the business. | one of: `team_will_call`, `call_emergency_line`, `both` | `"team_will_call"` | all |  |
| `emergency.phone` | **Emergency phone line.** The number customers can call in an emergency. Empty: the bot gives no number and says the team will call. | phone number (stored as E.164), or empty (no emergency line) | `null` | business | yes |
| `emergency.collect` | **Details to collect in an emergency.** Once the customer is safe, the bot asks for these so the team can respond. Qualification questions wait. | any of: `name`, `phone`, `address` | `["name","phone","address"]` | all |  |
| `emergency.vulnerable_people` | **Vulnerable people at home.** A no-heat or no-cooling problem is treated as life safety when the customer mentions someone elderly, an infant or a medical condition. | yes / no | `true` | all |  |
| `emergency.after_hours_note` | **Note on emergency visits.** Something the bot may add about emergency visits, for example "After-hours emergency visits carry an additional fee." Leave it empty to add nothing. | text, up to 300 characters | `""` | all | yes |
| `emergency.escalation_chain` | **Escalation chain.** Who is alerted about an emergency, in order. The first person is alerted at once; if they do not acknowledge in time they are called, and then the next person is alerted. | list (up to 8) of entries, see below | `[]` | business | yes |
| `emergency.acknowledge_minutes` | **Time to acknowledge.** How long each person has to acknowledge an emergency alert before the next step. | whole number, 1 to 60 minutes | `5` | all |  |
| `emergency.call_unacknowledged` | **Call when not acknowledged.** A person who has not acknowledged in time gets a phone call before the chain moves on. | yes / no | `true` | all |  |
| `emergency.rounds` | **Times through the chain.** How many times the whole chain is tried before the agency's fallback contacts are alerted. | whole number, 1 to 5 rounds | `2` | all |  |
| `emergency.fallback_contacts` | **Agency fallback contacts.** Agency staff who are alerted when nobody in a business's chain acknowledges an emergency, or when a business has no chain. | list (up to 8) of entries, see below | `[]` | global |  |
| `emergency.alert_template` | **Emergency alert text.** The text message sent to the escalation chain. Instructions for acknowledging are added automatically. | text (several lines), up to 500 characters; placeholders: {{business_name}}, {{emergency}}, {{contact_name}}, {{contact_phone}}, {{summary}}, {{link}} | see below | all |  |

<details><summary><code>emergency.classes</code></summary>

Structure:

- each emergency class (up to 30):
  - `key` (Key): identifier (lower-case letters, digits, underscores). Identifier used in alerts, reports and analytics.
  - `label` (Name): text, up to 60 characters.
  - `severity` (Severity): one of: `life_safety`, `urgent`.
  - `phrases` (How customers describe it): list (up to 30) of: text, up to 120 characters.
  - `safety_instructions` (Safety instructions): text (several lines), up to 700 characters. What the customer should do right now. The bot gives these instructions as written.
  - `enabled` (Active): yes / no.

Default:

```json
[
  {
    "key": "gas_leak",
    "label": "Gas smell or gas leak",
    "severity": "life_safety",
    "phrases": ["smell gas","gas leak","rotten egg smell","hissing near the gas line"],
    "safety_instructions": "Leave the building right now and take everyone with you. Don't use light switches, appliances or anything that could spark on the way out. Once you are outside, call 911 or your gas utility's emergency line.",
    "enabled": true
  },
  {
    "key": "carbon_monoxide",
    "label": "Carbon monoxide",
    "severity": "life_safety",
    "phrases": ["CO alarm going off","carbon monoxide detector","everyone feels dizzy"],
    "safety_instructions": "Get everyone, pets included, outside into fresh air right now and call 911. Don't go back in until the fire department says it is safe.",
    "enabled": true
  },
  {
    "key": "fire_or_smoke",
    "label": "Fire or smoke",
    "severity": "life_safety",
    "phrases": ["something is on fire","smoke coming from","flames","smoldering"],
    "safety_instructions": "Get everyone out and call 911 now. Don't go back inside for any reason.",
    "enabled": true
  },
  {
    "key": "electrical_hazard",
    "label": "Sparking or electrical burning smell",
    "severity": "life_safety",
    "phrases": [
      "sparks from the outlet",
      "burning smell from the panel",
      "outlet is hot",
      "got shocked",
      "exposed wires"
    ],
    "safety_instructions": "Stay away from anything that is sparking, smoking or hot, and don't touch it. If you can reach the breaker panel safely, switch off that breaker or the main. If you see flames or someone was shocked, call 911.",
    "enabled": true
  },
  {
    "key": "structural_damage",
    "label": "Tree on the house or structural damage",
    "severity": "life_safety",
    "phrases": ["tree fell on the house","ceiling is caving in","roof collapsed","wall is bowing"],
    "safety_instructions": "Get everyone out of the damaged part of the house and stay out. Keep well away from any downed power lines, and call 911 if anyone is hurt or lines are down.",
    "enabled": true
  },
  {
    "key": "flooding",
    "label": "Burst pipe or flooding",
    "severity": "urgent",
    "phrases": ["pipe burst","water pouring","basement is flooding","water everywhere"],
    "safety_instructions": "If you can reach it safely, shut off the water at the main valve. Stay out of standing water near outlets or appliances, and switch off power to that area at the breaker panel only if the panel is dry and easy to reach.",
    "enabled": true
  },
  {
    "key": "sewage_backup",
    "label": "Sewage backup",
    "severity": "urgent",
    "phrases": ["sewage coming up","toilet overflowing with sewage","drains backing up everywhere"],
    "safety_instructions": "Stop using water in the house (toilets, sinks, washer) so it doesn't get worse, and keep children and pets away from the affected area.",
    "enabled": true
  },
  {
    "key": "no_heat",
    "label": "No heat in freezing weather",
    "severity": "urgent",
    "phrases": ["no heat","furnace stopped","heater won't turn on","house is freezing"],
    "safety_instructions": "If the house is getting dangerously cold, or anyone there is elderly, very young or unwell, go somewhere warm. Never heat the home with an oven, a grill or an outdoor heater. To protect the pipes, let faucets drip and open the cabinet doors under sinks.",
    "enabled": true
  },
  {
    "key": "no_cooling",
    "label": "No cooling in extreme heat",
    "severity": "urgent",
    "phrases": ["AC is out","no air conditioning","house is over 90 degrees"],
    "safety_instructions": "If anyone at home is elderly, very young or unwell, move them somewhere cooler and make sure they drink water. Call 911 for signs of heat illness such as confusion or fainting.",
    "enabled": true
  },
  {
    "key": "active_roof_leak",
    "label": "Active roof leak or storm damage",
    "severity": "urgent",
    "phrases": ["water coming through the ceiling","roof is leaking right now","shingles blew off"],
    "safety_instructions": "Stay off the roof and away from any sagging ceiling. Move valuables and put a bucket under the leak. If water is near a light fixture or an outlet, switch off power to that room at the breaker panel if you can reach it safely.",
    "enabled": true
  }
]
```

</details>

<details><summary><code>emergency.escalation_chain</code></summary>

Structure:

- each contact (up to 8):
  - `name` (Name): text, up to 80 characters.
  - `phone` (Mobile number): phone number (stored as E.164). Used for text messages, WhatsApp and the phone call.
  - `email` (Email): email address. Needed only when email is one of the ways to alert this person.
  - `alert_by` (Alert by): any of: `sms`, `whatsapp`, `email`.

</details>

<details><summary><code>emergency.fallback_contacts</code></summary>

Structure:

- each contact (up to 8):
  - `name` (Name): text, up to 80 characters.
  - `phone` (Mobile number): phone number (stored as E.164). Used for text messages, WhatsApp and the phone call.
  - `email` (Email): email address. Needed only when email is one of the ways to alert this person.
  - `alert_by` (Alert by): any of: `sms`, `whatsapp`, `email`.

</details>

<details><summary><code>emergency.alert_template</code></summary>

Structure:

- text (several lines), up to 500 characters; placeholders: {{business_name}}, {{emergency}}, {{contact_name}}, {{contact_phone}}, {{summary}}, {{link}}

Default:

```json
"EMERGENCY for {{business_name}}: {{emergency}}. {{contact_name}}, {{contact_phone}}. {{summary}} {{link}}"
```

</details>

<a id="hours"></a>

### Hours

Business hours, holidays, after-hours behaviour and quiet hours.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `hours.weekly` | **Business hours.** When the office is open, per weekday. A day without hours is closed. | group of values, see below | see below | all | yes |
| `hours.us_federal_holidays` | **Closed on US federal holidays.** The business counts as closed on the federal holidays (New Year's Day, Memorial Day, Independence Day, Labor Day, Thanksgiving, Christmas Day and the others). | yes / no | `true` | all | yes |
| `hours.holidays` | **Other closed days and special hours.** Days with different hours. Leave the hours empty for a day that is closed. | list (up to 120) of entries, see below | `[]` | all | yes |
| `hours.after_hours_mode` | **Outside business hours.** What the bot does when a customer writes while the business is closed. Emergencies are handled at any hour. | one of: `normal`, `set_expectations`, `take_message`, `auto_reply`, `silent` | `"set_expectations"` | all | yes |
| `hours.after_hours_message` | **After-hours message.** What customers are told when the office is closed. Sent as written in the auto-reply mode, and used as guidance in the others. | text (several lines), up to 500 characters; placeholders: {{business_name}}, {{bot_name}} | see below | all | yes |
| `hours.quiet_hours` | **Quiet hours.** No follow-up, reminder or other unprompted message is sent to a customer between these times, in the customer's time zone. Messages that fall in the window wait until it ends. | group of values, see below | `{"enabled":true,"start":"21:00","end":"08:00"}` | all |  |
| `hours.quiet_hours_cover_replies` | **Hold replies during quiet hours.** Replies to a message the customer just sent normally go out at any hour. Turn this on to hold those as well until quiet hours end. Emergency replies are never held. | yes / no | `false` | all |  |
| `hours.customer_time_zone` | **Customer's time zone.** How the customer's local time is worked out for quiet hours. | one of: `business`, `phone_area_code` | `"business"` | all |  |

<details><summary><code>hours.weekly</code></summary>

Structure:

- one entry per weekday, `monday` to `sunday`: a list of up to 4 open intervals `{ "open": "HH:MM", "close": "HH:MM" }` in order; an empty list means closed.

Default:

```json
{
  "monday": [{"open":"08:00","close":"17:00"}],
  "tuesday": [{"open":"08:00","close":"17:00"}],
  "wednesday": [{"open":"08:00","close":"17:00"}],
  "thursday": [{"open":"08:00","close":"17:00"}],
  "friday": [{"open":"08:00","close":"17:00"}],
  "saturday": [],
  "sunday": []
}
```

</details>

<details><summary><code>hours.holidays</code></summary>

Structure:

- each day (up to 120):
  - `date` (Date): date (YYYY-MM-DD).
  - `name` (Occasion): text, up to 80 characters.
  - `hours` (Open): Empty means closed all day.
    - each open interval (up to 4):
      - `open` (Opens): time of day (HH:MM, 24-hour).
      - `close` (Closes): time of day (HH:MM, 24-hour).

</details>

<details><summary><code>hours.after_hours_mode</code></summary>

Structure:

- one of: `normal`, `set_expectations`, `take_message`, `auto_reply`, `silent`

</details>

<details><summary><code>hours.after_hours_message</code></summary>

Structure:

- text (several lines), up to 500 characters; placeholders: {{business_name}}, {{bot_name}}

Default:

```json
"Thanks for reaching out to {{business_name}}! The office is closed right now. I can take down the details so the team can pick this up first thing when we open."
```

</details>

<details><summary><code>hours.quiet_hours</code></summary>

Structure:

- `enabled` (Keep quiet hours): yes / no.
- `start` (Quiet from): time of day (HH:MM, 24-hour).
- `end` (Quiet until): time of day (HH:MM, 24-hour).

</details>

<a id="follow_up"></a>

### Follow-ups

Nudges to customers who stopped replying.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `follow_up.enabled` | **Follow-ups.** The bot nudges customers who stop replying before the conversation has reached an outcome. | yes / no | `true` | all |  |
| `follow_up.max_nudges.whatsapp` | **Nudges on WhatsApp.** The most nudges one silent customer gets on WhatsApp. 0 switches follow-ups off for this channel. | whole number, 0 to 8 nudges | `2` | all |  |
| `follow_up.max_nudges.instagram` | **Nudges on Instagram.** The most nudges one silent customer gets on Instagram. 0 switches follow-ups off for this channel. | whole number, 0 to 8 nudges | `2` | all |  |
| `follow_up.max_nudges.messenger` | **Nudges on Messenger.** The most nudges one silent customer gets on Messenger. 0 switches follow-ups off for this channel. | whole number, 0 to 8 nudges | `2` | all |  |
| `follow_up.max_nudges.widget` | **Nudges on Website chat.** The most nudges one silent customer gets on Website chat. 0 switches follow-ups off for this channel. | whole number, 0 to 8 nudges | `1` | all |  |
| `follow_up.max_nudges.email` | **Nudges on Email.** The most nudges one silent customer gets on Email. 0 switches follow-ups off for this channel. | whole number, 0 to 8 nudges | `3` | all |  |
| `follow_up.delays_minutes.whatsapp` | **Cadence on WhatsApp.** How long to wait before each nudge on WhatsApp: the first number is the wait after the last message, the second the wait after the first nudge, and so on. If there are more nudges than numbers, the last number repeats. | list (up to 8) of: whole number, 1 to 43200 minutes | `[120,1200]` | all |  |
| `follow_up.delays_minutes.instagram` | **Cadence on Instagram.** How long to wait before each nudge on Instagram: the first number is the wait after the last message, the second the wait after the first nudge, and so on. If there are more nudges than numbers, the last number repeats. | list (up to 8) of: whole number, 1 to 43200 minutes | `[120,1200]` | all |  |
| `follow_up.delays_minutes.messenger` | **Cadence on Messenger.** How long to wait before each nudge on Messenger: the first number is the wait after the last message, the second the wait after the first nudge, and so on. If there are more nudges than numbers, the last number repeats. | list (up to 8) of: whole number, 1 to 43200 minutes | `[120,1200]` | all |  |
| `follow_up.delays_minutes.widget` | **Cadence on Website chat.** How long to wait before each nudge on Website chat: the first number is the wait after the last message, the second the wait after the first nudge, and so on. If there are more nudges than numbers, the last number repeats. | list (up to 8) of: whole number, 1 to 43200 minutes | `[5]` | all |  |
| `follow_up.delays_minutes.email` | **Cadence on Email.** How long to wait before each nudge on Email: the first number is the wait after the last message, the second the wait after the first nudge, and so on. If there are more nudges than numbers, the last number repeats. | list (up to 8) of: whole number, 1 to 43200 minutes | `[1440,4320,10080]` | all |  |
| `follow_up.send_window` | **When nudges may be sent.** Nudges that fall outside this window wait for the next allowed moment. | one of: `outside_quiet_hours`, `business_hours` | `"outside_quiet_hours"` | all |  |
| `follow_up.guidance` | **How to nudge.** How the bot writes a nudge. Every nudge is written fresh from the conversation; no two are alike. | text (several lines), up to 800 characters | see below | all |  |
| `follow_up.last_nudge_says_so` | **Announce the last nudge.** The final nudge says that it is the last message and how to get back in touch. | yes / no | `true` | all |  |
| `follow_up.after_outcome` | **Nudge after a "we'll contact you".** Whether a customer who was told the team will be in touch, and then asked something the bot answered, is still nudged when they go quiet. | yes / no | `false` | all |  |
| `follow_up.opt_out_keywords` | **Opt-out words.** A message that consists of one of these words stops every unprompted message to that customer, on every channel of the business. | list (up to 40) of: text, up to 40 characters | `["stop","unsubscribe","cancel","quit","end","opt out","remove me"]` | global, business |  |
| `follow_up.opt_in_keywords` | **Opt-back-in words.** A message that consists of one of these words lifts an earlier opt-out. | list (up to 40) of: text, up to 40 characters | `["start","unstop","subscribe"]` | global, business |  |
| `follow_up.opt_out_confirmation` | **Opt-out confirmation.** The one message a customer gets after opting out. | text, up to 300 characters | see below | all |  |

<details><summary><code>follow_up.guidance</code></summary>

Default:

```json
"Pick up exactly where the conversation stopped. Mention the customer's project in a few words, add one thing that is useful to them, and ask one question that is easy to answer in a word or two. Never guilt, never pressure, never repeat an earlier nudge."
```

</details>

<details><summary><code>follow_up.opt_out_confirmation</code></summary>

Default:

```json
"You won't get any more messages from us. Reply START if you change your mind."
```

</details>

<a id="handoff"></a>

### Handoff and human takeover

When a person takes over a conversation and when the bot resumes.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `handoff.triggers` | **Hand off to a person when.** The situations in which the bot stops and passes the conversation to a person. | any of: `customer_asks_for_person`, `angry_customer`, `complaint_about_past_work`, `legal_threat`, `billing_dispute`, `bot_is_stuck`, `high_value_job` | see below | all |  |
| `handoff.person_request` | **When the customer asks for a person.** How quickly the bot hands off after a customer asks for a person. | one of: `immediately`, `after_contact_details` | `"after_contact_details"` | all |  |
| `handoff.stuck_after_turns` | **Stuck after.** The bot counts as stuck when it has failed to move the conversation forward this many replies in a row. | whole number, 1 to 6 replies | `2` | all |  |
| `handoff.calm_attempts` | **Attempts to calm an angry customer.** How many replies the bot spends acknowledging and calming before it hands off an angry customer. 0 hands off at the first angry message. | whole number, 0 to 3 replies | `1` | all |  |
| `handoff.high_value_usd` | **High-value job.** Jobs the customer describes as at or above this value go to a person, when that trigger is on. | whole number, 0 to 10000000 USD, or empty (not set) | `null` | all |  |
| `handoff.message` | **Handoff message.** How the bot tells the customer that a person is taking over. Guidance, not a script. | text (several lines), up to 500 characters | see below | all |  |
| `handoff.after_hours_message` | **Handoff message outside business hours.** The same, for when nobody can pick up right away. | text (several lines), up to 500 characters | see below | all |  |
| `handoff.auto_release_minutes` | **Give the conversation back to the bot after.** When a person has taken over and neither they nor the customer has written for this long, the bot resumes. Empty: the conversation stays with people until someone releases it. | whole number, 5 to 10080 minutes, or empty (never automatically) | `120` | all |  |
| `handoff.on_release` | **When the bot resumes.** What the bot does when a conversation is released back to it. | one of: `wait_for_customer`, `check_in` | `"wait_for_customer"` | all |  |
| `handoff.provider_inbox_takeover` | **Reply in the provider's inbox takes over.** When someone at the business answers from the provider's own app (Meta Business Suite, the mailbox), the bot steps back as if they had taken over in the admin panel. | yes / no | `true` | all |  |

<details><summary><code>handoff.triggers</code></summary>

Structure:

- any of: `customer_asks_for_person`, `angry_customer`, `complaint_about_past_work`, `legal_threat`, `billing_dispute`, `bot_is_stuck`, `high_value_job`

Default:

```json
[
  "customer_asks_for_person",
  "angry_customer",
  "complaint_about_past_work",
  "legal_threat",
  "billing_dispute",
  "bot_is_stuck"
]
```

</details>

<details><summary><code>handoff.message</code></summary>

Default:

```json
"Say that you are bringing in a member of the team, that they will pick up right here, and that the customer does not need to repeat anything."
```

</details>

<details><summary><code>handoff.after_hours_message</code></summary>

Default:

```json
"Say that you have passed everything to the team and that someone will reply when the office opens. Give the opening time if you know it."
```

</details>

<a id="alerts"></a>

### Alerts

Who is told about leads, and how.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `alerts.events` | **Events that send alerts.** Which events alert the recipients below. Emergencies have their own escalation chain as well. | any of: `lead_qualified`, `meeting_requested`, `handoff`, `emergency`, `lead_disqualified`, `send_failed` | `["lead_qualified","meeting_requested","handoff","emergency"]` | all |  |
| `alerts.recipients` | **Alert recipients.** The people at the business who are alerted, and how each one is reached. | list (up to 20) of entries, see below | `[]` | business | yes |
| `alerts.agency_recipients` | **Agency recipients.** Agency staff who are alerted for every business, in addition to each business's own recipients. | list (up to 20) of entries, see below | `[]` | global |  |
| `alerts.minimum_score` | **Lowest score that alerts.** Qualified-lead alerts are sent only for leads with at least this score. Handoffs and emergencies always alert. | whole number, 0 to 100 points | `0` | all |  |
| `alerts.detail` | **Detail in alerts.** How much of the lead an alert carries. Text messages always stay short. | one of: `summary`, `full_report` | `"summary"` | all |  |
| `alerts.include_contact_details` | **Customer's contact details in alerts.** Alerts include the customer's name and phone number. When off, recipients open the conversation to see them. | yes / no | `true` | all |  |
| `alerts.sms_template` | **Text-message alert.** The text sent by SMS and WhatsApp for lead alerts. | text (several lines), up to 400 characters; placeholders: {{business_name}}, {{band}}, {{score}}, {{contact_name}}, {{contact_phone}}, {{service}}, {{channel}}, {{summary}}, {{link}} | see below | all |  |
| `alerts.email_subject_template` | **Email alert subject.** The subject line of email alerts. | text, up to 200 characters; placeholders: {{business_name}}, {{band}}, {{score}}, {{contact_name}}, {{service}}, {{channel}} | `"{{band}} lead: {{contact_name}}, {{service}}"` | all |  |
| `alerts.hold_overnight` | **Hold alerts overnight.** Alerts about qualified and disqualified leads that arise in this window, in the business's time zone, are sent when it ends. Handoffs, emergencies and delivery failures are never held. | group of values, see below | `{"enabled":false,"start":"21:00","end":"07:00"}` | all | yes |

<details><summary><code>alerts.events</code></summary>

Structure:

- any of: `lead_qualified`, `meeting_requested`, `handoff`, `emergency`, `lead_disqualified`, `send_failed`

</details>

<details><summary><code>alerts.recipients</code></summary>

Structure:

- each recipient (up to 20):
  - `name` (Name): text, up to 80 characters.
  - `email` (Email): email address.
  - `phone` (Mobile number): phone number (stored as E.164). For text messages and WhatsApp.
  - `channels` (Alert by): any of: `email`, `sms`, `whatsapp`.
  - `events` (Alert about): any of: `lead_qualified`, `meeting_requested`, `handoff`, `emergency`, `lead_disqualified`, `send_failed`. Empty: everything that is switched on under "Events that send alerts".
  - `active` (Active): yes / no.

</details>

<details><summary><code>alerts.agency_recipients</code></summary>

Structure:

- each recipient (up to 20):
  - `name` (Name): text, up to 80 characters.
  - `email` (Email): email address.
  - `phone` (Mobile number): phone number (stored as E.164). For text messages and WhatsApp.
  - `channels` (Alert by): any of: `email`, `sms`, `whatsapp`.
  - `events` (Alert about): any of: `lead_qualified`, `meeting_requested`, `handoff`, `emergency`, `lead_disqualified`, `send_failed`. Empty: everything that is switched on under "Events that send alerts".
  - `active` (Active): yes / no.

</details>

<details><summary><code>alerts.sms_template</code></summary>

Structure:

- text (several lines), up to 400 characters; placeholders: {{business_name}}, {{band}}, {{score}}, {{contact_name}}, {{contact_phone}}, {{service}}, {{channel}}, {{summary}}, {{link}}

Default:

```json
"{{band}} lead for {{business_name}} ({{score}}): {{contact_name}}, {{service}}, via {{channel}}. {{link}}"
```

</details>

<details><summary><code>alerts.email_subject_template</code></summary>

Structure:

- text, up to 200 characters; placeholders: {{business_name}}, {{band}}, {{score}}, {{contact_name}}, {{service}}, {{channel}}

</details>

<details><summary><code>alerts.hold_overnight</code></summary>

Structure:

- `enabled` (Hold overnight): yes / no.
- `start` (Hold from): time of day (HH:MM, 24-hour).
- `end` (Send at): time of day (HH:MM, 24-hour).

</details>

<a id="scheduling"></a>

### Scheduling

Calendars, meeting slots, booking rules and reminders.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `scheduling.provider` | **Booking through.** Where meetings are booked. With no calendar, a lead who should be booked is told the team will be in touch (see Routing). | one of: `none`, `google_calendar`, `outlook_calendar`, `calendly` | `"none"` | all |  |
| `scheduling.meeting_type` | **Kind of meeting.** What a booked meeting is. The bot uses the name when it offers times. | one of: `onsite_estimate`, `phone_call`, `video_call`, `showroom_visit` | `"onsite_estimate"` | all | yes |
| `scheduling.slot_minutes` | **Meeting length.** How long one meeting takes. | whole number, 10 to 480 minutes | `60` | all | yes |
| `scheduling.slot_interval_minutes` | **Start times every.** Meetings can start at multiples of this, counted from the start of each open interval. 30 gives 9:00, 9:30, 10:00. | whole number, 5 to 240 minutes | `30` | all |  |
| `scheduling.buffer_before_minutes` | **Free time before a meeting.** Time kept free before each meeting, for travel and preparation. | whole number, 0 to 240 minutes | `0` | all | yes |
| `scheduling.buffer_after_minutes` | **Free time after a meeting.** Time kept free after each meeting. | whole number, 0 to 240 minutes | `30` | all | yes |
| `scheduling.min_lead_time_hours` | **Earliest booking.** A meeting can be booked no sooner than this many hours from now. | whole number, 0 to 720 hours | `24` | all | yes |
| `scheduling.max_days_ahead` | **Latest booking.** A meeting can be booked no further ahead than this. | whole number, 1 to 180 days | `14` | all | yes |
| `scheduling.hours_source` | **Meeting hours.** When meetings can take place. | one of: `business_hours`, `custom` | `"business_hours"` | all | yes |
| `scheduling.custom_hours` | **Custom meeting hours.** Used when meeting hours are set to custom. | group of values, see below | see below | all | yes |
| `scheduling.skip_holidays` | **No meetings on closed days.** Meetings are not offered on holidays and other closed days from the Hours category. | yes / no | `true` | all |  |
| `scheduling.slots_to_offer` | **Times to offer.** How many concrete times the bot offers at once. | whole number, 1 to 5 times | `3` | all |  |
| `scheduling.spread_offers` | **Spread the offered times.** The offered times fall on different days or different parts of the day where possible, instead of the next free slots in a row. | yes / no | `true` | all |  |
| `scheduling.max_meetings_per_day` | **Meetings per day.** No more than this many bot-booked meetings on one day. | whole number, 1 to 50 meetings, or empty (no limit) | `null` | all | yes |
| `scheduling.arrival_window_minutes` | **Arrival window.** For on-site visits: the bot offers a window ("between 9 and 11") of this length instead of an exact time. Empty offers exact times. | whole number, 30 to 480 minutes, or empty (exact times) | `null` | all | yes |
| `scheduling.travel_rules` | **Travel rules by area.** Limits for parts of the service area: jobs in the listed ZIP codes are visited only on the listed days, with extra travel time added around the meeting. | list (up to 30) of entries, see below | `[]` | business | yes |
| `scheduling.event_title` | **Calendar event title.** The title of the calendar event the bot creates. | text, up to 200 characters; placeholders: {{meeting_type}}, {{contact_name}}, {{service}}, {{business_name}} | `"{{meeting_type}}: {{contact_name}} ({{service}})"` | all |  |
| `scheduling.include_report` | **Lead report in the calendar event.** The event description carries the lead report and a link to the conversation. | yes / no | `true` | all |  |
| `scheduling.invite_customer` | **Invite the customer.** The customer is added to the calendar event as a guest when their email address is known. | yes / no | `true` | all |  |
| `scheduling.confirmation_guidance` | **Booking confirmation.** How the bot confirms a booked meeting. Guidance, not a script; the date, the time and the kind of meeting are always stated. | text (several lines), up to 500 characters | see below | all |  |
| `scheduling.allow_reschedule` | **Rescheduling in the conversation.** Customers can move their meeting by asking the bot. | yes / no | `true` | all |  |
| `scheduling.allow_cancel` | **Cancelling in the conversation.** Customers can cancel their meeting by asking the bot. When off, the bot passes the request to the team. | yes / no | `true` | all |  |
| `scheduling.change_cutoff_hours` | **Changes until.** The bot reschedules or cancels up to this many hours before the meeting. Later requests go to the team. | whole number, 0 to 168 hours | `2` | all |  |
| `scheduling.reminders` | **Reminders.** The customer is reminded of a booked meeting. | yes / no | `true` | all |  |
| `scheduling.reminder_minutes_before` | **Remind before the meeting.** One reminder per entry, this many minutes before the meeting. 1440 is a day. | list (up to 4) of: whole number, 10 to 20160 minutes | `[1440,120]` | all |  |
| `scheduling.reminder_asks_confirmation` | **Reminders ask to confirm.** The first reminder asks the customer to confirm they will be there, and offers to reschedule. | yes / no | `true` | all |  |
| `scheduling.calendly_event_type` | **Calendly event type.** The address of the Calendly event type that scheduling links are created for, for example https://calendly.com/summit-roofing/estimate. | web address, or empty (not set) | `null` | business |  |

<details><summary><code>scheduling.meeting_type</code></summary>

Structure:

- one of: `onsite_estimate`, `phone_call`, `video_call`, `showroom_visit`

</details>

<details><summary><code>scheduling.custom_hours</code></summary>

Structure:

- one entry per weekday, `monday` to `sunday`: a list of up to 4 open intervals `{ "open": "HH:MM", "close": "HH:MM" }` in order; an empty list means closed.

Default:

```json
{
  "monday": [{"open":"09:00","close":"16:00"}],
  "tuesday": [{"open":"09:00","close":"16:00"}],
  "wednesday": [{"open":"09:00","close":"16:00"}],
  "thursday": [{"open":"09:00","close":"16:00"}],
  "friday": [{"open":"09:00","close":"16:00"}],
  "saturday": [],
  "sunday": []
}
```

</details>

<details><summary><code>scheduling.travel_rules</code></summary>

Structure:

- each travel rule (up to 30):
  - `name` (Area): text, up to 60 characters.
  - `zip_codes` (ZIP codes): list (up to 500) of: five-digit ZIP code.
  - `days` (Visit days): any of: `monday`, `tuesday`, `wednesday`, `thursday`, `friday`, `saturday`, `sunday`.
  - `extra_travel_minutes` (Extra travel time): whole number, 0 to 240 minutes.

</details>

<details><summary><code>scheduling.event_title</code></summary>

Structure:

- text, up to 200 characters; placeholders: {{meeting_type}}, {{contact_name}}, {{service}}, {{business_name}}

</details>

<details><summary><code>scheduling.confirmation_guidance</code></summary>

Default:

```json
"Confirm the day, date and time in the customer's words, say what happens at the meeting and who is coming, and mention that they can reschedule right here if something comes up."
```

</details>

<a id="channels"></a>

### Channels

Options of the website widget, WhatsApp, Instagram, Messenger and email.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `channels.widget.primary_color` | **Color.** The color of the chat bubble, the header and the visitor's messages. | color (#rrggbb) | `"#1d4ed8"` | all | yes |
| `channels.widget.text_color` | **Text color on the color.** The color of text and icons shown on top of the color above. Pick one that is easy to read. | color (#rrggbb) | `"#ffffff"` | all | yes |
| `channels.widget.logo_url` | **Logo.** Address of a square logo shown in the chat header. Empty shows the bot's initial. | web address, or empty (no logo) | `null` | business | yes |
| `channels.widget.title` | **Header title.** The title at the top of the chat window. | text, up to 60 characters; placeholders: {{business_name}}, {{bot_name}} | `"{{business_name}}"` | all | yes |
| `channels.widget.subtitle` | **Header subtitle.** The line under the title. Leave it empty for none. | text, up to 80 characters; placeholders: {{business_name}}, {{bot_name}} | `"We usually reply in under a minute"` | all | yes |
| `channels.widget.teaser` | **Teaser next to the bubble.** A short line shown beside the closed chat bubble to invite a message. Leave it empty for none. | text, up to 80 characters; placeholders: {{business_name}}, {{bot_name}} | `""` | all | yes |
| `channels.widget.position` | **Position.** The corner of the page the chat bubble sits in. | one of: `bottom_right`, `bottom_left` | `"bottom_right"` | all | yes |
| `channels.widget.auto_open_seconds` | **Open by itself after.** The chat window opens on its own this long after the page loads, once per visitor. On phones it never opens by itself. | whole number, 0 to 600 seconds, or empty (never) | `null` | all | yes |
| `channels.widget.pre_chat_fields` | **Ask before the chat starts.** Details a visitor must fill in before the first message. With none, the chat starts at once and the bot asks during the conversation. | any of: `name`, `phone`, `email` | `[]` | all |  |
| `channels.widget.photo_upload` | **Photo upload.** Visitors can attach photos in the chat. | yes / no | `true` | all |  |
| `channels.widget.max_upload_mb` | **Largest photo.** Photos above this size are refused with a friendly message. | whole number, 1 to 25 MB | `10` | all |  |
| `channels.widget.show_hours_notice` | **Show when the office is closed.** Outside business hours the chat window says that the office is closed and when it opens. | yes / no | `true` | all | yes |
| `channels.widget.consent_text` | **Privacy note.** A line shown under the message box, for example "By chatting you agree to our privacy policy." Leave it empty for none. | text, up to 300 characters | `""` | all | yes |
| `channels.widget.privacy_url` | **Privacy policy link.** The privacy note links here when both are set. | web address, or empty (no link) | `null` | all | yes |
| `channels.widget.session_days` | **Remember a visitor for.** A returning visitor sees their earlier conversation for this long. | whole number, 1 to 365 days | `30` | all |  |
| `channels.widget.allowed_origins` | **Websites that may show the chat.** The chat only works on these sites. Add every address the site is served from, for example https://www.example.com and https://example.com. With none, the chat works nowhere. | list (up to 30) of: site origin (scheme and host, no path) | `[]` | business |  |
| `channels.whatsapp.voice_messages` | **Voice messages.** What happens when a customer sends a voice message. | one of: `ask_to_type`, `transcribe` | `"ask_to_type"` | all |  |
| `channels.whatsapp.buttons` | **Buttons and lists.** The bot may offer tap-to-answer buttons and lists where they make a question easier, such as picking a time. | yes / no | `true` | all |  |
| `channels.whatsapp.follow_up_template` | **Follow-up template.** Name of the approved message template used for nudges outside the 24-hour window. Empty: no nudge is sent once the window has closed. | text, up to 120 characters, or empty (no template) | `null` | all |  |
| `channels.whatsapp.reminder_template` | **Reminder template.** Name of the approved message template used for meeting reminders outside the 24-hour window. Empty: such reminders are skipped on WhatsApp. | text, up to 120 characters, or empty (no template) | `null` | all |  |
| `channels.whatsapp.template_language` | **Template language.** The language code the templates above were approved in. | text, up to 10 characters | `"en_US"` | all |  |
| `channels.meta.quick_replies` | **Quick replies.** The bot may offer tap-to-answer quick replies on Instagram and Messenger. | yes / no | `true` | all |  |
| `channels.instagram.story_replies` | **Replies to stories.** What the bot does when someone replies to one of the business's Instagram stories. | one of: `reply`, `ignore` | `"reply"` | all |  |
| `channels.meta.reactions` | **Reactions.** What the bot does when a customer reacts to a message with an emoji instead of writing. | one of: `ignore`, `treat_as_reply` | `"ignore"` | all |  |
| `channels.email.from_name` | **Sender name.** The name customers see as the sender of the bot's emails. | text, up to 80 characters; placeholders: {{business_name}}, {{bot_name}} | `"{{bot_name}} at {{business_name}}"` | all | yes |
| `channels.email.signature` | **Signature.** Added to the end of every email the bot sends. | text (several lines), up to 800 characters; placeholders: {{business_name}}, {{bot_name}}, {{business_phone}}, {{business_website}} | `"{{bot_name}}\n{{business_name}}\n{{business_phone}}"` | all | yes |
| `channels.email.greeting` | **Greeting.** How emails open. | one of: `hi_first_name`, `hello_first_name`, `dear_full_name` | `"hi_first_name"` | all |  |
| `channels.email.sign_off` | **Sign-off.** The line before the signature. | text, up to 40 characters | `"Best,"` | all | yes |
| `channels.email.reply_to` | **Reply to.** Who gets the bot's reply when the customer's email had other people in copy. | one of: `all`, `sender` | `"all"` | all |  |
| `channels.email.quote_original` | **Quote the customer's email.** The customer's message is quoted below the reply, as mail programs do. | yes / no | `true` | all |  |
| `channels.email.skip_staffed_threads` | **Stay out of threads the team is in.** The bot does not reply in an email thread where someone at the business has already written. Turn this off only for an inbox that the bot alone answers. | yes / no | `true` | all |  |
| `channels.email.internal_domains` | **Internal domains.** Mail from these domains is treated as internal and never answered. The inbox's own domain is always internal. | list (up to 30) of: domain name | `[]` | all |  |
| `channels.email.ignored_senders` | **Senders to ignore.** Addresses the bot never answers, such as suppliers or a ticketing system. Newsletters, automatic replies and bounces are ignored without being listed. | list (up to 200) of: email address | `[]` | all | yes |
| `channels.email.max_replies_per_thread_per_day` | **Replies per thread per day.** The bot sends no more than this many replies in one thread on one day. It stops two auto-responders from answering each other forever. | whole number, 1 to 50 replies | `8` | all |  |
| `channels.email.max_sends_per_hour` | **Emails per hour.** The most emails the bot sends from one inbox in an hour. Further replies wait. | whole number, 1 to 1000 emails | `60` | all |  |
| `channels.email.max_sends_per_day` | **Emails per day.** The most emails the bot sends from one inbox in a day. Keep it below the mail provider's own limit. | whole number, 1 to 10000 emails | `400` | all |  |

<details><summary><code>channels.widget.title</code></summary>

Structure:

- text, up to 60 characters; placeholders: {{business_name}}, {{bot_name}}

</details>

<details><summary><code>channels.widget.subtitle</code></summary>

Structure:

- text, up to 80 characters; placeholders: {{business_name}}, {{bot_name}}

</details>

<details><summary><code>channels.widget.teaser</code></summary>

Structure:

- text, up to 80 characters; placeholders: {{business_name}}, {{bot_name}}

</details>

<details><summary><code>channels.email.from_name</code></summary>

Structure:

- text, up to 80 characters; placeholders: {{business_name}}, {{bot_name}}

</details>

<details><summary><code>channels.email.signature</code></summary>

Structure:

- text (several lines), up to 800 characters; placeholders: {{business_name}}, {{bot_name}}, {{business_phone}}, {{business_website}}

</details>

<a id="integrations"></a>

### CRM and webhooks

When leads are pushed to a CRM, field mapping and outgoing webhooks.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `integrations.sync_events` | **Send leads to the CRM when.** The events that create or update the lead in every connected CRM. | any of: `lead_qualified`, `meeting_requested`, `handoff`, `lead_disqualified`, `emergency` | `["lead_qualified","meeting_requested","handoff"]` | all |  |
| `integrations.minimum_score` | **Lowest score sent to the CRM.** Leads below this score stay out of the CRM. Handoffs and emergencies are always sent when their event is switched on. | whole number, 0 to 100 points | `0` | all |  |
| `integrations.update_on_change` | **Keep the CRM record up to date.** After the first push, later changes to the lead (new answers, a new score, a booking) update the same CRM record. | yes / no | `true` | all |  |
| `integrations.duplicates` | **People already in the CRM.** What happens when the CRM already has a contact with the same phone number or email address. | one of: `update_existing`, `always_create` | `"update_existing"` | all |  |
| `integrations.include_report` | **Lead report in the CRM.** The written lead report is added to the CRM record as a note. | yes / no | `true` | all |  |
| `integrations.include_transcript` | **Conversation in the CRM.** The conversation transcript is added to the CRM record as a note. Off by default: the report carries a link to the conversation. | yes / no | `false` | all |  |
| `integrations.lead_source` | **Lead source.** The value written to the CRM's lead-source field. | text, up to 80 characters | `"AI assistant"` | all |  |
| `integrations.tags` | **Tags.** Tags added to the CRM record, in CRMs that have tags. | list (up to 20) of: text, up to 60 characters | `["ai-assistant"]` | all |  |
| `integrations.field_mapping.hubspot` | **HubSpot field mapping.** Which of our lead fields go into which HubSpot fields. Empty uses the standard mapping for HubSpot; with entries, exactly the listed fields are sent. | list (up to 80) of entries, see below | `[]` | all |  |
| `integrations.field_mapping.gohighlevel` | **GoHighLevel field mapping.** Which of our lead fields go into which GoHighLevel fields. Empty uses the standard mapping for GoHighLevel; with entries, exactly the listed fields are sent. | list (up to 80) of entries, see below | `[]` | all |  |
| `integrations.field_mapping.jobber` | **Jobber field mapping.** Which of our lead fields go into which Jobber fields. Empty uses the standard mapping for Jobber; with entries, exactly the listed fields are sent. | list (up to 80) of entries, see below | `[]` | all |  |
| `integrations.field_mapping.housecall_pro` | **Housecall Pro field mapping.** Which of our lead fields go into which Housecall Pro fields. Empty uses the standard mapping for Housecall Pro; with entries, exactly the listed fields are sent. | list (up to 80) of entries, see below | `[]` | all |  |
| `integrations.field_mapping.servicetitan` | **ServiceTitan field mapping.** Which of our lead fields go into which ServiceTitan fields. Empty uses the standard mapping for ServiceTitan; with entries, exactly the listed fields are sent. | list (up to 80) of entries, see below | `[]` | all |  |
| `integrations.webhooks` | **Webhook targets.** Addresses that receive a signed HTTPS request for the chosen events of this business. Works with Zapier, Make and your own systems. | list (up to 10) of entries, see below | `[]` | business |  |
| `integrations.agency_webhooks` | **Agency webhook targets.** Addresses that receive the chosen events of every business, in addition to each business's own targets. | list (up to 10) of entries, see below | `[]` | global |  |
| `integrations.webhook_include_transcript` | **Conversation in webhook payloads.** Webhook requests carry the conversation transcript in addition to the lead and its report. | yes / no | `false` | all |  |

<details><summary><code>integrations.sync_events</code></summary>

Structure:

- any of: `lead_qualified`, `meeting_requested`, `handoff`, `lead_disqualified`, `emergency`

</details>

<details><summary><code>integrations.field_mapping.hubspot</code></summary>

Structure:

- each mapping (up to 80):
  - `source` (Our field): text, up to 120 characters. A path into the lead payload, for example contact.phone, lead.score or lead.fields.timeline.
  - `target` (CRM field): text, up to 120 characters. The field's name in the CRM, as its API calls it.
  - `transform` (Convert to): one of: `string`, `number`, `boolean`, `date`, `phone_e164`, or empty (as it is).

</details>

<details><summary><code>integrations.field_mapping.gohighlevel</code></summary>

Structure:

- each mapping (up to 80):
  - `source` (Our field): text, up to 120 characters. A path into the lead payload, for example contact.phone, lead.score or lead.fields.timeline.
  - `target` (CRM field): text, up to 120 characters. The field's name in the CRM, as its API calls it.
  - `transform` (Convert to): one of: `string`, `number`, `boolean`, `date`, `phone_e164`, or empty (as it is).

</details>

<details><summary><code>integrations.field_mapping.jobber</code></summary>

Structure:

- each mapping (up to 80):
  - `source` (Our field): text, up to 120 characters. A path into the lead payload, for example contact.phone, lead.score or lead.fields.timeline.
  - `target` (CRM field): text, up to 120 characters. The field's name in the CRM, as its API calls it.
  - `transform` (Convert to): one of: `string`, `number`, `boolean`, `date`, `phone_e164`, or empty (as it is).

</details>

<details><summary><code>integrations.field_mapping.housecall_pro</code></summary>

Structure:

- each mapping (up to 80):
  - `source` (Our field): text, up to 120 characters. A path into the lead payload, for example contact.phone, lead.score or lead.fields.timeline.
  - `target` (CRM field): text, up to 120 characters. The field's name in the CRM, as its API calls it.
  - `transform` (Convert to): one of: `string`, `number`, `boolean`, `date`, `phone_e164`, or empty (as it is).

</details>

<details><summary><code>integrations.field_mapping.servicetitan</code></summary>

Structure:

- each mapping (up to 80):
  - `source` (Our field): text, up to 120 characters. A path into the lead payload, for example contact.phone, lead.score or lead.fields.timeline.
  - `target` (CRM field): text, up to 120 characters. The field's name in the CRM, as its API calls it.
  - `transform` (Convert to): one of: `string`, `number`, `boolean`, `date`, `phone_e164`, or empty (as it is).

</details>

<details><summary><code>integrations.webhooks</code></summary>

Structure:

- each webhook (up to 10):
  - `name` (Name): text, up to 60 characters.
  - `url` (Address): web address. Must start with https://.
  - `events` (Events): any of: `lead_qualified`, `meeting_requested`, `handoff`, `lead_disqualified`, `emergency`.
  - `active` (Active): yes / no.

</details>

<details><summary><code>integrations.agency_webhooks</code></summary>

Structure:

- each webhook (up to 10):
  - `name` (Name): text, up to 60 characters.
  - `url` (Address): web address. Must start with https://.
  - `events` (Events): any of: `lead_qualified`, `meeting_requested`, `handoff`, `lead_disqualified`, `emergency`.
  - `active` (Active): yes / no.

</details>

<a id="knowledge"></a>

### Knowledge

How business knowledge is gathered and used in replies.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `knowledge.core_categories` | **Facts in every reply.** Knowledge of these kinds is always in front of the bot. Everything else is looked up when a message calls for it. | any of: `services`, `service_area`, `hours`, `licenses`, `warranties`, `financing`, `team`, `brands`, `reviews`, `differentiators`, `pricing`, `policies`, `faq`, `other` | see below | all |  |
| `knowledge.retrieval_limit` | **Facts looked up per message.** The most additional facts the bot looks up for one customer message. | whole number, 1 to 30 facts | `8` | all |  |
| `knowledge.use_reviews` | **Mention reviews.** The bot may mention ratings and reviews that are in the business's knowledge. It never quotes a review that is not there. | yes / no | `true` | all |  |
| `knowledge.website_crawl` | **Read the business website.** Facts are also collected from the business's own website. Imported and hand-edited facts always win over what the website says. | yes / no | `false` | all |  |
| `knowledge.crawl_max_pages` | **Website pages to read.** The most pages read from the website in one pass. | whole number, 1 to 200 pages | `25` | all |  |
| `knowledge.stale_after_days` | **Flag facts older than.** Facts that have not been confirmed for this long are flagged for review in the knowledge editor. The bot keeps using them. | whole number, 30 to 1095 days, or empty (never flag) | `365` | all |  |
| `knowledge.playbook_research_searches` | **Web searches per research step.** A segment's playbook is researched on the web in three steps before it is written. This is the most searches the model may run in each step. More searches take longer and cost more. | whole number, 1 to 15 searches | `5` | global, segment |  |

<details><summary><code>knowledge.core_categories</code></summary>

Structure:

- any of: `services`, `service_area`, `hours`, `licenses`, `warranties`, `financing`, `team`, `brands`, `reviews`, `differentiators`, `pricing`, `policies`, `faq`, `other`

Default:

```json
["services","service_area","hours","licenses","warranties","financing"]
```

</details>

<a id="client_portal"></a>

### Client portal

What the business's own users may see and do when they have a login.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `client_portal.enabled` | **Client logins.** The business's own users can sign in to a limited view of their business. When off, their logins show nothing. This is the master switch; the settings below narrow what they get. | yes / no | `false` | business |  |
| `client_portal.view_conversations` | **See conversations.** Who may read the business's conversations. | one of: `nobody`, `owner`, `owner_and_staff` | `"owner_and_staff"` | all |  |
| `client_portal.reply_and_take_over` | **Take over and reply.** Who may take a conversation over from the bot and answer customers themselves. | one of: `nobody`, `owner`, `owner_and_staff` | `"nobody"` | all |  |
| `client_portal.view_leads` | **See leads.** Who may see the lead list with scores. | one of: `nobody`, `owner`, `owner_and_staff` | `"owner_and_staff"` | all |  |
| `client_portal.view_lead_reports` | **See lead reports.** Who may read the written lead reports, which include red flags and candid notes. | one of: `nobody`, `owner`, `owner_and_staff` | `"owner"` | all |  |
| `client_portal.export_leads` | **Export leads.** Who may download the lead list as a file. | one of: `nobody`, `owner`, `owner_and_staff` | `"owner"` | all |  |
| `client_portal.view_analytics` | **See analytics.** Who may see the business's analytics. | one of: `nobody`, `owner`, `owner_and_staff` | `"owner"` | all |  |
| `client_portal.edit_knowledge` | **Edit knowledge.** Who may edit the business's knowledge: services, hours, warranties and the rest. | one of: `nobody`, `owner`, `owner_and_staff` | `"nobody"` | all |  |
| `client_portal.edit_settings` | **Edit settings.** Who may change the settings that are marked "client may edit", such as business hours, alert recipients and the bot's name. Every other setting stays with the agency. | one of: `nobody`, `owner`, `owner_and_staff` | `"owner"` | all |  |

<a id="model"></a>

### Model and effort

Which Claude model does each task, and how hard it thinks.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `model.reply.model` | **Replies: model.** The Claude model that writes the replies to customers. | Claude model id | `"claude-fable-5-2"` | all |  |
| `model.reply.effort` | **Replies: effort.** How hard the model thinks. Higher effort is slower and costs more; for customer replies it also means a longer wait. | one of: `low`, `medium`, `high`, `xhigh`, `max` | `"medium"` | all |  |
| `model.follow_up.model` | **Follow-ups: model.** The Claude model that writes nudges and reminders. | Claude model id | `"claude-fable-5-2"` | all |  |
| `model.follow_up.effort` | **Follow-ups: effort.** How hard the model thinks. Higher effort is slower and costs more; for customer replies it also means a longer wait. | one of: `low`, `medium`, `high`, `xhigh`, `max` | `"medium"` | all |  |
| `model.photo_analysis.model` | **Photo analysis: model.** The Claude model that looks at the photos customers send. | Claude model id | `"claude-fable-5-2"` | all |  |
| `model.photo_analysis.effort` | **Photo analysis: effort.** How hard the model thinks. Higher effort is slower and costs more; for customer replies it also means a longer wait. | one of: `low`, `medium`, `high`, `xhigh`, `max` | `"medium"` | all |  |
| `model.playbook.model` | **Playbook generation: model.** The Claude model that researches and writes the industry playbook of a new segment. | Claude model id | `"claude-fable-5-2"` | all |  |
| `model.playbook.effort` | **Playbook generation: effort.** How hard the model thinks. Higher effort is slower and costs more; for customer replies it also means a longer wait. | one of: `low`, `medium`, `high`, `xhigh`, `max` | `"high"` | all |  |
| `model.knowledge_extraction.model` | **Knowledge extraction: model.** The Claude model that turns imported data and website pages into knowledge facts. | Claude model id | `"claude-fable-5-2"` | all |  |
| `model.knowledge_extraction.effort` | **Knowledge extraction: effort.** How hard the model thinks. Higher effort is slower and costs more; for customer replies it also means a longer wait. | one of: `low`, `medium`, `high`, `xhigh`, `max` | `"medium"` | all |  |
| `model.reply_max_output_tokens` | **Room for a reply.** The most tokens one reply request may produce, thinking included. Too little cuts replies off and forces a retry; this is a ceiling, not a target. | whole number, 2000 to 64000 tokens | `16000` | all |  |
| `model.max_tool_rounds` | **Steps per reply.** How many rounds of actions (updating the lead, looking up times, analyzing a photo) the model may take before it must answer. | whole number, 1 to 15 rounds | `6` | all |  |
| `model.server_side_fallbacks` | **Fallback model.** When the model declines a request, the Claude API retries it on a fallback model inside the same call, so the customer still gets an answer. If the fallback declines too, the conversation goes to a person. | yes / no | `true` | all |  |
| `model.cache_ttl` | **Prompt cache lifetime.** How long the stable part of a business's prompt stays cached between requests. One hour costs more to write and pays off for businesses with few conversations a day. | one of: `5m`, `1h` | `"5m"` | all |  |

<a id="limits"></a>

### Limits and spend caps

Rate limits and model-spend caps that stop floods and runaway cost.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `limits.contact_messages_per_hour` | **Messages answered per customer per hour.** Messages beyond this from one customer in an hour are stored but not answered by the bot. | whole number, 5 to 500 messages | `60` | all |  |
| `limits.contact_replies_per_day` | **Bot replies per customer per day.** The most replies the bot writes to one customer in a day. | whole number, 5 to 500 replies | `100` | all |  |
| `limits.business_replies_per_day` | **Bot replies per business per day.** The most replies the bot writes for one business in a day. | whole number, 10 to 100000 replies, or empty (no limit) | `3000` | all |  |
| `limits.contact_daily_spend_usd` | **Model spend per customer per day.** When the model cost of one customer's conversations reaches this in a day, the bot stops replying to them until the next day. | number, 0.1 to 1000 USD, or empty (no cap) | `5` | all |  |
| `limits.business_daily_spend_usd` | **Model spend per business per day.** When the model cost of one business reaches this in a day, the bot pauses for that business until the next day. | number, 1 to 100000 USD, or empty (no cap) | `100` | all |  |
| `limits.business_monthly_spend_usd` | **Model spend per business per month.** When the model cost of one business reaches this in a calendar month, the bot pauses for that business until the next month. | number, 1 to 1000000 USD, or empty (no cap) | `null` | all |  |
| `limits.agency_daily_spend_usd` | **Model spend for the whole agency per day.** When the model cost across all businesses reaches this in a day, the bot pauses everywhere until the next day. | number, 1 to 1000000 USD, or empty (no cap) | `null` | global |  |
| `limits.on_limit` | **When a limit is reached.** What happens to conversations that hit a limit or a spend cap. The agency is alerted in both cases. | one of: `pause_bot`, `handoff` | `"pause_bot"` | all |  |
| `limits.max_inbound_characters` | **Longest customer message.** The bot reads this much of a single customer message; the rest is kept in the inbox but not given to the model. | whole number, 500 to 50000 characters | `6000` | all |  |
| `limits.widget_messages_per_minute` | **Website chat: messages per visitor per minute.** A visitor who sends more than this in a minute is asked to slow down. | whole number, 3 to 120 messages | `12` | all |  |
| `limits.widget_sessions_per_ip_per_hour` | **Website chat: new visitors per address per hour.** The most new chat sessions from one network address in an hour. | whole number, 1 to 1000 sessions | `30` | all |  |

<a id="data"></a>

### Data retention

How long conversations, files and model records are kept.

| Key | Setting | Type | Default | Scopes | Client may edit |
| --- | --- | --- | --- | --- | --- |
| `data.conversation_retention_days` | **Keep conversations for.** Conversations and their messages are deleted this long after the conversation was closed. | whole number, 30 to 3650 days, or empty (keep) | `730` | all |  |
| `data.attachment_retention_days` | **Keep photos and files for.** Photos and files customers sent are deleted this long after they arrived. Their descriptions stay in the lead report. | whole number, 7 to 3650 days, or empty (keep) | `365` | all |  |
| `data.lead_retention_days` | **Keep leads for.** Leads, their scores and reports are deleted this long after the last change. | whole number, 30 to 3650 days, or empty (keep) | `null` | all |  |
| `data.model_call_retention_days` | **Keep model records for.** The full inputs and outputs of model calls are deleted after this long. Token counts and costs are kept. | whole number, 1 to 730 days | `90` | all |  |
| `data.store_model_io` | **Store model inputs and outputs.** Every model call is stored with its full request and response, for audits and for improving the bot. When off, only token counts, timing and cost are stored. | yes / no | `true` | all |  |
| `data.audit_log_retention_days` | **Keep the audit log for.** Audit entries older than this are deleted. | whole number, 90 to 3650 days, or empty (keep) | `1095` | global |  |
