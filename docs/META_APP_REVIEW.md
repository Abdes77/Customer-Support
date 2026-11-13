# Meta App Review pack

What to submit to Meta so that the agency's app may be used with its clients' WhatsApp numbers,
Facebook Pages and Instagram accounts: the permissions and features to request with a
justification for each, the screencast to record, and the instructions that let Meta's reviewers
test the app. It is HUMAN_TODO step 36; submit after steps 29 and 30 pass with test users,
because the screencast must show each permission working.

**Status:** prepared from Meta's documentation as read on 2026-11-12 and from the code. Nothing
has been submitted, and the review forms were not seen: field names in Meta's dashboard may
differ. Meta asks for one screencast per permission (or one that clearly shows each); keep each
recording short and narrated or captioned in English.

## Before you submit

- **Business verification** of the agency's business portfolio is complete (step 10).
- **App settings, Basic:** app icon, privacy policy URL, terms of service URL, a data-deletion
  instructions URL (or callback), the app's category, and a contact email. The privacy policy
  must say what the app stores (conversations, contact details, lead reports), for how long (the
  `data.*` settings), that replies are written with the Claude API, and how a person asks for
  deletion.
- **App domains** and the **Facebook Login for Business** and **WhatsApp Embedded Signup**
  configurations exist (step 10), with `<APP_URL>` as the domain.
- **A reviewer account** in the admin panel (below) and a test business with nothing private in
  it.
- The app is in **Live** mode only after approval; until then everyone in the screencast must
  have a role on the app (administrator, developer or tester).

## Permissions and features to request

### WhatsApp (Tech Provider, Embedded Signup)

| Permission | What the app does with it | Where in the product |
| --- | --- | --- |
| `whatsapp_business_management` | During Embedded Signup the client shares their WhatsApp Business account with the app. The app reads the account's phone numbers to connect the chosen one, subscribes the app to the account's webhooks, registers the number, and creates, lists and deletes the message templates the bot needs outside the 24-hour window (follow-ups, a staff reply after 24 hours, appointment reminders). It also receives template status, account and quality updates. | Business, Channels, WhatsApp: "Connect with Facebook" and the templates list |
| `whatsapp_business_messaging` | Receives customers' messages (text, photos, voice notes, locations, button replies) through the webhook and sends the business's replies: text, photos, reply buttons and lists, read receipts and the typing indicator inside the 24-hour customer-service window, and approved templates outside it. | Every WhatsApp conversation; the inbox for a person's replies |

