# Subscription & Feature-Access Epic — Deviations Tracker

Running log of every recommendation that changes the literal text of the subscription/feature-access epic. Each row pins the verbatim quote from the epic against the proposed replacement and the reason — so the PM can approve/reject per row and downstream tickets stay honest.

**Status legend:** `proposed` (awaiting PM nod) · `approved` (PM accepted, becomes binding for ticket creation) · `retracted` (withdrawn during grilling) · `clarification` (not a literal change to epic text, but pins an ambiguity)

| # | Topic | Status | Round |
|---|---|---|---|
| 1 | AC7 wording — Insights intelligence levels | approved | Q4 |
| 2 | Essential bullet — drop "Basic" qualifier on Insights | approved | Q4 |
| 3 | Pro bullet — drop "Advanced" qualifier on Success Meter | approved | Q4 |
| 4 | Enterprise bullets — Insights items become Coming Soon | approved | Q4 |
| 5 | CONTEXT.md — Success Meter sidebar-label carve-out | approved | Q4 |
| 6 | Trial pattern interpretation (only relevant if reverse-trial chosen) | retracted | Q5 |
| 7 | "What payment gateway" — answered as Stripe + Stripe Tax | clarification | Q5 |
| 8 | Trial signup framing — "payment method" not "credit card" | approved | Q5 |
| 9 | Trial reminder emails — defer custom day-7/13 to v2 | approved | Q5 |
| 10 | Enterprise CTA — "Contact Sales" instead of self-serve Buy | approved | Q6 |
| 11 | Locked-module click — preview page, not modal | approved | Q13 |
| 12 | Two-step upgrade flow via comparison page | retracted | Q13 |
| 13 | Badge styling — sentence-case + localized | approved | Q13 |
| 14 | Coming Soon CTA — "Notify me" / "Contact Sales", not "Upgrade" | approved | Q13 |
| 15 | AI Onboarding Flow available to Essential (not Pro-only) | approved | Q8 |
| 16 | AI Onboarding Flow lives in dashboard, not as a sidebar module | clarification | Q8 |
| 17 | AI Platform Assistant constrained to FAQ-grounded help in v1 | approved | Q8 |
| 18 | Sidebar label: `Leads` not `Lead Capture` | approved | Q9 |
| 19 | Enterprise "Advanced lead intelligence" → Coming Soon | approved | Q9 |
| 20 | Pro v1 has no LLM lead scoring — "Advanced" = configurable capture | approved | Q9 |
| 21 | Promote leads to a real `Lead` entity at Essential | approved | Q9 |
| 22 | Tool-registry tier enforcement for booking tools | approved | Q10 |
| 23 | "Calendar integrations" plural → Cal.com-only in v1 | approved | Q10 |
| 24 | No portal-side booking management UI in v1 (read + config only) | approved | Q10 |
| 25 | CRM native connectors → Coming Soon; v1 = hardened webhook kit | approved | Q11 |
| 26 | CRM lives under Settings > Integrations, NOT as a sidebar module | approved | Q11 |
| 27 | "CRM integration" singular current vs "CRM integrations" plural future | approved | Q11 |
| 28 | CRM is one-way (Axentrio → CRM) only in v1, no bidirectional | approved | Q11 |
| 29 | TikTok = Coming Soon card in Social Media hub, no integration in v1 | approved | Q7 |
| 30 | "All social channel integrations" copy honesty — list channels explicitly | approved | Q7 |
| 31 | Coming Soon `Notify me` clicks emit typed demand-signal events | approved | Q7 |
| 32 | HandsOff → Axentrio rename: minimum-viable user-visible only | approved | Q12 |
| 33 | Tier-gated widget attribution = single watermark toggle (not white-label) | approved | Q12 |
| 34 | Split `customBranding` entitlement into typed flags | approved | Q12 |
| 35 | Essential keeps basic widget appearance config (color/title/avatar) | clarification | Q12 |
| 36 | AC7 re-asserted — tiered Insights ladder ships in v1 (supersedes 1-4) | approved | post-epic |

---

## Deviation 1 — AC7 wording on Insights intelligence levels

**Epic says (verbatim):**
> *"AC7 – AI Insights. All subscriptions must have AI Insights access with different intelligence levels."*

**Replacement:**
> *"AC7 – AI Insights. All paying subscriptions have AI Insights access at the same intelligence level in v1. Tier-differentiated intelligence levels (Correlation, Sentiment, faster refresh, longer retention) ship in v2 as the Enterprise-only 'AI Business Insights' module."*

