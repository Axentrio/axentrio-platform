# Meta App Review — submission pack

Paste-ready content for submitting the Axentrio Meta app (`1548698999932589`) for
App Review, so customers can connect **their own** Facebook Pages / Instagram
accounts (not just app admins/testers).

## Status / prerequisites

| Item | Status |
| --- | --- |
| Business Verification | ✅ Done (ACHRAF LAMRANI MAKHLOUFI, verified 2026-05-26) |
| Privacy Policy URL | ✅ `https://app.axentrio.com/privacy` (set in App Settings → Basic) |
| Terms of Service URL | ✅ `https://app.axentrio.com/terms` |
| Data Deletion (Instructions URL) | ✅ `https://app.axentrio.com/data-deletion` |
| Contact mailboxes | ✅ `privacy@` / `support@axentrio.com` forwarders (Combell) |
| Screencast video | ⬜ **TODO — record (see shot-list below)** |
| Permissions submitted for Advanced Access | ⬜ TODO |
| App Mode → Live | ⬜ TODO (after approval) |

Already configured in the Meta dashboard:
- OAuth redirect URIs whitelisted: `https://api.axentrio.com/api/v1/channels/meta/oauth/callback`
  (and the legacy `chatbot-api-production-d7d4.up.railway.app` equivalent).
- Webhook callback: `…/api/v1/channels/meta/webhook` with verify token.

Permissions requested by the code (`api/src/channels/meta/oauth.service.ts`):
`pages_messaging`, `pages_manage_metadata`, `pages_show_list`,
`business_management`, `instagram_basic`, `instagram_manage_messages`.

This Facebook Login review is **Messenger + Instagram only**. Do **not** add
`whatsapp_business_management` or `whatsapp_business_messaging`. Do **not** mention
WhatsApp in any justification below. WhatsApp stays Cloud API credentials in
Settings → Channels.

---

## How to fill "How will this app use …?"

Meta rejects the same paragraph pasted on every permission. Paste **only** the
block under that permission name. Do not prepend a shared intro. Do not paste
Meta's Allowed usage policy text back into the form.

Reuse **one** screencast file on every permission. Tick the allowed-usage box
once per permission.

Until Advanced access is granted, Instagram subscribe fails with Graph `(#3)`.
That is expected. The live test in the video is Messenger; Instagram is
requested so subscribe works after approval.

---

## Per-permission justification

### `pages_show_list`
> After Facebook Login, Axentrio lists the Facebook Pages the signed-in admin
> manages so they can pick which Page to connect. We call the Pages list APIs
> and show that list in Settings → Channels. The tenant selects one Page. We
> do not list Pages they did not grant, and we do not use this permission for
> ads, insights, or posting.

### `instagram_basic`
> After the tenant picks a Facebook Page, Axentrio reads the linked Instagram
> professional account's id and username so the dashboard can label the
> Instagram channel and route Direct messages to the right connection. We do
> not read the Instagram feed, followers, stories, or media.

### `business_management`
> Some tenants' Pages sit under a Business Portfolio, not on the personal
> account. We use this permission only during connect, to list those businesses
> and their owned Pages (and the Instagram professional account linked to a
> Page) so the tenant can choose which asset to attach. We do not manage users,
> ads, catalogs, or billing.

### `pages_messaging`
> Required to send and receive messages in Messenger on behalf of the Pages our
> customers connect. When an end user messages the connected Page, we receive the
> message via webhook and send the AI assistant's reply back through the Send API
> within the standard messaging window.

### `pages_manage_metadata`
> Required to subscribe the connected Page to our webhook so we receive `messages`
> and `messaging_postbacks` events. Without it we cannot register the Page's app
> subscription and would not receive inbound messages.

### `instagram_manage_messages`
> Required to send and receive Instagram Direct messages for the Instagram
> professional accounts our customers connect, providing the same AI-assistant
> experience as Messenger on Instagram. We use it only for DMs on accounts the
> tenant explicitly connects, not for comments, mentions, or publishing.

---

## Steps to reproduce

Paste into the "Steps to reproduce" field:

> 1. Go to https://app.axentrio.com and sign in.
> 2. Open **Channels** in the left navigation.
> 3. Click **Connect** on Facebook Messenger (or Instagram).
> 4. Complete Facebook Login for Business and grant the requested permissions.
> 5. Select the Facebook Page (and linked Instagram account) to connect.
> 6. The channel now shows as **Connected** in the dashboard.
> 7. From a different Facebook/Instagram account, send a message to the connected
>    Page/account.
> 8. Observe the AI assistant reply automatically in the conversation.

**Reviewer access:** add a test Facebook account as a **Tester** (App Dashboard →
App Roles → Roles → Testers) and provide its credentials in the submission, *or*
state that the reviewer may connect their own test Page. Include the screencast as
the primary evidence.

---

## Screencast shot-list

Record one ~60–90s take:

1. Start on `app.axentrio.com` already signed in → click **Channels**.
2. Click **Connect** on Messenger → the Facebook Login dialog appears.
3. Show the **permissions** being granted, pick the Page → land back on a
   **Connected** state.
4. Switch to a phone/second account → open Messenger to that Page → type
   *"Hi, do you have availability this week?"*
5. Show the **AI reply** arriving (the existing plumbing/booking conversation is a
   good real example).
6. End on the conversation thread showing the full exchange.

---

## After approval

1. Confirm each permission shows **Advanced access**.
2. Flip **App Mode → Live** (top of the App Dashboard).
3. Customers can now connect their own Pages/accounts.

## WhatsApp Embedded Signup (later — not this submission)

Do **not** add `whatsapp_business_*` to this Facebook Login review.

When Messenger/Instagram Advanced access is done:

1. App Dashboard → WhatsApp → Tech Provider onboarding (Business Verification is already done).
2. Separate App Review for `whatsapp_business_management` and `whatsapp_business_messaging` (two videos).
3. Facebook Login for Business configuration from the **WhatsApp Embedded Signup** template. Ask for WhatsApp assets only. Add `app.axentrio.com` as an allowed HTTPS domain.
4. Subscribe this app's WhatsApp webhook to **`account_update`** (in addition to `messages`). Callback stays `https://api.axentrio.com/api/v1/channels/whatsapp/webhook`.
5. Set Railway `WHATSAPP_ES_ENABLED=true` and `WHATSAPP_ES_CONFIG_ID=<configuration id>`.
6. Build **v4** (`extras: {}`). v2 dies 15 Oct 2026.

Until those env vars are set, tenants still paste Cloud API credentials. The portal already launches Embedded Signup when the API reports `enabled: true`.