Suggested text for the justification of each: "Our app is a customer-service assistant for US
home-services businesses (roofers, plumbers, HVAC and electrical contractors). Each business
connects its own WhatsApp Business number through Embedded Signup. When a homeowner writes to
the business, the app answers their questions about the job, collects the details the business
needs (type of job, address, timeline) and hands the conversation to the business's staff,
who can also reply from our inbox. [Then the row's text.] Messages are sent only in reply to
customers who wrote first, or as approved utility templates."

### Messenger and Instagram (Facebook Login for Business)

| Permission or feature | What the app does with it | Where in the product |
| --- | --- | --- |
| `pages_show_list` | Lists the Pages the client chose in Facebook Login so agency staff can pick the one to connect. | Business, Channels, Messenger and Instagram: "Connect with Facebook" |
| `pages_manage_metadata` | Subscribes the chosen Page to the app's webhooks (`subscribed_apps`) so customers' messages reach the app, and unsubscribes it on disconnect. | The same connect and disconnect buttons |
| `pages_messaging` | Receives the Page's messages, postbacks, reactions, delivery and read events, and sends the business's replies: text, photos and quick replies, the "seen" and typing indicators, inside the 24-hour window. | Every Messenger conversation; the inbox |
| `instagram_basic` | Reads the Instagram professional account linked to the Page (its id and username) to connect it. | The connect flow |
| `instagram_manage_messages` | Receives Instagram Direct messages, story replies and reactions, and sends the business's replies (text, photos, quick replies) inside the 24-hour window. | Every Instagram conversation; the inbox |
| `business_management` | Facebook Login for Business with a system-user access token: reads the client business's assets that were shared with the app so that the Page and Instagram account can be connected without a personal token that expires. | The connect flow |
| **Human Agent** feature | When a person at the business takes a conversation over in our inbox, their reply may be sent up to seven days after the customer's last message with the `HUMAN_AGENT` tag. The bot itself never uses the tag: its messages are refused after 24 hours. | Inbox, "Take over", then a reply to a conversation older than 24 hours |

Suggested justification for the Human Agent feature: "Home-services jobs often need a person
to follow up after a site visit or a quote, which can be more than 24 hours after the
customer's last message. Our app sends the HUMAN_AGENT tag only on messages a person at the
business writes in our inbox after taking the conversation over; automated messages never
carry it and stop at 24 hours."

## Screencast script

Record at 1280×800 or larger, with the browser's address bar visible. About five minutes in
total; cut it into one clip per permission if the form asks for that. Use the reviewer agency and
its test business, Meta's test WhatsApp number, and a test Page with its Instagram account.

1. **Sign in** at `<APP_URL>/sign-in` with the reviewer account. Show the business list and open
   the test business. (Caption: "Agency staff manage each client business here.")
2. **WhatsApp Embedded Signup** (`whatsapp_business_management`): Channels, WhatsApp, "Connect
   with Facebook". Go through Meta's dialog, choose the WhatsApp Business account and number,
   finish. Show the page now listing the connected number. Open the templates list, create
   `follow_up_check_in` from the suggestions, and show it as pending.
3. **WhatsApp messaging** (`whatsapp_business_messaging`): on a phone (screen-recorded next to
   the browser), write "Hi, my roof is leaking after the storm" to the business number. Show
   the blue ticks and "typing…", then the reply. Answer two questions. In the admin panel, open
   the Inbox, the conversation and its lead panel (score and report).
4. **Messenger connect** (`pages_show_list`, `pages_manage_metadata`, `business_management`,
   `instagram_basic`): Channels, Messenger and Instagram, "Connect with Facebook". In Facebook
   Login for Business choose the test Page and its Instagram account, finish, and show both
   listed as connected.
5. **Messenger messaging** (`pages_messaging`): from a tester's Messenger account write to the
   Page. Show "seen", typing and the reply with its quick-reply buttons; tap one.
6. **Instagram messaging** (`instagram_manage_messages`): from a tester's Instagram account send
   a Direct message to the business account; show the reply.
7. **A person takes over** (Human Agent): in the inbox open the Messenger conversation, "Take
   over", write a reply, send it, and show it arriving in Messenger. Explain in a caption that
   replies after 24 hours are only allowed for such human replies and carry the `HUMAN_AGENT`
   tag; if possible, show a conversation older than 24 hours (prepared in advance) receiving a
   person's reply. Then "Release to the bot".
8. **Disconnect**: on the Channels page, disconnect the Page and show it as disconnected
   (Caption: "Unsubscribes the Page from our app.")

## Instructions for Meta's reviewers (test credentials)

Paste into the review form's "instructions" field, with the values filled in:

> 1. Open `<APP_URL>/sign-in` and sign in with **email** `<reviewer email>` and **password**
>    `<reviewer password>`. This account sees one test business, "Meta Review Roofing".
> 2. To connect WhatsApp: open the business, then **Channels**, **WhatsApp**, **Connect with
>    Facebook**, and use the test WhatsApp Business account we added you to (`<WABA name>`).
> 3. To connect Messenger and Instagram: **Channels**, **Messenger and Instagram**, **Connect
>    with Facebook**, and choose the Page `<test Page name>`, to which we gave your test user a
>    role. Its Instagram account is `<@test account>`.
> 4. To see the bot answer: send a WhatsApp message to `<test number>`, or a message to the
>    Page or the Instagram account. Replies arrive within about ten seconds.
> 5. To see a person's reply: open **Inbox**, choose the conversation, **Take over**, write a
>    reply and press **Send reply**.
>
> The bot only answers people who wrote to the business first. Templates are sent only outside
> the 24-hour window as approved utility templates.

To prepare it:

1. Create the reviewer as an agency admin of a separate reviewer agency (step 20's command with
   a new slug, for example `--agency "Meta Review" --slug meta-review --email
   <reviewer email>`), and onboard a test business "Meta Review Roofing" in it with the test
   chat working. Use a strong password and delete the account after the review.
2. Give Meta's test users the roles the review form asks for on the test Page and the WhatsApp
   test account, and add the reviewer's phone number as a WhatsApp test recipient if Meta
   provides one.
3. Make sure the test business is answered by the real model (step 24 passed), its emergency
   contacts are your own numbers (a reviewer may test "I smell gas"), and its knowledge holds
   nothing private.
