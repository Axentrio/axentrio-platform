# Plan: Pluggable Platform Billing

## Goal

Build a plug-and-play platform-billing layer for the multi-tenant chatbot SaaS, with a Stripe adapter (real) and a Manual adapter (no-op for Enterprise) shipped in v1, an interface and data model designed to fit additional providers (Paddle, Lemon Squeezy, Shopify subscription apps) without rearchitecture. The layer is shipped together with entitlement enforcement at every defined gate, so the tiers are real product behavior on day one.

## Decisions

### Plan model

- **Tiers** are `'free' | 'pro' | 'premium' | 'enterprise'`. Stored on existing `Tenant.tier` column; existing enum `('free','pro','enterprise')` is extended with `'premium'`. `'free'` is retained as a real, permanently-usable tier (reverse-trial pattern requires it).
- **Billing status** lives separately from tier on a new `tenant_billing_accounts` table. Status values: `'trialing' | 'active' | 'past_due' | 'cancelled' | 'none'`. Reason: conflating "what plan are they on" with "what's their billing status" makes every downstream query messy.
- **Entitlements** (per-tier limits/feature flags) live in code as a `PLANS` catalog constant (`src/billing/plans.ts`), not in the database.

### Reverse-trial signup flow

- New tenant signup creates a `tenant_billing_accounts` row with `provider='manual'`, `status='trialing'`, `current_plan_id='pro'`, `trial_end = now + 7 days`, `is_primary=true`. `Tenant.tier='pro'`.
- No card required at signup.
- **Subscribe flow** (during trial or after): `service.startCheckout(tenantId, planId)`. Steps (no DB lock is held across any Stripe network call):
  1. **Duplicate-checkout guard (round-5 #2).** Open a short read-only tx with `SELECT … FOR UPDATE` on all the tenant's `tenant_billing_accounts` rows. If the primary row already has `provider='stripe'` AND `status IN ('trialing','active','past_due')`, **throw `BillingProviderError('subscription_exists', 'stripe')`** (HTTP 409 from route). UI shows "Manage subscription" instead of "Subscribe." Commit (read-only). This prevents creating a second Stripe subscription that would double-charge the customer — the round-4 #16 audit-only safeguard fires only after the second Stripe charge has already happened; this guard fires before.
  2. **Resolve Stripe customer (no DB lock held).** Call `stripeProvider.createCustomer(tenantId, email, name)` — this method performs search-then-create internally (see `createCustomer` definition in § BillingProvider interface). No `ensureCustomer` exists; `createCustomer` is the canonical name.
  3. **Short DB tx (round-5 #1: preserve existing customer_id).** Open tx with `SELECT … FOR UPDATE` on all the tenant's `tenant_billing_accounts` rows. Upsert `(tenant_id, provider='stripe')` with `status='none'`, `is_primary=false`, and `customer_id` written via `INSERT … ON CONFLICT (tenant_id, provider) DO UPDATE SET customer_id = COALESCE(tenant_billing_accounts.customer_id, EXCLUDED.customer_id)` — i.e. **a non-null existing `customer_id` is never overwritten**. If the existing row's `customer_id` is non-null and differs from the freshly-resolved one, the existing id wins and the freshly-created Stripe customer (if any) becomes a harmless orphan. Commit. The subsequent Checkout call uses the row's persisted `customer_id`, never the locally-resolved variable.
  4. **Create checkout session (no DB lock held).** Re-read the row's `customer_id` and call `stripeProvider.createCheckoutSession(...)` with that value + `client_reference_id = tenantId`. Return URL.
  5. When `customer.subscription.created` arrives, the webhook handler (per § Webhook event handling) performs tenant lookup, writes the audit row with the resolved `tenant_id`, then inside the same tx **writes `subscription_id` first** on the matched row (so later events lookup-by-subscription_id cleanly), then maps Stripe status per § Stripe status mapping, and — only when the status is `'trialing'` or `'active'` (not `'incomplete'`) — performs the primary switch via the safe SQL order in § Primary-switch SQL ordering and sets `Tenant.tier` to the new plan.
- **Trial-expiry job** (Bull, scheduled at tenant create for `trial_end`): in a tx with `SELECT … FOR UPDATE` on **all** of this tenant's billing rows, evaluate two preconditions:
  - **Downgrade-only-if** the primary row still has `provider='manual'` AND `status='trialing'` AND `current_plan_id='pro'`.
  - **Skip if any "fresh subscribe attempt" signal exists:** (i) a non-manual row younger than 24h; (ii) a non-manual row with `status IN ('trialing','active','past_due')` at any age; (iii) any `billing_events` row with `provider='stripe'` younger than 24h.
  - **Otherwise:** set `Tenant.tier='free'`, set primary manual row's `status='none'` AND `current_plan_id='free'`, write `billing_events` (`provider='system'`, `event_type='trial.expired'`). Commit.
- **Daily safety-net sweep** (independent Bull job, runs once per day):
  ```sql
  SELECT tba.tenant_id
  FROM tenant_billing_accounts tba
  WHERE tba.provider='manual'
    AND tba.is_primary=true
    AND tba.status='trialing'
    AND tba.current_plan_id='pro'
    AND tba.trial_end < now()
  ```
  For each row, invoke `service.expireTrialIfStillManual(tenantId)` (which re-applies the same precondition check inside its own tx, so this is safe to re-run). This covers the case where the original delayed job never fired (queue down at tenant-create time, app crashed before scheduling, etc.) — the sweep is the authoritative recovery path; the delayed job is the latency optimization.
- **Concurrency rule (global):** every mutation of `tenant_billing_accounts.is_primary`, `tenant_billing_accounts.status`, `tenant_billing_accounts.current_plan_id`, or `Tenant.tier` runs inside a DB tx that opens with `SELECT … FOR UPDATE` on **all** of the tenant's `tenant_billing_accounts` rows.

### Entitlement shape (placeholders — tunable in `plans.ts`)

| Capability | Free | Pro | Premium | Enterprise |
|---|---|---|---|---|
| Agents (chatbots) | 1 | 3 | 10 | Unlimited |
| Concurrent sessions | 10 | 100 | 500 | Custom (override) |
| Daily LLM calls (platform key) | 0 | 1,000 | 10,000 | Custom (override) |
| BYO LLM key allowed | ✓ | ✓ | ✓ | ✓ |
| File upload to chat | ✗ | ✓ | ✓ | ✓ |
| Human handoff | ✗ | ✓ | ✓ | ✓ |
| Channels connected | 1 | 3 | Unlimited | Unlimited |
| Custom branding / domain | ✗ | ✗ | ✓ | ✓ |
| Support | Community | Email | Priority | SLA |

(Automations / skills are *not* tiered in v1.)

### Pricing & currency

- **Pro**: $49 / month. **Premium**: $199 / month. **Enterprise**: custom (sales-led).
- USD only in v1. Plan catalog `providerPriceIds` shaped as `{ stripe: { usd: 'price_xxx' } }`.
- Monthly billing only in v1.

### Lifecycle semantics

- **Payment failure** (grace + downgrade): `invoice.payment_failed` → set `status='past_due'`, tier unchanged. When provider gives up and emits `customer.subscription.deleted` (or a terminal `incomplete_expired`/`unpaid` status), tier downgrades to `'free'`; row's `current_plan_id` → `'free'`.
- **Cancellation** (cancel-at-period-end only in v1): clicking Cancel sets `cancel_at_period_end=true`; UI shows "Cancelling on <date>, undo" via `service.undoCancel`. End-of-period event downgrades tier to `'free'` and sets row's `current_plan_id='free'`.
- **Plan change** (asymmetric proration):
  - **Upgrade (round-5 #6 — concrete shape):**
    1. `sub = stripe.subscriptions.retrieve(subId)`.
    2. Assert `sub.items.data.length === 1` — v1 subscriptions are exactly one line item; throw `BillingProviderError('subscription_shape_unexpected', 'stripe', { itemCount: sub.items.data.length })` if not (defensive check; should never trigger in v1).
    3. `subscriptionItemId = sub.items.data[0].id`.
    4. `stripe.subscriptions.update(subId, { items: [{ id: subscriptionItemId, price: newPriceId }], proration_behavior: 'always_invoice' })`. Effective immediately.
  - **Downgrade (concrete shape):**
    1. `sub = stripe.subscriptions.retrieve(subId, { expand: ['schedule'] })`.
    2. **If `sub.schedule` is already set, throw `BillingProviderError('pending_change_exists', 'stripe')`** (authoritative remote check; defeats local-vs-webhook race).
    3. `schedule = stripe.subscriptionSchedules.create({ from_subscription: subId })`.
    4. `stripe.subscriptionSchedules.update(schedule.id, { phases: [phase1, phase2], end_behavior: 'release' })` where:
       - `phase1 = { items: [{ price: currentPriceId, quantity: 1 }], start_date: schedule.phases[0].start_date, end_date: sub.current_period_end, proration_behavior: 'none' }`
       - `phase2 = { items: [{ price: newPriceId, quantity: 1 }], start_date: sub.current_period_end, proration_behavior: 'none' }`
    5. Webhook updates local state.
  - **Undo a pending downgrade:** `stripe.subscriptionSchedules.release(scheduleId)`. Webhook clears local fields.
  - **`changePlan` is rejected** with `past_due_block` when `status='past_due'`, and with `pending_change_exists` when either local pending exists OR remote Stripe schedule exists.
  - **Same-plan calls** throw `no_op_plan_change`.

#### Stripe status mapping (`customer.subscription.*` events)

| Stripe `status` | Local `tenant_billing_accounts.status` | Row's `current_plan_id` | Promotes row to `is_primary` & touches `Tenant.tier`? |
|---|---|---|---|
| `trialing` | `trialing` | mapped from price | YES (if not already primary) |
| `active` | `active` | mapped from price | YES (if not already primary) |
| `past_due` | `past_due` | unchanged | NO — tier preserved (grace) |
| `unpaid` (terminal) | `cancelled` | `'free'` | YES iff row is currently primary → tier→`'free'` |
| `incomplete` | `none` | **mapped from price** (NOT `'free'` — codex r4 #5 exception) | NO — row stays non-primary until first payment succeeds |
| `incomplete_expired` (terminal) | `cancelled` | `'free'` | YES iff row is currently primary → tier→`'free'` |
| `paused` | `past_due` | unchanged | NO |
| `canceled` | `cancelled` | `'free'` | YES iff row is currently primary → tier→`'free'` |

#### Primary-switch & tier-cascade rules (codex r4 #6, #7)

These are the single authoritative rules; all section text above refers back to these:

1. **Promotion** (a Stripe row becoming `is_primary=true` + manual row demoted + `Tenant.tier` updated) happens **only** when a webhook produces a local-status transition into `'trialing'` or `'active'`. `'incomplete'` does not promote.
2. **Subsequent cascades on the already-primary row** (price change → tier update; terminal status → tier→`'free'`) fire **only when the row being mutated is `is_primary=true` at the time of the event**.
3. **Non-primary row terminal status:** terminal events on a non-primary Stripe row (e.g. an old subscription still emitting events after super-admin moved tenant to Enterprise) update *that row's* local `status`/`current_plan_id` to `'cancelled'`/`'free'` — but **do not** touch `Tenant.tier` or change `is_primary` of any other row. This keeps row-local state consistent without leaking into tenant-wide tier.

#### Primary-switch SQL ordering (round-5 #8)

The partial unique index `(tenant_id) where is_primary = true` rejects any state where two rows for the same tenant both have `is_primary=true`. A naive "promote new row then demote old row" sequence would briefly violate the index inside the transaction and fail. Two safe options; pick the single-statement form for primary switches:

```sql
-- Single statement, safe under the partial unique index:
UPDATE tenant_billing_accounts
SET is_primary = CASE
  WHEN id = :promotingId THEN true
  WHEN tenant_id = :tenantId AND is_primary = true AND id <> :promotingId THEN false
  ELSE is_primary
END
WHERE tenant_id = :tenantId
  AND (id = :promotingId OR is_primary = true);
```

This demotes and promotes in one statement so the index constraint is never violated mid-update. The `Tenant.tier` change is a separate `UPDATE tenants SET tier = $1 WHERE id = $2` immediately after, inside the same tx. (The alternative — separate `UPDATE … SET is_primary = false WHERE …` before `UPDATE … SET is_primary = true WHERE id = :promotingId` — also works in PostgreSQL because partial indexes are checked at statement boundaries, but the single-statement form is the safe default that survives schema reviews.)

#### Plan-id semantics on terminal statuses (codex r4 #5 explicit)

- `incomplete` → `current_plan_id` = the price-mapped plan (Pro/Premium), because the row represents "wants Pro, payment pending."
- Terminal `cancelled` (any source) → `current_plan_id='free'`.
- Terminal `none` after trial expiry → `current_plan_id='free'`.
- `past_due` → `current_plan_id` unchanged (grace).
- Recovery from `past_due` → `'active'` → `current_plan_id` re-derived from Stripe payload's current price.

#### `customer.subscription.updated` handler mapping

Lookup by `(provider='stripe', subscription_id)`; if miss AND there is a Stripe row with `subscription_id IS NULL` for this customer, fall back to `(provider='stripe', customer_id)` and persist `subscription_id` on that row. Inside the unified tx, after locking all the tenant's rows, apply:

| Stripe payload field | Local effect |
|---|---|
| `status` | Map per § Stripe status mapping; apply cascades per § Primary-switch & tier-cascade rules |
| `items.data[0].price.id` | Reverse-lookup in `PLANS`. If unknown (codex r4 #15 — symmetric with `subscription.created` per round-5 #7): write audit row with `payload.unknown_price = priceId`, **no** state mutation, **return 200** (do not force retry), log warning. The same rule applies to `subscription.created`'s price field — both events route through `handleNormalizedEvent` which checks `PLANS` lookup first and short-circuits to audit-only on a miss. Else: update `current_plan_id`; cascade per rules |
| `current_period_end` | Update `current_period_end` |
| `cancel_at_period_end` | Update `cancel_at_period_end` |
| `trial_end` | Update `trial_end` |
| `schedule` set/cleared | If set: the Stripe payload may inline the schedule object or send only a string schedule id. **If the payload's `schedule` field is a string id, the handler calls `stripe.subscriptionSchedules.retrieve(scheduleId, { expand: ['phases.items.price'] })` to read the phases (round-5 #5)** — this is the one remote enrichment performed inside the webhook tx; it is safe because the tx holds row locks but not table locks, and the retrieve is idempotent + cached at Stripe. Once phases are in hand: phase 2's price ID is reverse-looked-up in `PLANS` (if unknown, apply the round-5 #7 unknown-price rule: write `payload.unknown_price = phase2PriceId`, leave `pending_plan_id`/`pending_plan_effective_at` NULL, no rollback). Else write `pending_plan_id` (from phase 2 price), `pending_plan_effective_at` (phase 2 `start_date`), and `raw_provider_data.stripe.scheduleId` via JSONB merge. If cleared: NULL all three. |

#### Multiple subscriptions for same customer (codex r4 #16)

If `customer.subscription.created` arrives for a `subscription_id` different from the one already on the matched Stripe row (i.e. the customer somehow has two subscriptions — duplicate-checkout race, manual creation in Stripe dashboard, etc.), the handler writes the audit row with `payload.subscription_mismatch = { existing: <subId>, incoming: <subId> }`, performs **no** state mutation, and returns 200 (no retry). Super-admin manually reconciles via the Stripe dashboard. The partial unique index on `(provider, subscription_id)` would also block any attempt to insert a second row for the same `(tenant, provider)` pair.

### Access control

- Billing routes are gated to `User.role IN ('admin', 'super_admin')`.
- `billing_email` defaults to first admin's email; editable on Billing page.
- **`billing_email` propagation rule:** open local DB tx, update `tenant_billing_accounts.billing_email`, call `stripe.customers.update(customerId, { email })`. Stripe throws → rollback local tx + return error. Stripe succeeds → commit. Local audit row written inside the tx only if email changed. Manual rows: no Stripe call.
- Super-admin can act on behalf of any tenant.

### Enterprise flow

- Super-admin "Set tier to Enterprise (manual)": single tx with `SELECT … FOR UPDATE` on all the tenant's billing rows:
  1. `Tenant.tier='enterprise'`.
  2. Every existing row for this tenant → `is_primary=false`.
  3. Upsert `(tenant_id, provider='manual')` with `status='active'`, `current_plan_id='enterprise'`, `is_primary=true` (via `ON CONFLICT (tenant_id, provider) DO UPDATE`).
  4. `current_period_end` and `billing_email` filled in by super-admin; **both may remain NULL** (codex r4 #13) — entitlement resolution does not read either. Admin UI shows reminders to populate them for renewal tracking.
- Existing Stripe subscription (if any) stays in Stripe; super-admin prompted to cancel it in Stripe dashboard. Stripe webhooks for that (now non-primary) subscription update its row locally but never touch `Tenant.tier`.
- `ManualBillingProvider` is never registered in the webhook router (`supportsWebhooks=false`); webhook URLs for it return 404.

### Provider–tenant data model

```
tenant_billing_accounts
  id                          uuid pk
  tenant_id                   uuid fk → tenants(id) on delete cascade
  provider                    varchar(32)              -- 'stripe' | 'manual' | future
  customer_id                 varchar(255) null
  subscription_id             varchar(255) null
  status                      varchar(32) not null     -- 'trialing'|'active'|'past_due'|'cancelled'|'none'
  current_plan_id             varchar(32) not null     -- 'free'|'pro'|'premium'|'enterprise'
  current_period_end          timestamptz null
  cancel_at_period_end        boolean not null default false
  pending_plan_id             varchar(32) null
  pending_plan_effective_at   timestamptz null
  trial_end                   timestamptz null
  is_primary                  boolean not null default true
  billing_email               varchar(255) null
  raw_provider_data           jsonb not null default '{}'::jsonb   -- see § raw_provider_data merge semantics
  created_at                  timestamptz not null default now()
  updated_at                  timestamptz not null default now()

  unique (tenant_id, provider)
  partial unique index (tenant_id) where is_primary = true
  partial unique index (provider, customer_id) where customer_id is not null
  partial unique index (provider, subscription_id) where subscription_id is not null
```

`Tenant.billingInfo` JSONB column is **deprecated** (code stops reading/writing it) but not dropped in this milestone.

**Backfill for existing tenants** (in the same migration): `INSERT INTO tenant_billing_accounts (tenant_id, provider, status, current_plan_id, is_primary) SELECT id, 'manual', 'active', tier, true FROM tenants;`. `current_period_end` and `billing_email` are NULL for backfilled rows — acceptable (codex r4 #13).

**Migration is irreversible (`down()` throws).**

#### `raw_provider_data` merge semantics (codex r4 #14)

`raw_provider_data` is `NOT NULL DEFAULT '{}'::jsonb`. All writes use PostgreSQL `jsonb_set` to deep-set a single path without overwriting unrelated keys. Example for writing the Stripe schedule id:

```sql
UPDATE tenant_billing_accounts
SET raw_provider_data = jsonb_set(raw_provider_data, '{stripe,scheduleId}', to_jsonb($1::text), true)
WHERE id = $2;
```

Clearing uses `jsonb_set` with `'null'::jsonb` or `#-` (jsonb-path-remove). Service / repo helpers wrap these so callers never write `raw_provider_data = X` directly.

### Event persistence (idempotency + audit + invoice linkage)

```
billing_events
  id                   uuid pk
  tenant_id            uuid null fk → tenants(id) on delete cascade   -- nullable for unresolved events
  provider             varchar(32) not null            -- 'stripe' | 'manual' | 'system'
  provider_event_id    varchar(255) null               -- e.g. Stripe evt_xxx
  event_type           varchar(64) not null            -- normalized type
  payload              jsonb not null
  raw_payload          jsonb null
  processed_at         timestamptz not null default now()
  created_at           timestamptz not null default now()

  partial unique index (provider, provider_event_id) where provider_event_id is not null
  index (tenant_id, created_at desc)
```

`tenant_id` nullable for unresolved events (e.g. webhook for a Stripe customer with no matching local row).

### Webhook event handling (unified transaction — codex r4 #1 restructured)

Per `POST /webhooks/billing/:provider` request, the handler runs:

1. Allowlist check on `params.provider` (404 if not in `['stripe']`).
2. `provider.verifyWebhook(rawBody, headers)`.
3. `event = provider.normalizeWebhookEvent(providerEvent)`. If `event === null`, return 200.
4. **Open DB tx.**
5. **Tenant lookup** (no mutation yet) per § Lookup rules below. Result: `(matchedRow | null, resolvedTenantId | null)`.
6. **Idempotency-gated audit insert:**
   ```
   INSERT INTO billing_events (tenant_id, provider, provider_event_id, event_type, payload, raw_payload)
   VALUES (resolvedTenantId, event.provider, event.providerEventId, event.type, normalizedPayload, rawPayload)
   ON CONFLICT (provider, provider_event_id) DO NOTHING
   ```
   If `rowCount === 0` → already processed → rollback, return 200.
7. **State mutation** via `handleNormalizedEvent(event, matchedRow, tx)` — applies per-event-type rules from § Lifecycle semantics, § Stripe status mapping, § Primary-switch & tier-cascade rules, § `customer.subscription.updated` handler mapping. For `'refund.recorded'`, multi-sub mismatch, unknown-price, or `matchedRow === null`: no mutation (the audit row alone is the artifact).
8. **Lock-all rule:** if step 7 mutates `is_primary`/`status`/`current_plan_id`/`Tenant.tier`, it MUST first `SELECT … FOR UPDATE` on all the tenant's `tenant_billing_accounts` rows (consistent with global concurrency rule).
9. If step 7 throws, the entire tx (including the audit insert) rolls back so the next provider retry can succeed and produce both rows.
10. Commit, return 200.

**Lookup rules:**
- `subscription.created`: try `(provider='stripe', subscription_id)` → fall back to `(provider='stripe', customer_id)`.
- `subscription.updated` / `subscription.deleted`: try `(provider='stripe', subscription_id)` → fall back to `(provider='stripe', customer_id)` ONLY if there exists a Stripe row for that customer with `subscription_id IS NULL` (handles out-of-order delivery into the pending checkout row).
- `invoice.paid` / `invoice.payment_failed` / `refund.recorded`: try `(provider='stripe', subscriptionId)` (event's optional subscriptionId field — see § BillingProvider interface) → if missing or unmatched, fall back to `(provider='stripe', customer_id)`.
- Any miss → `tenant_id = NULL` on the audit row, no state mutation.

### Service-level idempotency & audit-row rules (codex r4 #3 resolved)

Two categories of service operation, two audit-source rules:

**A. Stripe-driven operations** (`startCheckout`, `changePlan`, `cancelAtPeriodEnd`, `undoCancel`, `undoPendingChange`):
- Local state changes only when the inbound Stripe webhook arrives.
- The service performs a pre-call check via `provider.getSubscription(tenantId)` (live Stripe query) — if the target state is already true, the service returns a no-op (no Stripe mutation, no command record).
- **Audit row comes from the webhook**, not from the service call. The service itself writes no `billing_events` row for these operations. UI polls `getBillingState` for the webhook-driven update.

**B. Local-only operations** (`updateBillingEmail`, `setEnterpriseManual`, `expireTrialIfStillManual`, trial-create on tenant signup):
- Local state changes immediately inside the service tx.
- The service opens a tx with `SELECT … FOR UPDATE`, reads current state, compares to target, applies the mutation, and writes a `billing_events` row (`provider='system'`) **only if the mutation actually changes state** (idempotent on repeat calls).

This split removes the contradiction: webhook-driven ops are audited by the webhook (single source of truth); local-only ops self-audit (no webhook involved).

### BillingProvider interface (the load-bearing abstraction)

```ts
// src/billing/types.ts
export type NormalizedStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'none';
export type InternalPlanId = 'free' | 'pro' | 'premium' | 'enterprise';
export type CheckoutablePlanId = Extract<InternalPlanId, 'pro' | 'premium'>;

export interface NormalizedSubscription {
  customerId: string;
  subscriptionId: string | null;
  status: NormalizedStatus;
  currentPlanId: InternalPlanId;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  pendingPlanId: InternalPlanId | null;
  pendingPlanEffectiveAt: Date | null;
  trialEnd: Date | null;
}

export type NormalizedEventType =
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.deleted'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'refund.recorded';                                   // mapped from Stripe `charge.refunded`

export interface NormalizedEvent {
  providerEventId: string;
  type: NormalizedEventType;
  customerId: string;
  subscriptionId?: string;                               // present when payload provides it (codex r4 #2/#8)
  subscription: NormalizedSubscription | null;
  invoiceUrl?: string;
  occurredAt: Date;
  raw: unknown;
}

export interface BillingProvider {
  name: string;
  supportsWebhooks: boolean;

  // INTERFACE INVARIANT (with one explicit exception):
  // Mutating/query methods read their own `tenant_billing_accounts` row via
  // (provider=this.name, tenant_id) and throw `BillingProviderError('no_active_account', this.name)` if absent.
  // EXCEPTION: `createCustomer` is a creation method — no pre-existing row required.
  // It receives explicit input and the caller (`service.startCheckout`) writes the row
  // after `createCustomer` returns. `createCustomer` performs search-then-create internally
  // (Stripe: `customers.search` by `metadata["tenantId"]`, then `customers.create` on miss)
  // for durable recovery across idempotency-key TTL expiry. There is no separate `ensureCustomer`.
  createCustomer(input: { tenantId: string; email: string; name: string }): Promise<{ customerId: string }>;

  createCheckoutSession(input: {
    tenantId: string;
    planId: CheckoutablePlanId;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string }>;
  createPortalSession(input: { tenantId: string; returnUrl: string }): Promise<{ url: string }>;
  changeSubscription(input: { tenantId: string; newPlanId: CheckoutablePlanId }): Promise<void>;
  cancelSubscription(input: { tenantId: string; atPeriodEnd: true }): Promise<void>;
  undoCancel(input: { tenantId: string }): Promise<void>;
  undoPendingChange(input: { tenantId: string }): Promise<void>;
  getSubscription(input: { tenantId: string }): Promise<NormalizedSubscription | null>;

  verifyWebhook(input: { rawBody: Buffer; headers: Record<string, string> }): Promise<unknown>;
  normalizeWebhookEvent(providerEvent: unknown): NormalizedEvent | null;
}

export class BillingProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly providerName: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(`[${providerName}] ${code}`);
  }
}
```

**Error-throw conventions** (every throw site uses `(code, providerName, meta?)`):
- `BillingProviderError('past_due_block', 'stripe')`
- `BillingProviderError('pending_change_exists', 'stripe')`
- `BillingProviderError('no_op_plan_change', 'stripe')`
- `BillingProviderError('manual_provider_sales_managed', 'manual')`
- `BillingProviderError('no_active_account', 'stripe')`
- `BillingProviderError('no_stripe_subscription', 'stripe')` (codex r4 #12)
- `BillingProviderError('checkout_plan_invalid', 'stripe', { planId })`

**Service-level validation** above the provider:
- `startCheckout`/`changePlan` reject `'free'` and `'enterprise'`.
- `changePlan` rejects same-plan with `no_op_plan_change`.
- `changePlan` rejects when `status='past_due'` with `past_due_block`.
- `changePlan` rejects when local pending exists OR remote Stripe schedule exists with `pending_change_exists`.
- **All Stripe-targeting operations** (`changePlan`, `cancelAtPeriodEnd`, `undoCancel`, `undoPendingChange`, `openCustomerPortal`) **reject with `no_stripe_subscription`** (HTTP 400) when the tenant has no primary Stripe row — i.e. they're on manual-only billing (trialing-Pro, manually backfilled, or Enterprise). UI shows "Subscribe" (for free/manual-trial tenants) or "Contact sales" (for Enterprise tenants) instead of these actions.

### Cross-system (Stripe + DB) operation ordering rules

| Operation | Order | Failure handling |
|---|---|---|
| `createCustomer` (search-then-create) | Stripe search → if hit, return; else create (no DB lock held) | Stripe throws → return error. Race produces orphan customer (accepted). |
| `createCheckoutSession` | Stateless — Stripe call only (no DB lock) | Stripe throws → return error. Pending row reaped by 24h trial-expiry skip. |
| `changeSubscription` / `cancelSubscription` / `undoCancel` / `undoPendingChange` | Pre-call `getSubscription` for idempotency → Stripe mutation → local state via webhook | Pre-call match → no-op. Stripe throws → return error. |
| `updateBillingEmail` | Local tx: update row → Stripe `customers.update` → commit on success, rollback on Stripe failure | Both must succeed. |
| `setEnterpriseManual` | Local-only tx | Atomic. |
| Webhook event handler | One DB tx covering tenant lookup + billing_events insert + state mutation | DB error rolls back all three; provider retries. |

### Scope cuts (in addition to § Out of scope full list)

- No tax/VAT, no SCA custom UI, no refund-driven entitlement reversal, no proration on downgrade.
- No multi-currency, no annual billing, no per-seat pricing, no coupons, no usage-based metering.
- **Session lifecycle (decrement of `tenants.current_sessions`) is pre-existing behavior**, not modified by this plan.

## Out of scope

- Tax / VAT calculation, Merchant-of-Record flows.
- SCA / 3DS custom card-input UI.
- Refund-driven entitlement reversal (audit-only).
- Multi-currency (USD only).
- Annual billing (monthly only).
- Per-seat pricing, coupons / promo codes, usage-based / metered LLM billing.
- Account-credit balance display.
- Dropping deprecated `Tenant.billingInfo` column (separate follow-up migration).
- Real Enterprise-via-Stripe-Custom-Pricing flow (`'manual'` only).
- Provider-migration tooling beyond the multi-row schema (no UI / scripts).
- Auto-cancelling an existing Stripe subscription when super-admin sets Enterprise (manual dashboard action).
- Tiered Automations / Skills.
- Pausing subscriptions ourselves.
- Session-release/decrement of `tenants.current_sessions` (pre-existing concern).
- Migration `down()` for billing tables / enum extension (irreversible by design).
- A configurable default provider in v1: `BILLING_DEFAULT_PROVIDER` env var is **not** part of v1 (codex r4 #10). Stripe is the hardcoded default; the env var hook can be added in a follow-up alongside a second provider adapter.

## Implementation outline

Sequenced for incremental ship-ability. Each step leaves the system in a working state.

1. **DB migrations + entities + backfill.** `src/database/migrations/<ts>-AddBillingTables.ts`:
   - Extend `tenants_tier_enum` with `'premium'`.
   - Create `tenant_billing_accounts` (with `raw_provider_data` defaulting to `'{}'::jsonb` NOT NULL) and `billing_events` (with `tenant_id` nullable) tables and all four partial unique indexes.
   - **Backfill:** `INSERT INTO tenant_billing_accounts (tenant_id, provider, status, current_plan_id, is_primary) SELECT id, 'manual', 'active', tier, true FROM tenants;`
   - `down()` throws with "migration is irreversible by design."
   - `src/database/entities/TenantBillingAccount.ts`, `src/database/entities/BillingEvent.ts`. Add to `src/database/entities/index.ts` and entity glob.

2. **Plan catalog + entitlement resolver + boot validation.** `src/billing/types.ts` (interfaces above). `src/billing/plans.ts` exports `PLANS: Record<InternalPlanId, PlanDefinition>` with entitlements, display prices, per-provider price ID maps (price IDs from env vars), and a `rank` field (`free=0, pro=1, premium=2, enterprise=3`). `src/billing/entitlements.ts` exports `getEntitlements(tenantId): Promise<Entitlements>`.
   - **Boot-time validation:** on server startup, validate that `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_USD_MONTHLY`, `STRIPE_PRICE_PREMIUM_USD_MONTHLY` are all non-empty. Any missing → log fatal and `process.exit(1)`. Stripe is unconditionally required in v1 (no `BILLING_DEFAULT_PROVIDER` env var — see § Out of scope).

3. **ManualBillingProvider + registry.** `src/billing/providers/manual.ts` (mutating methods throw `BillingProviderError('manual_provider_sales_managed', 'manual')`; `supportsWebhooks=false`). `src/billing/provider-registry.ts` exports `getBillingProvider(name): BillingProvider`. Webhook router allowlist: `['stripe']`.

4. **Tenant-create wiring.** Existing tenant-create flow also creates a `tenant_billing_accounts` row: `provider='manual'`, `status='trialing'`, `current_plan_id='pro'`, `trial_end = now + 7d`, `is_primary=true`. Sets `Tenant.tier='pro'`. Schedules the delayed trial-expiry job at `trial_end`.

5. **Trial-expiry job + daily sweep.** Per § Reverse-trial signup flow → Trial-expiry job and § Reverse-trial signup flow → Daily safety-net sweep. The sweep is the authoritative recovery path; the delayed per-tenant job is a latency optimization.

6. **StripeBillingProvider.** `npm install stripe`. `src/billing/providers/stripe.ts` implements every interface method (`supportsWebhooks=true`). Each mutating method reads `(provider='stripe', tenant_id)` from `tenant_billing_accounts` and throws `no_active_account` if absent (except `createCustomer`, per interface exception).
   - `createCustomer`: `stripe.customers.search({ query: 'metadata["tenantId"]:"<tenantId>"' })` → if hit, return; else `stripe.customers.create({ email, name, metadata: { tenantId } })`. Returns `{ customerId }`.
   - `createCheckoutSession`: reads `(provider='stripe', tenant_id)` row; requires `customer_id` set; `stripe.checkout.sessions.create({ mode: 'subscription', customer, line_items: [{ price: PLANS[planId].providerPriceIds.stripe.usd, quantity: 1 }], client_reference_id: tenantId, success_url, cancel_url })`.
   - `createPortalSession`: `stripe.billingPortal.sessions.create({ customer, return_url })`.
   - `changeSubscription`:
     - Choose path by `PLANS[newPlanId].rank` vs `PLANS[currentPlanId].rank`.
     - **Upgrade:** `stripe.subscriptions.update(subId, { items: [{ id, price: newPriceId }], proration_behavior: 'always_invoice' })`.
     - **Downgrade:** per § Lifecycle semantics → Plan change → Downgrade. Synchronous `stripe.subscriptions.retrieve(subId, { expand: ['schedule'] })` first; throws `pending_change_exists` if `sub.schedule` is set.
   - `cancelSubscription`: `stripe.subscriptions.update(subId, { cancel_at_period_end: true })`.
   - `undoCancel`: `stripe.subscriptions.update(subId, { cancel_at_period_end: false })`.
   - `undoPendingChange`: `stripe.subscriptionSchedules.release(scheduleId)`.
   - `getSubscription`: `stripe.subscriptions.retrieve(subId, { expand: ['schedule'] })` → normalize.
   - `verifyWebhook`: `stripe.webhooks.constructEvent(rawBody, headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)`.
   - `normalizeWebhookEvent`: maps the following Stripe event types and **extracts `subscriptionId` from each payload** so the unified handler can perform its `(provider, subscription_id)` lookup (codex r4 #2, #8):
     | Stripe event | Normalized type | `subscriptionId` source | `customerId` source |
     |---|---|---|---|
     | `customer.subscription.created` | `subscription.created` | `data.object.id` | `data.object.customer` |
     | `customer.subscription.updated` | `subscription.updated` | `data.object.id` | `data.object.customer` |
     | `customer.subscription.deleted` | `subscription.deleted` | `data.object.id` | `data.object.customer` |
     | `invoice.paid` | `invoice.paid` | `data.object.subscription` (may be null for one-off invoices) | `data.object.customer` |
     | `invoice.payment_failed` | `invoice.payment_failed` | `data.object.subscription` (may be null) | `data.object.customer` |
     | `charge.refunded` | `refund.recorded` | `data.object.invoice` then lookup → may be null | `data.object.customer` |
     | (anything else) | `null` (ignored) | — | — |

7. **Webhook route + event handler.**
   - `src/webhooks/billing-webhook.routes.ts` exposes `POST /webhooks/billing/:provider`.
   - **Middleware ordering invariant** (codex r4 #9 sharpened): in `server.ts`, mount `app.use('/webhooks/billing', express.raw({ type: 'application/json' }), billingWebhookRouter)` **before** any `app.use(express.json())`. The webhook handler receives `req.body` as a Node `Buffer` — it does NOT call `JSON.parse(req.body)`; it passes the Buffer directly to `provider.verifyWebhook`. No other middleware (JSON parsers, body-parsers, etc.) is registered on `/webhooks/billing/*`. A startup assertion can verify this by checking that the route stack for `/webhooks/billing` contains only `express.raw` followed by the route handler.
   - Handler logic per § Webhook event handling (steps 1–10).

8. **Billing service.** `src/billing/service.ts`:
   - `startCheckout(tenantId, planId, returnUrls)`:
     1. Validate `planId ∈ {pro, premium}`.
     2. **Duplicate-checkout guard (round-5 #2):** read-only tx with `SELECT … FOR UPDATE` on all the tenant's billing rows; if the primary row has `provider='stripe'` AND `status IN ('trialing','active','past_due')`, throw `BillingProviderError('subscription_exists', 'stripe')` (route returns HTTP 409).
     3. Call `stripeProvider.createCustomer(tenantId, email, name)` — no DB lock held.
     4. **COALESCE upsert (round-5 #1):** open short tx with `SELECT … FOR UPDATE` on all the tenant's billing rows; `INSERT … ON CONFLICT (tenant_id, provider) DO UPDATE SET customer_id = COALESCE(tenant_billing_accounts.customer_id, EXCLUDED.customer_id), updated_at = now()` so an existing non-null `customer_id` is preserved. Commit. Re-read the row's persisted `customer_id` (do not reuse the local variable from step 3 — the persisted value is the source of truth).
     5. Call `stripeProvider.createCheckoutSession(...)` with the persisted `customer_id` — no DB lock held.
     6. Return hosted-checkout URL.
   - `openCustomerPortal(tenantId, returnUrl)`: rejects with `no_stripe_subscription` if no primary Stripe row; else calls `createPortalSession`.
   - `changePlan(tenantId, planId)`: full validation chain (per § Service-level validation); pre-call `getSubscription` for idempotency; calls `provider.changeSubscription`. **No service-written audit row** — webhook produces it.
   - `cancelAtPeriodEnd(tenantId)`: pre-call `getSubscription` — if `cancelAtPeriodEnd === true`, no-op. Else call `provider.cancelSubscription`. **No service-written audit row.**
   - `undoCancel(tenantId)`: symmetric — pre-call check, then provider call. **No service-written audit row.**
   - `undoPendingChange(tenantId)`: symmetric. **No service-written audit row.**
   - `updateBillingEmail(tenantId, email)`: per § billing_email propagation rule. **Service writes audit row** (local-only op).
   - `getBillingState(tenantId)`: returns plan + status + period + pending change + last 20 `billing_events` rows.
   - `expireTrialIfStillManual(tenantId)`: per § Reverse-trial signup flow → Trial-expiry job. **Service writes audit row.**
   - `setEnterpriseManual(tenantId, opts)`: per § Enterprise flow. **Service writes audit row** (`event_type='tier.manual_override'`).

9. **Routes.** `src/routes/billing.routes.ts` exposes `GET /billing/state`, `POST /billing/checkout-session`, `POST /billing/portal-session`, `POST /billing/change-plan`, `POST /billing/cancel`, `POST /billing/undo-cancel`, `POST /billing/undo-pending-change`, `PUT /billing/email`. All gated behind existing Clerk auth middleware + role check (`admin` | `super_admin`). All Stripe-targeting routes return HTTP 400 with `{ code: 'no_stripe_subscription' }` when service throws that error.

10. **Entitlement enforcement wiring (in scope for v1 — SEVEN enforcement points).** Every count-then-create check runs inside a DB tx that opens `SELECT … FOR UPDATE` on the tenant's `tenants` row:
    1. **Daily LLM call cap** — `src/llm/llm-rate-limit.ts`: read limit from entitlements (with Enterprise per-tenant override). (Counter is Redis-based; no DB lock needed for the counter itself.)
    2. **Concurrent sessions cap** — uses the existing `tenants.current_sessions` int column. Tx with `SELECT … FOR UPDATE` on the `tenants` row, check `current_sessions < entitlements.sessions`, increment `current_sessions` and insert session row inside the tx. `Tenant.maxSessions` becomes the Enterprise-only override. Session-release semantics is pre-existing (out of scope).
    3. **Agent count cap** — `src/routes/agents.routes.ts`: tx-with-row-lock; 402 with `{ code: 'plan_limit_agents', limit }`.
    4. **Channels connected cap** — `src/channels/*` connect path: tx-with-row-lock; 402 with `{ code: 'plan_limit_channels' }`.
    5. **File upload feature gate** — `src/routes/files.routes.ts`: 402 with `{ code: 'plan_limit_file_upload' }`.
    6. **Handoff feature gate** — handoff route module (existing filename in this repo is `src/routes/handsoff.routes.ts` — pre-existing typo in the codebase; use that exact filename; do not "fix" the spelling as part of this work): 402 with `{ code: 'plan_limit_handoff' }`.
    7. **Custom branding / domain gate** — settings-update path: 402 with `{ code: 'plan_limit_custom_branding' }`.

11. **Portal UI.** `portal/src/pages/Billing.tsx`: current plan card, trial countdown, Change Plan / Cancel / Undo-Cancel / Undo-Pending-Change buttons (each shown only in its applicable state and hidden when service returns `no_stripe_subscription`), "Manage payment method" deep-link, billing history (last 20 events), billing email editor. For tenants where `no_stripe_subscription` would fire, the UI shows "Subscribe" (free/manual-trial) or "Contact sales" (Enterprise) instead. Shared `<PlanLimitToast>` for 402 responses across the app.

12. **Super-admin Enterprise action.** Admin panel "Set tier to Enterprise (manual)" button → `POST /admin/tenants/:id/set-enterprise` → `service.setEnterpriseManual`. UI prompts super-admin to cancel any existing Stripe subscription in the Stripe dashboard.

13. **Config.** Env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_USD_MONTHLY`, `STRIPE_PRICE_PREMIUM_USD_MONTHLY`, `BILLING_TRIAL_DAYS` (default `7`). Documented in `chatbot-platform/api/README.md` and `.env.example`. Also document the raw-body middleware ordering invariant (step 7) and the boot-time fail-fast invariant (step 2).

14. **Tests.**
    - **Unit:** `plans.ts` lookups and rank ordering; `entitlements.ts` resolution (free/pro/premium/enterprise + override merge); `stripe.ts` `normalizeWebhookEvent` (one test per supported event type — including `charge.refunded`→`'refund.recorded'` with optional `subscriptionId`, and `invoice.*` with and without `subscription` populated — plus one for an ignored event); `manual.ts` no-op semantics; plan-rank upgrade-vs-downgrade selection; Stripe status mapping table (one case per row, including `incomplete`'s plan-mapping exception); `BillingProviderError` thrown with correct `(code, providerName)`; boot-time env-var validation fails non-zero when any required Stripe var is missing.
    - **Integration:**
      - Webhook round-trip with `INSERT ... ON CONFLICT` idempotency (replay → single mutation, single audit row, `tenant_id` populated when resolvable).
      - Webhook handler rolls back tenant lookup + audit insert + state mutation on a thrown mutation; next retry succeeds.
      - `subscription.updated` for a non-primary Stripe row updates row-local fields but does NOT change `Tenant.tier`.
      - Terminal status on a non-primary row sets that row's `status='cancelled'`/`current_plan_id='free'` but does NOT touch `Tenant.tier`.
      - Out-of-order delivery: `.updated` arrives before `.created`; handler falls back via customer_id, persists `subscription_id` on the pending row.
      - `subscription.created` with `status='incomplete'`: row gets `subscription_id`/`customer_id`/price-mapped `current_plan_id` but stays `is_primary=false`; `Tenant.tier` unchanged.
      - `subscription.created` with `status='trialing'`/`active`: row promoted to `is_primary=true`, manual row demoted, `Tenant.tier` updated.
      - `subscription.*`/`invoice.*` for an unknown identifier writes audit row with `tenant_id = NULL` (or matched via customer_id fallback).
      - Trial-expiry job: (i) manual-only → downgrades; (ii) Stripe pending row within 24h → skips; (iii) Stripe pending row older than 24h, `status='none'` → downgrades; (iv) primary already Enterprise → no-op; (v) recent Stripe `billing_events` row → skips.
      - **Daily sweep:** simulate orphaned trial (delayed job never fired) — sweep selects and downgrades it.
      - `past_due` block on `changePlan`; same-plan rejection; pending-change rejection (local AND remote Stripe-schedule presence both trigger).
      - `cancelAtPeriodEnd`/`undoCancel`/`changePlan` pre-call idempotency: target-already-true skips Stripe call AND (because no webhook fires) produces no audit row.
      - `updateBillingEmail`: Stripe-call failure rolls back local change AND no audit row written.
      - Each of the seven entitlement enforcement points: 402 returned on cap hit; concurrent-create race held to the limit by row-lock-then-count.
      - `refund.recorded` event writes audit row, does not change tier or status.
      - **Unknown Stripe price** in `subscription.updated`: audit row contains `unknown_price`, no state mutation, returns 200.
      - **Multi-subscription-for-same-customer race:** second `subscription.created` for a different `subscription_id` writes audit row with `subscription_mismatch`, no state mutation, returns 200.
      - **No-stripe-subscription route behavior:** `change-plan`/`cancel`/`undo-cancel`/`undo-pending-change`/`portal-session` against a free/manual-trial/Enterprise tenant return HTTP 400 with `{ code: 'no_stripe_subscription' }`.
      - `raw_provider_data` JSONB merge: setting `stripe.scheduleId` does not erase a sibling key written elsewhere.
      - **Duplicate-checkout guard (round-5 #2):** `startCheckout` against a tenant with an active/trialing/past_due primary Stripe row returns HTTP 409 with `{ code: 'subscription_exists' }`; no Stripe customer created, no Checkout session created.
      - **COALESCE upsert (round-5 #1):** `startCheckout` against a tenant that already has a non-null `customer_id` (e.g. from an earlier abandoned checkout) reuses the existing customer; the freshly-resolved Stripe customer is ignored. Race: two concurrent `startCheckout` calls — both end up using the same persisted `customer_id`.
      - **Primary-switch SQL ordering (round-5 #8):** integration test that a `subscription.created`→`trialing` event for a tenant with an existing primary manual row succeeds in one tx; no partial-unique-index violation observed.
      - **Upgrade item-ID resolution (round-5 #6):** `changeSubscription` upgrade path retrieves the subscription first to read `items.data[0].id`; the Stripe `update` call is made with the correct item id; throws `subscription_shape_unexpected` if Stripe ever returns a multi-item subscription.
      - **Schedule retrieve on string id (round-5 #5):** `subscription.updated` payload with `schedule` as a string id triggers `subscriptionSchedules.retrieve`; phases are read and `pending_plan_id`/`pending_plan_effective_at` are populated.
      - **Symmetric unknown-price (round-5 #7):** `subscription.created` with an unknown price ID writes audit row with `unknown_price`, no state mutation; same behavior as `subscription.updated`.
    - **Migration:** assert backfill creates one manual row per pre-existing tenant with matching tier; partial unique indexes on `(provider, customer_id)` and `(provider, subscription_id)` reject duplicate inserts; `raw_provider_data` defaults to `'{}'::jsonb`; `down()` throws.

## Open questions

_(empty)_
