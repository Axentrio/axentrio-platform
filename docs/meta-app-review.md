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
`pages_messaging`, `pages_manage_metadata`, `business_management`,
`instagram_basic`, `instagram_manage_messages`.

---

## Shared context

Paste into the "How will you use this permission?" intro on each permission:

> Axentrio is a business-to-business platform that lets a business connect its own
> Facebook Page, Instagram account, and WhatsApp number to an AI assistant that
> answers customer messages, captures leads, and schedules bookings. The business
> signs in to our dashboard, connects its Page/account via Facebook Login for
> Business, and from then on our system receives inbound messages via webhooks and
> replies on the business's behalf. We only access data for Pages/accounts the
> business explicitly connects, and only to provide the messaging features they
> enable.

---

## Per-permission justification

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
> experience as Messenger on Instagram.

### `business_management`
> Required to read the business's Pages and linked Instagram professional accounts
> during the connection flow so the customer can select which asset to connect, and
> to manage the resulting connection.

### `instagram_basic` (if requested)
> Required to read the basic profile of the connected Instagram professional account
> (username, account id) so we can display it in the dashboard and route Direct
> messages to the correct connected account.

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