**Reason:** Directly required by ADR-0002 — v1 Insights are intentionally not tier-gated beyond Free. Carving v1 Gaps into quality buckets subtly damages trust. The real tier ladder lands when v2 Insight kinds ship.

**Status:** approved

---

## Deviation 2 — Essential tier bullet on Insights

**Epic says:**
> Essential — *"Includes: … Basic Insights"*

**Replacement:** *"Includes: … Insights"* (drop "Basic")

**Reason:** In v1, Essential and Pro see the identical Insights surface. Calling it "Basic" implies a degraded version exists.

**Status:** approved

---

## Deviation 3 — Pro tier bullet on Success Meter

**Epic says:**
> Pro — *"Includes: … Advanced Success Meter"*

**Replacement:** *"Includes: … Success Meter"* (drop "Advanced")

**Reason:** Same — in v1, Pro's Insights are identical to Essential's. "Advanced" is a claim we don't back. A Belgian Pro buyer at €99.99/mo discovering identical Insights to a €49.99 Essential tenant feels misled.

**Status:** approved

---

## Deviation 4 — Enterprise tier bullets reclassified as Coming Soon

**Epic says:**
> Enterprise — *"Includes: … AI Business Insights … Advanced lead intelligence … Near realtime insights"* (three current features)

**Replacement:** All three lines move into a "Coming Soon at Enterprise" subsection on the pricing/upgrade surface. The current Enterprise tier bullet list does not claim them as today's features.

**Reason:** None of these exist in code. AC4 of the epic explicitly authorises Coming Soon labelling. Listing them as current Enterprise features would be misrepresentation per codex: *"If a reasonable buyer would think they get it after purchase, it must exist."*

**Status:** approved

---

## Deviation 5 — CONTEXT.md Success Meter carve-out

**Epic implies:** Sidebar uses the literal term "Success Meter."
**CONTEXT.md previously said:** *"Success Meter vs Insight … Not building a meter primitive in v1."* — implying the term is avoidable in all contexts.

**Replacement:** CONTEXT.md ambiguity entry now reads — *"Success Meter is the user-facing sidebar label for the Insights surface (route stays `/insights`). In code, ADRs, API responses, DB columns, and engineering discussion, always use Insight / Gap. The label is a marketing alias, not a new domain concept."*

**Reason:** Without the carve-out, the next engineer reading CONTEXT.md will refactor the sidebar label out, treating it as a forbidden term.

**Status:** approved (already applied to `CONTEXT.md`)

---

## Deviation 6 — Trial-pattern interpretation under reverse-trial

**Epic says:**
> *"Automatic subscription activation. After the trial: Pro activates automatically; billing starts automatically."*

**Proposed only-if-reverse-trial-chosen replacement:** *"After the trial, the tenant is downgraded to a free non-billing state unless they have added a payment method, in which case Pro activates automatically and billing starts."*

**Status:** retracted — Q5 resolved with forward-trial, so this rewrite no longer applies.

---

## Deviation 7 — Payment gateway open question answered

**Epic says (open question):**
> *"What payment gateway to be implemented?"*

**Clarification:** Stripe + Stripe Tax. EUR-only. VAT ID collection at checkout, validated against VIES. Existing Stripe scaffolding in `chatbot-platform/api/src/billing/` retained. Stripe account/products/Tax registration assumed to be created fresh during M0.

**Status:** clarification (not a literal epic edit; answers an open question the epic posed)

---

## Deviation 8 — Trial signup framing: payment method, not credit card

**Epic implies (by "automatic activation" + "billing starts automatically"):** A credit card is required at signup.

**Replacement copy:** *"Add a payment method to start your 14-day Pro trial. Bancontact, iDEAL, SEPA Direct Debit, or card accepted."*

**Reason:** Benelux SMB owners (plumbers, florists) pay via local rails — Bancontact (BE), iDEAL (NL), SEPA Direct Debit — more than credit cards. Stripe Checkout supports all of these as recurring setup methods. Excluding them via "credit card" framing would gut top-of-funnel volume.

**Status:** approved

---

## Deviation 9 — Trial reminder emails

**Epic says:**
> *"Suggested reminders: Day 7, Day 12, Day 13."*

**Replacement:** v1 uses Stripe's native `customer.subscription.trial_will_end` email (fires ~day 12, includes hosted update-payment link). Day 7 and day 13 custom emails deferred to v2.

