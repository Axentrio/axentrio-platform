# Multi-bot work — status & integration notes for the billing session

**Branch:** `feat/multi-bot-phase1` (4 feature commits + this doc)
**Status:** backend Phases 1–3 (billing-independent parts) done & API-typechecks clean. Remaining work is **gated on the billing epic** because it touches files the billing session is rewriting.
**Full design:** `.scratch/plan-multi-bot.md` (grilled + 5 rounds of codex review).

---

## TL;DR for the billing dev
You and this work touch four of the same files. I committed **only** my multi-bot lines and left your in-flight billing changes untouched in the working tree. When your epic lands, you need to do ~4 small integrations (see **Action items** at the bottom) so multi-bot goes live. Nothing here changes billing behavior; it's all additive and behavior-neutral until those integrations are wired.

---

## What "a bot" is now (key mental model)
- Pre-existing trap: the `Agent` entity / `support_agents` table is the **human** handoff operator, **not** the AI bot (despite `CONTEXT.md:11-13`). The `agents` table belongs to **n8n** (shared `public` schema). New app tables are domain-prefixed (`chatbot_*`).
- Before this work there was **no bot entity** — a "bot" was `Tenant.settings` + the tenant's single `Tenant.apiKey`.
- Now there is a `Bot` entity (`chatbot_bots`). Each tenant has exactly one **anchor bot** (`isDefault=true`) whose `publicKey` **equals the legacy `tenant.apiKey`**, so every existing widget embed keeps resolving unchanged. The anchor is non-deletable/non-pausable in v1.

## What was built (commits on this branch)
| Commit | What |
|---|---|
| `13d278d` | **Phase 1.** `Bot` + `BotKnowledgeBase` entities; `ChatSession.botId` (nullable); `CreateBotTables` migration (tables, named constraints, partial-unique one-default-per-tenant index; **backfills one anchor bot per tenant**, stamps existing sessions, attaches existing KBs); widget `/init` stamps new sessions; n8n `OutboundMessage` carries `botId`. |
| `8b7c377` | **Phase 2.** `bots.routes.ts` CRUD (list/create/get/rename/pause-activate/soft-delete/embed) + `bot.schema.ts`. Anchor protected. Transactional create with `bk_` key + collision retry. |
| `9ed5c1f` | **Phase 3 — RAG scoping.** `searchKnowledge`/`generateResponse` take optional `knowledgeBaseIds` (undefined=tenant-wide, `[]`=answer-from-nothing). Threaded via `session.botId` (message-forwarding fallback, `kb_search` tool) and an optional `botId` body param on the n8n `/rag/search` route. |
| `5c737b5` | **Phase 3 — multi-KB.** `KnowledgeBase.botId` + partial-unique `(tenantId) WHERE botId IS NULL`; resolvers primary-scoped; ingestion chunks against the doc's own KB; `POST /bots` auto-seeds+attaches a dedicated KB; attach/detach/list endpoints. |

New DB migrations: `1782600000000-CreateBotTables`, `1782700000000-AddBotIdToKnowledgeBase` (timestamps run **after** your billing migrations `1782000–1782500`, which is the correct order — `AddBotIdToKnowledgeBase` FK-depends on `chatbot_bots`).

---

## ⚠️ The four shared files (where we overlap)
I committed only my hunks. These still hold **your** uncommitted billing changes in the working tree:

1. **`api/src/middleware/clerk.middleware.ts`** — *not committed by me; merge point.*
   My anchor-bot creation block is interleaved with your forward-trial refactor (removed `seedTrialAccount`, `tier: pro→free`). When you finalize this file, **keep both**: your tier/trial logic **and** the `manager.insert(Bot, {...}).orIgnore()` block that creates the anchor bot in the same transaction as the tenant insert (`public_key = t.apiKey`, `isDefault: true`, `settings = tenant.settings minus ai.apiKey`). Without it, **newly provisioned tenants get no anchor bot**, and bot-key resolution will fail for them later.

