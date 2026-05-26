# Billing tester runbook

How to drive the full subscription lifecycle on the Railway production
deploy. Sandbox-only — no real money moves, no real charges fire.

## What you're testing against

- **Portal:** `https://chatbot-portal-production.up.railway.app/`
- **API:** `https://chatbot-api-production-37df.up.railway.app/`
- **Stripe mode:** Test / Sandbox. Every Stripe page in this flow shows
  the orange "Test mode" banner. No real cards, no real money.

Each portal sign-up creates a fresh tenant. The 14-day Pro trial is
one-shot per tenant — once consumed it's gone, even if the subscription
is cancelled afterwards. **For repeat trial testing, use fresh email
addresses** (e.g. `tester+a@example.com`, `tester+b@example.com` — Gmail
strips the `+suffix` so the inbox is the same).

## Stripe test cards

Use these on the Checkout page; any future expiration, any CVC, any
cardholder name.

| Card number | Outcome | When to use |
|---|---|---|
| `4242 4242 4242 4242` | Always succeeds | Happy path |
| `4000 0000 0000 0002` | Always declined | Decline-at-checkout flow |
| `4000 0000 0000 9995` | Insufficient funds | Decline-at-checkout flow |
| `4000 0027 6000 3184` | Requires 3-D Secure auth | EU SCA testing |
| `4000 0000 0000 0341` | Attaches OK, fails later | Past-due / dunning flow |

Full list: <https://stripe.com/docs/testing#cards>.

## Test scenarios

### 1. Happy path — sign up, start trial, use bot

1. Sign up at the portal with a fresh email
2. Land on the auto-provisioned tenant (default tier `free` or manual
   trial — whatever the signup flow assigns)
3. Settings → Billing → **Subscribe to Pro**
4. Stripe Checkout shows **"Try Pro"** / **"14 days free"** / **"Total
   due today: MYR0.00"** / button **"Start trial"**
5. Pay with `4242 4242 4242 4242`, exp `12/30`, CVC `123`
6. Click **Start trial** → redirected back to portal `/settings/
   billing?subscribed=1`
7. **Verify:** "Current plan: **Trialing / Pro**"
8. **Verify:** Sidebar shows Bookings unlocked, Success Meter visible,
   no lock icons

### 2. Tier-gated UI

While on Pro:
- Bookings sidebar item: no lock, no Pro badge
- Settings → Integrations → Cal.com: form visible (paste an API key)
- `/bookings` page: configure-Cal.com landing card

Switch tier to Essential (super-admin only — see "Reset" at the end):
- Bookings sidebar item: lock icon + "Pro" badge
- Settings → Integrations → Cal.com: locked card with "Upgrade to Pro
  to unlock"
- `/bookings` page: LockedPreview hero with "Unlock AI Bookings with Pro"
- Embed snippet: includes "Powered by Axentrio" footer (Essential)

### 3. Plan change

From the Pro Manage Subscription panel:
1. Click **Downgrade to Essential**
2. **Verify:** plan tile shows Essential, sidebar locks Bookings + Cal.com
3. Click **Upgrade to Pro**
4. **Verify:** plan tile shows Pro again, sidebar unlocks Bookings

No Stripe Checkout redirect on plan change — it's an in-place
subscription mutation.

### 4. Cancellation lifecycle

1. From Pro Manage Subscription panel → **Cancel subscription**
2. **Verify:** UI shows `cancel_at_period_end=true` (button label
   becomes "Resume subscription" or similar)
