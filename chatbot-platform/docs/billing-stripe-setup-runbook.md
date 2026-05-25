# Stripe Setup Runbook — M0 Foundation Reshape

One-time operational checklist for setting up the Axentrio Stripe account for the new EUR catalog. Executed by someone with Stripe account credentials. Run on every environment (test mode for dev/staging, live mode for production).

## Prerequisites

- Stripe account in EU region (Belgium recommended — matches the Axentrio entity)
- Admin access to the Stripe Dashboard
- The deployment environment's secret store (Railway / etc.) ready to receive new env vars

## Steps

### 1. Enable Stripe Tax

Dashboard → **Settings → Tax** → enable "Stripe Tax". Register for VAT collection in Belgium (mandatory at launch); add other EU countries as the OSS €10k threshold is crossed.

### 2. Create the Essential product

Dashboard → **Product catalogue → Add product**.

- Product name: `Axentrio Essential`
- Description: `Essential tier — AI chatbot with unified inbox`
- Pricing model: `Standard pricing`
- Price: `49.99 EUR / month` (recurring)
- Tax behaviour: **`exclusive`** (price is shown ex-VAT; tax added at checkout per customer country)
- Tax code: `txcd_10103001` (Software as a Service — verify against [Stripe Tax codes docs](https://docs.stripe.com/tax/tax-codes) at setup time)

Copy the resulting **Price ID** (begins with `price_`). This becomes the value of `STRIPE_PRICE_ESSENTIAL`.

### 3. Create the Pro product

Same as above:

- Product name: `Axentrio Pro`
- Description: `Pro tier — bookings, calendar integration, AI Platform Assistant`
- Price: `99.99 EUR / month`
- Tax behaviour: `exclusive`
- Tax code: `txcd_10103001`

Copy the **Price ID** → `STRIPE_PRICE_PRO`.

### 4. **No** product for Enterprise

Enterprise is sales-led (per deviation 10 in `docs/subscription-epic-deviations.md`). Each Enterprise customer gets a custom price negotiated by sales, created manually per deal in the Stripe Dashboard at signing time. There is no env var for an Enterprise price ID.

### 5. Enable local payment methods at account level

Dashboard → **Settings → Payment methods**. Enable for recurring/subscription use:

- **Card** (always required as fallback)
- **Bancontact** (Belgium)
- **iDEAL** (Netherlands)
- **SEPA Direct Debit** (EU-wide recurring)

Verify each in the table shows ✓ for "Subscriptions" and "Recurring".

### 6. Configure the webhook endpoint

Dashboard → **Developers → Webhooks → Add endpoint**.

- Endpoint URL: `https://api.axentrio.<env>/api/v1/webhooks/billing/stripe` (note the `/api/v1/webhooks/...` mount prefix — matches the convention used by every other provider webhook, e.g. Meta/Telegram)
- Events to subscribe:
  - `checkout.session.completed`
  - `checkout.session.expired` (releases the trial reservation on abandoned checkouts — see audit gap #2)
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `customer.subscription.trial_will_end`
  - `invoice.paid`
  - `invoice.payment_failed`

Copy the **Signing secret** (begins with `whsec_`). This becomes `STRIPE_WEBHOOK_SECRET`.

### 7. Confirm trial-end customer email is ON

Dashboard → **Settings → Customer emails** → verify "Send emails about trials ending soon" is **enabled**. Stripe sends this email ~3 days before trial end (≈ day 12 of a 14-day trial). Per deviation 9, this is the sole trial-reminder mechanism for v1; we do NOT send custom day-7 / day-13 reminders.

### 8. Persist env vars

Set in the deployment environment:

```
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ESSENTIAL=price_...
STRIPE_PRICE_PRO=price_...
```

The API's boot fail-fast check will refuse to start in non-test environments if any of these is missing (see `src/config/environment.ts`).

### 9. Smoke-test in Stripe test mode

Before flipping live:

1. Run an Essential signup end-to-end. Confirm:
   - Checkout session created with `automatic_tax: true` and `tax_id_collection: true`.
   - Subscription created with `metadata.tenantId` set.
   - `customer.subscription.created` webhook fires; tenant's `Tenant.tier` lands at `essential`.
2. Run a Pro signup. Confirm `trial_period_days: 14` on the subscription and `subscription.status = 'trialing'` initially.
3. Use Stripe's [Test Clock](https://docs.stripe.com/billing/testing/test-clocks) to fast-forward past day-14. Confirm:
   - `customer.subscription.trial_will_end` fires at day-11.
   - `customer.subscription.updated` fires at day-14 with `status='active'`.
   - The first invoice is created with VAT applied.

### 10. Payment-method-trial verification

For each of `card`, `bancontact`, `ideal`, `sepa_debit`, run a Pro trial signup end-to-end and record the outcome in this table:

| Method | Trial setup OK | Auto-conversion to active OK | Notes |
|---|---|---|---|
| card | | | |
| bancontact | | | |
| ideal | | | |
| sepa_debit | | | |

If any non-card method fails verification (e.g. mandate setup blocked during trial), remove it from the `payment_method_types` array in PR6's Checkout-session params and record a new deviation in `docs/subscription-epic-deviations.md`.

## What this runbook does NOT cover

- VAT registration outside Belgium (handled as OSS thresholds are crossed)
- Customer portal configuration (handled in `src/billing/providers/stripe.ts` Customer Portal session creation)
- Promotional codes or discounts (not in M0 scope)
- Currency switching (v1 is EUR-only; revisiting belongs to a separate epic)