2. **`api/src/database/data-source.ts`** — I committed only the `Bot` + `BotKnowledgeBase` registrations. Your billing entity registrations (`StripeWebhookEvent`, `TenantTrialReservation`, `DemandSignal`) are still uncommitted in the working tree — commit them with your epic.

3. **`api/src/server.ts`** — *not committed by me.* The `/bots` router import + `apiRouter.use('/bots', botsRoutes)` mount are in the working tree, interleaved with your billing route registrations. **Until this mount lands, every `/bots` endpoint 404s** and the whole bot CRUD/management surface is inert.

4. **`api/src/billing/plans.ts`, `enforce.ts`, `types.ts`** — untouched by me (they're yours, mid-refactor). The bot **quota gate is deferred to you** (see action items).

---

## Action items for the billing session (to make multi-bot live)
1. **Mount the router**: keep the `server.ts` `/bots` import + `apiRouter.use('/bots', botsRoutes)` lines.
2. **Keep the anchor-bot block** in `clerk.middleware.ts` auto-provision (see #1 above).
3. **Add the `bots` quota** to the plan model:
   - Add `bots: number | null` to `PlanLimits` and `Entitlements.limits` (`billing/types.ts`).
   - Set per-tier values in `PLANS` (`billing/plans.ts`). Tiers are now `free`/`essential`/`pro`/`enterprise` — **the earlier `1/1/5/∞` ("premium") mapping is stale; pick fresh counts.** Suggested starting point: `free: 1` (cancellation sink — or 0), `essential: 1`, `pro: 3–5`, `enterprise: null`. **Needs a product decision.**
   - Wire the gate: there are two `TODO(billing)` markers in `api/src/routes/bots.routes.ts` — in `POST /bots` (create) and `PATCH /:id` (activate/un-pause). Call your `enforceCountLimit` equivalent there, counting non-deleted `chatbot_bots` for the tenant. **Quota counts paused bots; only soft-delete frees a slot.**
4. **Per-tier feature gating (optional):** if multi-bot itself is tier-gated (vs. just count), gate the create UI/endpoint behind a feature flag too.

---

## Behavior-neutral guarantees (why this is safe to merge)
- Anchor `publicKey == tenant.apiKey` → existing embeds unchanged. Widget config is still read from `tenant.settings` (the per-bot `bot.settings` flip is a later phase).
- Each tenant has exactly one KnowledgeBase today, now marked tenant-primary (`botId IS NULL`); the anchor is attached to it → RAG scoping to "the bot's KBs" == tenant-wide for all current traffic.
- RAG `knowledgeBaseIds` is optional; all untouched callers stay tenant-wide.

## Still pending (not blocked by billing — future multi-bot phases)
- **`chat_sessions.bot_id NOT NULL`** — Phase 1 left it nullable. A follow-up migration enforces NOT NULL only after all instances are bot-aware and null sessions have drained (a NULL `botId` binds to the resolved bot on resume — that resume logic is itself deferred, see below).
- **Resolution refactor (`resolveBotKey`) + session↔bot binding/paused rejection** across the other 4 key-resolution paths (`tenant.middleware`, `auth.routes`, websocket, widget `/config`) — only meaningful once non-anchor bots exist; deferred to when multi-bot creation is user-exposed.
- **Per-bot config flip**: move widget config read+write from `tenant.settings` → `bot.settings` (ship read+write together; enable multi-bot creation only after).
- **n8n workflow lockstep**: the API now *sends* `botId` and *accepts* `botId` on `/rag/search`, but the n8n workflow must be updated to send `botId` (and honor the KB-id list / no-fallback) or n8n's own RAG stays tenant-wide.
- **Portal Bots UI** — blocked: portal build is currently red from billing's `components/billing/*` test files; routing/nav (`App.tsx`, `Sidebar.tsx`) are mid-refactor; backend not mounted. Build after billing lands.

## Verification status
- **`tsc --noEmit` (api): green** after every commit.
- **API test suite NOT run** — needs a live Postgres unreachable from this sandbox (all 88 files fail identically on `pg_hba`). Run `npx vitest run` against a real DB / CI.
- **Portal**: does not typecheck currently due to pre-existing billing-epic errors (not multi-bot).