3. Click **Resume subscription** if you want to undo, OR wait for
   period end (June 9 for the current session's seed sub) for the actual
   cancellation

To force immediate cancellation for testing, a super-admin can use the
Stripe dashboard's **Cancel subscription** option on the customer page.

### 5. Re-subscribe after cancellation (trial-claim guard)

1. Tenant whose subscription has been cancelled (deleted, not just
   cancel-at-period-end) → tier shows **Free / Cancelled**
2. Click **Subscribe to Pro** again
3. **Verify:** Stripe Checkout shows **"Subscribe to Pro"** (NOT "Try
   Pro"), **"Total due today: MYR477.30"** (NOT 0), button label
   **"Subscribe"** (NOT "Start trial")
4. This is the trial-claim guard: a tenant gets one trial in their
   lifetime, period. The reservation row in
   `chatbot_tenant_trial_reservations` persists with a `subscription_id`
   marker.

### 6. Failure paths

- **Declined card:** at Checkout, use `4000 0000 0000 0002` and click
  Start trial → Stripe shows a decline error, you stay on the Checkout
  page, no subscription created, no webhook delivered
- **Duplicate-checkout:** rapidly double-click Subscribe to Pro on the
  portal → second click should produce a toast `"Couldn't start
  checkout: [stripe] checkout_in_progress"` (from the per-tenant
  advisory lock)
- **Subscribe while already trialing:** flip your TBA row state via
  super-admin tools or just attempt — backend returns
  `subscription_exists` 409 surfaced as a toast

### 7. Widget watermark

This requires actually embedding the chat widget on a test page.
Quickest way: open the API's hosted test page
`https://chatbot-api-production-37df.up.railway.app/widget-test.html`
(if available — otherwise embed in any HTML file with the snippet from
your bot's Embed Widget card):

- Essential tenant: widget footer shows **"Powered by Axentrio"** link
- Pro / Enterprise tenant: widget hides the footer

## What WON'T work in sandbox

- **No real charges.** Stripe sandbox accepts only test cards.
- **No real invoices.** Sandbox invoices show in the test dashboard but
  aren't sent or paid for real.
- **Email delivery via Resend is LIVE** in this deploy — the
  `RESEND_API_KEY` is real. If transactional emails fire (onboarding,
  cancellation), they go to real inboxes. **Warn testers** or have them
  use disposable inboxes.
- **Stripe Tax / VIES** validates VAT IDs against the real EU registry
  even in sandbox, so use known-good VAT IDs only when testing tax flow
  (e.g. `BE0123456789` is a syntactically valid Belgian ID).
- **Trial reservations are persistent.** Cancelling a subscription does
  NOT reset the trial-claim — that's intentional. To get a fresh trial,
  use a new tenant.

## Resetting a tenant between tests (super-admin only)

Today this is a DB-level operation. From a super-admin terminal:

```bash
# Reset a tenant's billing state for fresh trial testing
psql "$DATABASE_URL" <<SQL
DELETE FROM chatbot_tenant_trial_reservations WHERE tenant_id = '<UUID>';
UPDATE tenant_billing_accounts
   SET status='trialing', current_plan_id='pro', is_primary=true, subscription_id=NULL, customer_id=NULL
 WHERE tenant_id='<UUID>' AND provider='manual';
UPDATE tenant_billing_accounts
   SET is_primary=false
 WHERE tenant_id='<UUID>' AND provider='stripe';
UPDATE tenants SET tier='pro' WHERE id='<UUID>';
SQL
```

This puts the tenant back at "manual trialing-pro primary, stripe
demoted, fresh trial available." Adjust columns to taste.

A portal-side "Reset my billing" super-admin action is on the wishlist
but not yet built — file an issue if you hit this pain often.

## Verifying behind the scenes

Webhook deliveries are logged in `chatbot_stripe_webhook_events`
(idempotency log) and `webhook_delivery_log` (outbound). To inspect:

```sql
SELECT event_id, event_type, status, attempts, processed_at
FROM chatbot_stripe_webhook_events
WHERE tenant_id = '<UUID>'
ORDER BY created_at DESC
LIMIT 20;
```

Trial reservation state:

```sql
SELECT subscription_id IS NOT NULL AS claimed, checkout_session_id, reserved_at
FROM chatbot_tenant_trial_reservations
WHERE tenant_id = '<UUID>';
```

Billing accounts:

```sql
SELECT provider, status, current_plan_id, is_primary, subscription_id IS NOT NULL AS has_sub
FROM tenant_billing_accounts
WHERE tenant_id = '<UUID>'
ORDER BY provider;
```

Tenant tier (the entitlement-relevant value):

```sql
SELECT tier FROM tenants WHERE id = '<UUID>';
```

## Going live

This runbook covers **sandbox / test mode** only. When you're ready to
take real money:

1. Complete Stripe account verification (banner in the dashboard)
2. Switch the dashboard to **Live mode**
3. Recreate Essential + Pro products and prices (test-mode price IDs
   don't carry over)
4. Create a **live-mode** webhook endpoint pointing at the same Railway
   API URL → copy its `whsec_...`
5. Swap the four `STRIPE_*` Railway env vars to live values
   (`sk_live_...`, new `price_...` IDs, new `whsec_...`)
6. Redeploy Railway

No code change needed — purely a config swap.
