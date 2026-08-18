# Instagram channel enablement — handoff

**For:** Achraf. **Date:** 2026-08-18.
**App:** Meta app `1548698999932589`. **Status:** product + tenant config done; blocked on App Review.

Instagram DMs are fully built and configured (env, OAuth, webhook, entitlements). A live connect test on 2026-08-17 attached Facebook Page **Axentrio** (`1161984810327648`) as Messenger for tenant `16cdb37f-1114-4ef5-a041-fefa6f34f282` (Pro, Instagram entitled). Facebook Login also returned the linked IG professional account **@axentrio** (`17841434799597402`), but IG subscription failed.

Production root cause (`2026-08-17T10:14:10Z`, fbtrace `ACgXswunxg7ZwDMscr35obW`):

```
POST graph.facebook.com/v25.0/17841434799597402/subscribed_apps
→ HTTP 400 OAuthException code 3
"(#3) Application does not have the capability to make this API call."
```

This is **app-level**, not a token / tenant / page-link / code bug. The app never received Advanced Access for Instagram messaging and is not Live. Messenger works because page subscribe only needs basic `pages_*` scopes.

Already on `main` (auto-deployed via CI → Railway): `4bbfebe` (IG failures surface as a portal warning toast with the Graph error), `35d09ce` (token-safe logging), `27df07c` (copilot docs).

---

## How the flow works

There is **no standalone Instagram connect**. IG rides on **Settings → Channels → Facebook**:

1. Tenant must be on **Essential+** and have **Settings → Features → Instagram DMs** enabled.
2. The Facebook Page must have a linked **Instagram professional** account.
3. Facebook Login returns the Page + linked IG. We subscribe the Page (Messenger) and the IG account (DMs).
4. DMs only — no comments, mentions, or feed.

---

## Action checklist

Prepared App Review copy, justifications, and the screencast shot-list live in [`docs/meta-app-review.md`](./meta-app-review.md). Reuse that file; do not rewrite it.

### 1. Meta dashboard — Advanced Access + App Review

In [developers.facebook.com](https://developers.facebook.com) → app `1548698999932589`:

- [ ] Request **Advanced Access** for `instagram_manage_messages` and `instagram_basic`.
- [ ] Confirm `pages_messaging`, `pages_manage_metadata`, `pages_show_list`, `business_management` have the access level they need (Messenger already works in production).
- [ ] Submit **App Review** using `docs/meta-app-review.md` (use-case blurb, per-permission justifications, steps to reproduce, test credentials / Tester role).
- [ ] **TODO in that file — still open:**
  - [ ] Record the screencast (shot-list in the review pack; ~60–90s).
  - [ ] Mark permissions as submitted for Advanced Access.
  - [ ] Flip App Mode → Live **only after** approval.

Already done (do not redo): Business Verification, Privacy / Terms / Data Deletion URLs, contact mailboxes, OAuth redirect URIs.

### 2. Verify webhook config

App Dashboard → Webhooks:

- [ ] Callback URL: `https://api.axentrio.com/api/v1/channels/meta/webhook`
- [ ] Verify token = production `META_VERIFY_TOKEN`
- [ ] Instagram object subscribed to `messages`, `messaging_postbacks`, `message_reactions`

### 3. Go Live after approval

- [ ] Each requested permission shows **Advanced access**.
- [ ] Flip **App Mode → Live** at the top of the App Dashboard.

### 4. Reconnect the Page in the portal

As the tenant (`16cdb37f-1114-4ef5-a041-fefa6f34f282`):

- [ ] **Settings → Channels → Facebook** → complete Facebook Login → select Page **Axentrio** → **Connect Selected**.
- [ ] Expect **both** a Messenger and an Instagram connection.
- [ ] If IG fails, the warning toast now shows the exact Graph error. `(#3)` means the capability still is not active — do not debug tokens or tenant config.

Reconnecting also **rotates the Page access token** (see Security below).

### 5. Send a test DM

- [ ] From a different IG account, DM **@axentrio**.
- [ ] Confirm the message lands in the unified inbox.
- [ ] Confirm the bot replies.

### 6. Security follow-up

Old Railway production logs (before `35d09ce`, ~2026-08-17) dumped a Facebook **Page access token** in Axios error output. Treat that token as compromised until the Page is reconnected (step 4 rotates it).

- [ ] Reconnect the Page (step 4).
- [ ] Do not paste tokens into tickets, chat, or this doc.

---

## Verification (after steps 3–5)

| Check | Expected |
| --- | --- |
| Channels list | Messenger **and** Instagram rows for Page Axentrio / @axentrio |
| Inbound DM to @axentrio | Appears in unified inbox |
| Bot reply | Sent back on Instagram |
| Failed subscribe | Warning toast with Graph error (not a silent miss) |

---

## Troubleshooting

| Symptom | Meaning | What to do |
| --- | --- | --- |
| Toast / Graph `(#3)` *Application does not have the capability…* | App Review / Advanced Access / Live mode still missing | Finish steps 1 and 3. Not a token or tenant bug. |
| No Instagram row **and** no warning toast | Page has no linked IG professional account, **or** tenant feature **Instagram DMs** is off | Link IG to the Page in Meta Business Suite; enable the feature under Settings → Features. Essential+ only. |
| Expired / invalid Facebook session | Login session stale | Redo **Connect Facebook** from Settings → Channels. |
| Messenger works, IG does not, toast shows another Graph code | Capability is granted; different Graph problem | Capture the toast text + fbtrace and investigate that code. |

---

## Pointers

- App Review pack: [`docs/meta-app-review.md`](./meta-app-review.md)
- OAuth scopes in code: `api/src/channels/meta/oauth.service.ts`
- Related commits: `4bbfebe`, `35d09ce`, `27df07c`