**Reason:** Stripe's native email already covers day 12. The other two require a custom email pipeline with nl/fr/en templates, transactional classification, unsubscribe handling, and compliance ownership — ~1–2 weeks of work for marginal conversion lift. Epic explicitly says "Suggested" so the days aren't hard constraints.

**Status:** approved

---

## Deviation 10 — Enterprise pricing-page CTA

**Epic says (implied by tier card pattern):** Enterprise has a "Start Trial" / "Buy Now" CTA like Essential and Pro.
**Epic also says:**
> *"Enterprise — Starting from €149/month excl. VAT — Designed for businesses requiring advanced automation and integrations."*

**Replacement:** Enterprise tier card on the pricing page shows **"Contact Sales"** CTA. No self-serve Enterprise checkout. `CheckoutablePlanId = 'essential' | 'pro'`. Sales manually creates Stripe Customer + Subscription per signed deal and sets `Tenant.tier='enterprise'` via the existing super-admin route.

**Reason:** "Starting from" is salesperson language, not pricing-page language. Enterprise's main differentiators (CRM, near-realtime insights, AI Business Insights) are Coming Soon per Deviation 4 — selling a €149 self-serve SKU where half the value is unbuilt would be dishonest.

**Status:** approved

---

## Deviation 11 — Locked-module click target

**Epic says:**
> *"Locked Modules must: remain visible / display plan badge / **show upgrade prompts when clicked**"*

**Replacement:** "Show upgrade prompts" is interpreted as **navigating to the module's route**, where the page renders a preview-page hero (one-liner + screenshot + 3 benefit bullets + compact tier strip + primary CTA + secondary "Compare plans" link). Modals are reserved for locked buttons inside unlocked pages, not for locked sidebar modules.

**Reason:** AC4 already authorises preview pages for Coming Soon. Using one pattern for both Locked-by-tier and Coming Soon is consistent. Routes are shareable, support browser history, and a sidebar item that opens an ad-like modal feels cheap per codex.

**Status:** approved

---

## Deviation 12 — Two-step upgrade flow

**Proposed replacement:** Upgrade CTA → `/upgrade` comparison page → Stripe Checkout.

**Status:** retracted (Q13). Codex argued the preview page IS the upgrade page for that specific feature; sending users to a separate comparison page is friction. Primary CTA now goes direct to Stripe Checkout with Pro pre-selected; secondary "Compare plans" link is available for users who want detail.

---

## Deviation 13 — Badge styling

**Epic says (badge examples):**
> *"Examples: PRO / Enterprise / Unlock with Pro / Enterprise Only / Coming Soon"*

**Replacement:** Badges render in **sentence case** and **per-locale** (`Pro` / `Enterprise` / `Unlock met Pro` / `Alleen Enterprise` / `Binnenkort` in nl, with fr equivalents). Sidebar shows the compact badge + lock icon + accessible tooltip. The preview page hero carries the full phrase.

**Reason:** Shouty all-caps looks like an ad. The codebase already has nl/fr/en i18n infrastructure — badges should respect it.

**Status:** approved

---

## Deviation 14 — Coming Soon CTA discipline

**Epic says:**
> *"When users interact with locked modules: explain feature value / explain business benefits / **display upgrade CTA** / encourage natural upgrades"*

**Replacement:** For **Coming Soon** modules specifically (features that don't exist yet at any tier), the CTA is `Notify me` or `Contact Sales`, NOT `Upgrade`. Upgrade CTAs only apply when the feature is real and tier-locked.

**Reason:** An Upgrade button leading to checkout for a feature the customer can't actually use post-purchase is dishonest. Coming Soon should only appear for committed roadmap items with a real owner + horizon.

**Status:** approved

---

## Deviation 15 — AI Onboarding Flow tier-gating

**Epic says (implied):** AI features (AI Platform Assistant, AI Onboarding) are Pro+. Epic explicitly gates "AI Platform Assistant" under Pro tier features. AI Onboarding Flow is listed under "Included Platform Modules" without explicit tier-gating but is grouped with other AI-prefixed features.

**Replacement:** AI Onboarding Flow is **available to all paying tiers including Essential**. Only the persistent AI Platform Assistant (Pattern X) is Pro-gated.

**Reason:** Locking onboarding behind the paywall contradicts the epic's own UX goals ("onboarding is easy; setup is fast") and Business Goals ("reduce onboarding friction; maximize Pro conversions"). Essential tenants who can't get set up will churn — the opposite of "encourage natural upgrades."

**Status:** approved

---

## Deviation 16 — AI Onboarding Flow location

**Epic ambiguity:** "AI Onboarding Flow" appears in the "Included Platform Modules" list (alongside Inbox, AI Bot, etc.), AND the epic says "All major modules should remain visible in the sidebar." But the explicit "Main Sidebar Navigation" list does NOT contain AI Onboarding Flow.

**Clarification:** AI Onboarding Flow lives as a **dashboard panel** (replacing/augmenting `OnboardingBanner.tsx`), NOT as a top-level sidebar item. Once setup is complete, the panel hides; a permanent "Onboarding" nav item would be strange after the tenant is fully configured.

**Reason:** Resolves an internal inconsistency in the epic. Onboarding is a first-run/dashboard concern; codex flagged this directly.

**Status:** clarification

---

## Deviation 17 — AI Platform Assistant scope constraint in v1

**Epic says:** Pro tier "Includes: … AI Platform Assistant …" — no scope specified.

**Replacement:** In v1, the AI Platform Assistant is **FAQ-grounded only** with these v1 constraints:
- Source-linked answers (every response cites the help/FAQ doc it pulled from)
- Refusal when no source exists ("I don't know — try the Help page")
- No setup mutations (can't change settings, can't create/edit anything)
- No tenant-data answers (won't analyze the tenant's chat history, knowledge base, or insights)
- Rate-limited per tenant

**Reason:** A half-baked AI helper that sounds authoritative while being wrong is *worse* than the existing static FAQ. Until we have evals + RAG + multi-turn quality, we ship only the constrained version. Full conversational platform assistant lands in v2.

**Status:** approved

---

## Deviation 18 — Sidebar label: Leads (not Lead Capture)

**Epic says (Main Sidebar Navigation list):**
> *"- Lead Capture"*

**Replacement:** Sidebar label is **`Leads`**. The settings toggle that controls the agent's capture behaviour stays `Lead Capture`. Pricing-page copy keeps "Basic Lead Capture" / "Advanced Lead Capture" framing per the epic.

**Reason:** Users navigate to the page to *work their leads*, not to capture them. "Capture" is agent-behaviour vocabulary; "Leads" is the thing the user touches. Codex's call.

**Status:** approved

---

## Deviation 19 — Enterprise "Advanced lead intelligence" → Coming Soon

**Epic says:**
> Enterprise — *"Includes: … Advanced lead intelligence …"*

**Replacement:** Enterprise pricing card shows **"AI Lead Intelligence — Coming Soon"** with `Notify me` / `Contact Sales` CTA per Deviation 14. Not listed as a current Enterprise feature.

**Reason:** Real AI lead intelligence requires AI hot/warm/cold qualification, cross-session consolidation by email/phone/visitor, and CRM enrichment — codex estimates 6–10+ weeks. Same Q4 honesty pattern: don't sell what doesn't exist.

**Status:** approved

---

## Deviation 20 — Pro v1 has no LLM lead scoring

**Epic says:**
> Pro — *"Includes: … Advanced Lead Capture …"* (undefined scope)

**Clarification of what "Advanced" means at Pro tier in v1:**
- Custom capture fields (budget, service needed, timing, company, postcode)
- Configurable qualification questions surfaced to the Agent during chat
- Tags / segments derived from captured fields
- CSV export of leads
- Lead assignment / routing to configured team recipients
- Custom fields included in the `lead.created` webhook payload

**Explicitly NOT in Pro v1:**
- LLM-based lead scoring (algorithmic or predictive)
- Hot/warm/cold AI qualification
- AI-driven next-action recommendations

**Reason:** Codex: *"Do not call predictive scoring real unless there is actual conversion history. Most SMB tenants will not have enough volume."* "Advanced" in v1 = tenants control what makes a lead useful (custom fields, qualification), not AI black-box scoring. Real LLM scoring lives in the Enterprise Coming Soon module (Deviation 19).

**Status:** approved

---

## Deviation 21 — Promote leads to a real `Lead` entity at Essential

**Epic says nothing about lead storage.**

**Implementation decision:** Create a real `Lead` TypeORM entity at the Essential tier. Don't continue stuffing leads into `chat_sessions.metadata.lead` (jsonb blob). Schema (minimum):
- `id`, `tenantId`, `chatSessionId`, `visitorId`
- `name`, `email`, `normalizedEmail`, `phone`
- `source`, `status`, `notes`
- `capturedAt`, `lastActivityAt`
- `customFields` jsonb (Pro+ writes to this)
- Future nullable: `assignedUserId`, `score`, `scoreReason`

Upsert by `(tenantId, normalizedEmail)` so returning visitors don't create duplicates. Existing `chat_sessions.metadata.lead` blob kept as event-snapshot only, not source of truth. CONTEXT.md updated with `Lead` glossary entry.

**Reason:** Every Pro/Enterprise feature (notes, status, assignment, dedupe, export, CRM sync, scoring, deletion, filtering) becomes awkward against a jsonb blob. Metadata was fine for the prototype; it's wrong for a top-level module.

**Status:** approved

---

## Deviation 22 — Tool-registry tier enforcement for booking tools

**Epic says:** Bookings is a Pro+ tier feature.

**Existing code:** Booking tools (`create_booking`, `check_availability`, `list_bookings`, `reschedule_booking`, `cancel_booking`) are toggled in `CapabilitiesSettings.tsx` — they run for any tenant that has Cal.com configured and toggles them on. No tier check.

**Implementation decision:** Enforce a tier gate in `ToolRegistry`. Booking tools may only be registered/run when `(tenant.tier ∈ {pro, enterprise}) AND (calendarConnected)`. Capabilities UI hides the booking-tool toggles on Essential. Any pre-launch dev/staging tenant currently configured on Essential with booking tools enabled will lose them — acceptable as we have no production payers.

**Reason:** Epic's tier gate must hold at runtime, not just in pricing-page copy. UI-only gating means a tenant who knows the right toggles could bypass the paywall.

**Status:** approved

---

## Deviation 23 — "Calendar integrations" (plural) interpreted as Cal.com-only in v1

**Epic says:**
> Pro — *"Includes: … Calendar integrations … Cal.com integration …"*

The "plural" framing implies multiple providers (Google Calendar, Outlook).

**Replacement:** In v1, Cal.com is the only supported calendar provider. "Calendar integrations" is the umbrella *category* (covering Cal.com today, Google Calendar / Outlook in future), NOT a current plural claim. Any UI that lists "Calendar integrations" must show "Cal.com" as the only connectable provider; other providers appear as Coming Soon per Deviation 14 (Notify me / Contact Sales CTA — not Upgrade).

**Reason:** Honesty pattern from Q4. Google Calendar or Outlook provider integration is 4–8 weeks each per codex. Don't claim plural support when only one provider works.

**Status:** approved

---

## Deviation 24 — No portal-side booking management UI in v1

**Epic implicit:** "AI Booking System" could be read as a full portal calendar where the tenant manages bookings (create/reschedule/cancel from within the portal).

**Replacement scope for v1 Bookings sidebar module (`/bookings`):**
- Booking history table from `BookingLog` (read-only)
- Filters: upcoming / past / cancelled, date range, attendee email/name
- Detail drawer per booking: notes, source ChatSession link, lifecycle events
- Cal.com connection panel: connection state, selected event type, deep-link to Cal.com app for config
- Booking automations panel: confirmation and follow-up toggles/templates (already exists in `AutomationsSettings.tsx` — re-embedded under `/bookings`)

**Explicitly NOT in v1:**
- Portal-side create/reschedule/cancel (the Agent does this in chat; the tenant does this in Cal.com)
- Calendar grid widget showing upcoming bookings on a month/week view
- Multi-provider calendar abstraction layer

**Reason:** Cal.com already provides the operational calendar. Building a portal calendar widget = 5–8+ weeks per codex. "AI Booking System" (the pricing-page bundle term) = Agent booking ability + Cal.com integration + read-only bookings surface + booking automations. The sidebar module is the management surface, not the calendar reimplementation.

**Status:** approved

---

## Deviation 25 — CRM native connectors → Coming Soon; v1 = hardened webhook kit

**Epic says:**
> Enterprise — *"Includes: … CRM integration …"*

This reads as a current Enterprise feature with active CRM connector support.

**Replacement scope for v1:**
- Enterprise pricing card shows **"CRM integration — Coming Soon"** with `Contact Sales` CTA (per Deviation 14).
- v1 actual delivery: Axentrio pushes `lead.created`, `appointment.booked`, `conversation.ended` events to a customer-owned outbound webhook endpoint (existing infrastructure, hardened).
- Sales/CS helps each Enterprise customer wire those events to their CRM via n8n / Make / Zapier / custom middleware.
- We do NOT claim native HubSpot, Pipedrive, or Salesforce support in v1.
- The first native connector is built only when a signed Enterprise customer asks for it. First-choice provider when that happens: **HubSpot** (strong SMB traction, clean API). Second: **Pipedrive** (popular in EU SMB). Salesforce is wrong-buyer overhead — not before v3 at earliest.

**Engineering finding (must address before selling webhooks as the CRM bridge):** Codex audit flagged that `deliverWebhook` may not be persisting to `WebhookDeliveryLog` outside the test route. Needs hardening — proper delivery logging, retries, dead-letter visibility — before Enterprise deals depend on it.

**Effort:**
- Harden webhooks + docs + n8n/Make/Zapier templates for lead-to-CRM flow: **2–3 weeks total**
- First native connector (HubSpot one-way) when needed: **3–5 weeks** on top

**Reason:** Per Q4 honesty pattern. Claiming "CRM integration" without naming the CRMs or shipping a real connector is dishonest. The sales-led Enterprise model (Deviation 10) makes per-deal CRM wiring viable.

**Status:** approved

---

## Deviation 26 — CRM lives under Settings > Integrations, not as a sidebar module

**Epic says:**
> *"Sidebar Visibility Rules: All major modules should remain visible in the sidebar even when … the feature belongs to a higher subscription."*

This could be read to require a "CRM" sidebar entry locked for non-Enterprise.

**Replacement:** CRM is NOT a top-level sidebar item. It appears under `Settings > Integrations` as an Enterprise-only locked card. Non-Enterprise tenants see the card with a `Contact Sales` CTA (no Upgrade button, since CRM is Coming Soon-style per Deviation 25).

**Reason:** Codex: *"CRM is an integration, not a module surface. SMB tenants don't navigate to CRM daily."* Sidebar nav is for daily-work surfaces (Inbox, Leads, Bookings, AI Bot, Success Meter), not configuration-once integrations. "All major modules visible in sidebar" doesn't equate to "every integration becomes nav." The epic itself doesn't list CRM in the explicit sidebar nav.

**Status:** approved

---

## Deviation 27 — Singular vs plural CRM language reconciled

**Epic says:**
> Enterprise tier: *"CRM integration"* (singular)
> Modules list: *"CRM Integration"* (singular)
> Platform requirements: *"CRM integrations"* (plural)
> AC9: *"CRM integrations must remain Enterprise only."* (plural)

**Reconciliation:**
- **Current v1:** "CRM integration via webhooks" (singular — one approach, the webhook kit).
- **Future / platform category:** "CRM integrations" (plural — covers HubSpot, Pipedrive, Salesforce as they ship).
- **Provider-specific UI cards:** Each shown as Coming Soon until built.

**Reason:** Same Q10 pattern. Plural is a roadmap/category word; singular describes current capability. Don't claim plural support when one approach (generic webhook) is live.

**Status:** approved

---

## Deviation 28 — CRM is one-way (Axentrio → CRM) only in v1

**Epic doesn't specify sync direction.**

**Replacement:** v1 and the first native connector (whenever built) ship one-way only:
- Axentrio → CRM: create/update contact, attach chat summary + link, create deal/task optionally, push booking event.
- CRM → Axentrio: NOT supported. CRM-side changes (status, owner, pipeline stage) do not flow back.

**Reason:** Bidirectional sync requires opinionated answers about field ownership: who wins on conflict, who owns pipeline stage transitions, what happens on CRM-side deletion, how GDPR correction propagates, unsubscribe semantics. These are multi-week design decisions. One-way covers the common use case (push leads/bookings) without inheriting CRM-side ownership problems. Bidirectional becomes a v2 (or v3) build driven by a paying customer's actual need.

**Status:** approved

---

## Deviation 29 — TikTok = Coming Soon card, no active integration in v1

**Epic says:**
> Main Sidebar Navigation → Social Media → *"TikTok? (Need to figure it out how for now)"*

**Replacement:** Within the Social Media hub page, TikTok appears as a **Coming Soon card** alongside the active channel cards (Facebook Messenger, Instagram, WhatsApp, Telegram). No OAuth flow, no connect button, no channel adapter, no DM ingestion path. CTA on the TikTok card: `Notify me` (per Deviation 14).

**Why not now:** TikTok Business Messaging is a real API category but is approval-gated, requires partnership status, and is not generally available to SaaS resellers the way Meta's APIs are. There is no honest v1 build path that doesn't go through TikTok's own partner approval or a signed customer funding the partner work.

**Reactivation triggers (when to build):**
- TikTok grants Business Messaging access to Axentrio via official partnership.
- A signed Enterprise customer funds the partner work as part of their deal.

**Explicitly NOT built:** any unofficial scraper, headless browser, or third-party reseller workaround. Breaks TikTok ToS; maintenance nightmare.

**Status:** approved

---

## Deviation 30 — Pricing copy honesty for social channels

**Epic says:**
> Pro — *"Includes: … All social channel integrations …"*
> Essential — *"Includes: … Social channel integrations …"*

Both lines imply a fuller set of channels than v1 ships.

**Replacement copy:**
- Pro: *"All available social channel integrations — Currently Facebook Messenger, Instagram, WhatsApp, and Telegram. TikTok Business Messaging coming soon."*
- Essential: *"Social channel integrations — Includes available supported channels. TikTok coming soon."*

**Reason:** "All social channel integrations" while TikTok is Coming Soon is dishonest. Q4 honesty pattern applied to channel claims.

**Status:** approved

---

## Deviation 31 — `Notify me` clicks emit typed demand-signal events

**Epic doesn't specify telemetry for Coming Soon CTAs.**

**Convention for any Coming Soon CTA across the platform** (TikTok Notify me, Enterprise CRM Contact Sales, AI Lead Intelligence Notify me, AI Business Insights Notify me, future Calendar Integrations Notify me):

Each click emits a typed event with shape:
```
{
  type: 'coming_soon_demand',
  feature: 'tiktok' | 'crm_native' | 'ai_lead_intelligence' | 'ai_business_insights' | 'calendar_google' | 'calendar_outlook',
  tenantId,
  currentTier,
  locale,
  context: { ... feature-specific },
  timestamp
}
```

Persisted (probably via `AuditLog` or a dedicated `demand_signals` table — TBD during M0 design). Aggregated weekly. Used as the buildout trigger for each Coming Soon feature.

**Reason:** Without demand-signal capture, "Coming Soon" is a black box. With it, the team has actual evidence for prioritising the v2 roadmap. Lifts Deviation 14's `Notify me` CTAs from "polite refusal" to "actionable product signal."

**Status:** approved

---

## Deviation 32 — HandsOff → Axentrio rename: minimum-viable user-visible only

**Epic says (by repeated use of "Axentrio"):** The platform is named Axentrio.

**Existing reality:** Product is named `HandsOff` across ~20+ files: portal sidebar fallback (`Sidebar.tsx`), App.tsx, ChatStream.tsx, StatusBadge.tsx, WidgetTest.tsx, `package.json` names, `index.html`, `widget.js` (`[handsoff-widget]` console prefix), Docker container names, README, tailwind config, en/nl/fr i18n strings, types/index.ts.

**Replacement scope for this epic:**
**In scope (must rename for visible consistency with pricing copy):**
- App `<title>` and meta tags → `Axentrio`
- Sidebar fallback product name → `Axentrio`
- Widget watermark text → `Powered by Axentrio` (when Essential)
- Widget console log prefix → `[axentrio-widget]`
- Billing/pricing page feature labels
- Transactional email sender display name + template copy
- Public demo / test widget visible text
- i18n strings that show product name

**Out of scope (deferred to a separate branding cleanup project):**
- Internal class/type identifiers like `HandsOffClient`
- npm package names
- Docker container names
- localStorage keys (e.g. `handsoff_*`)
- Existing webhook/action protocol names (legacy)
- README/dev-doc cleanup unless public-facing

**Codex caveat:** `HandsOff` occurrences are likely overloaded — some are the old brand name, some are legacy "handoff" domain/protocol vocabulary (e.g. `HandoffRequest` entity for human-takeover). Do not blind-replace; grep with context.

**Effort:** Minimum-viable rename = 1–3 days. Full internal rename = 1–2 weeks with regression risk; not worth bundling into this epic.

**Status:** approved

---

## Deviation 33 — Tier-gated widget attribution = single watermark toggle (not white-label)

**Epic says:**
> Essential — *"Includes: … Axentrio branding …"*
> Pro / Enterprise — *"Includes: … No Axentrio branding …"*

**Replacement scope:** A single attribution toggle.
- **Essential:** Widget footer shows `Powered by Axentrio` badge with a link to axentrio.be.
- **Pro / Enterprise:** Badge hidden.

**Explicitly NOT in scope for v1:**
- Custom widget CSS injection
- Custom widget domain (e.g. `chat.tenant-domain.be` instead of Axentrio's domain)
- Custom favicon
- Custom email branding (the transactional emails Axentrio sends always show the Axentrio sender, regardless of tier)
- Full white-label (no platform-relationship visibility anywhere)

**Reason:** Codex: *"do not let 'No Axentrio branding' quietly expand into full white-label."* Watermark removal is the literal epic ask; anything richer is 3–6+ weeks of work that the epic doesn't actually demand. Full white-label becomes a future Enterprise-only feature behind its own entitlement.

**Status:** approved

---

## Deviation 34 — Split `customBranding` entitlement into typed flags

**Existing code:** `api/src/billing/plans.ts` has a single `features.customBranding: boolean` per plan (currently `false` for free/pro, `true` for premium/enterprise). The flag's actual semantic is unclear — does it mean watermark removal, theme customization, custom CSS, custom domain?

**Replacement:** Split into typed flags with explicit semantics:
- `hideWidgetAttribution: boolean` — controls the "Powered by Axentrio" watermark only. Values: Essential=false, Pro=true, Enterprise=true.
- `customWidgetAppearance: boolean` — controls basic widget color/title/avatar/welcome-text config. Values: Essential=true, Pro=true, Enterprise=true (see Deviation 35 — clarification).
- **Future flags (Coming Soon, gated by entitlement when built):** `customWidgetCss`, `customDomain`, `customEmailBranding`.

Keep `customBranding` as a deprecated compatibility alias temporarily if any code consumes it; remove during M0 cleanup.

**Reason:** Codex: *"`customBranding` is too muddy. It can mean watermark removal, theme control, custom logo, custom domain, or full white-label. That ambiguity will keep causing bad product decisions."*

**Status:** approved

---

## Deviation 35 — Essential keeps basic widget appearance config

**Epic implies (by "Axentrio branding" being the only Essential branding line):** Essential tenants might have NO widget customization.

**Clarification:** Basic widget appearance configuration (color, title, avatar, welcome text) is available to **all paying tiers including Essential**. Only the Axentrio attribution watermark is tier-gated (per Deviation 33).

**Reason:** A plumber on Essential still needs the chat widget to visually fit their website. Treating basic styling as a paid differentiator is hostile to the bottom-tier customer and counter to the epic's UX goals ("the platform understands their business"). The epic doesn't explicitly say Essential has no widget styling — it only says Essential displays Axentrio attribution. Codex called this out directly.

**Status:** clarification

---

## Deviation 36 — AC7 re-asserted: tiered Insights ladder ships in v1 (supersedes Deviations 1-4)

**Epic says (verbatim):**
> *"AC7 – AI Insights. All subscriptions must have AI Insights access with different intelligence levels."*

**History:** Deviation 1 (approved, Q4) deferred the "different intelligence levels" part — v1 was to ship one level for all paying tiers, with the ladder arriving in v2 (per ADR-0002). Deviations 2-4 followed through on copy ("Basic"/"Advanced" qualifiers dropped; Enterprise Insights bullets became Coming Soon).

**Replacement:** AC7 is honored **as written, now**: every paying tier has AI Insights at a different level, differentiated along the axes ADR-0002 itself enumerated for the future ladder (insight kinds, evidence drill-down, retention) — Essential: Gap findings without evidence drill-down, 30-day history; Pro: + evidence drill-down, 90-day history; Enterprise ("AI Business Insights"): + AI digest, Correlation, Sentiment kinds, 365-day history, export. The refresh-cadence axis is deliberately not used (see ADR-0013). Detection quality is identical at every tier — no quality-bucketing of findings. Pricing copy names concrete capabilities per tier instead of restoring the "Basic"/"Advanced" qualifiers Deviations 2-3 removed; Deviation 4's Coming Soon bullets flip to real as Enterprise capabilities land.

**Reason:** Stakeholder re-assertion (2026-06-11, approved by Achraf): tier differentiation is a launch requirement, not a v2 follow-up. Mechanics in [ADR-0013](./adr/0013-tiered-insights-ladder.md), which supersedes ADR-0002. Scope: `.scratch/plan-insights-tiering.md`.

**Status:** approved

---

## Conventions

- New deviations get appended to the table AND added below as a full entry.
- Status moves `proposed` → `approved` when the PM confirms. Once `approved`, the deviation is binding for ticket creation in this epic.
- When a deviation is retracted (e.g. Deviation 6, 12), keep the entry but mark status `retracted` with a one-line reason — the audit trail matters.
- Numbering never reuses retired numbers.
- The Round column points back to the grill question (Q1–Q13+) where the deviation was decided.
