# Chatbot Platform

A multi-tenant chatbot platform where SMB owners configure an AI agent that talks to their customers across channels, grounded in the owner's knowledge base.

## Language

**Tenant**:
An SMB owner who configures and pays for the platform (e.g. a plumber). Owns Agents, KnowledgeBases, and a tier.
_Avoid_: customer, client, user, account.

**Agent**:
The configured AI bot that talks to a Tenant's customers. A Tenant may have multiple Agents.
_Avoid_: bot, assistant.

**ChatSession**:
A single conversation between an Agent and one of the Tenant's customers, composed of Messages.
_Avoid_: chat, conversation, thread.

**KnowledgeBase**:
The corpus of documents (`KnowledgeDocument`, chunked into `KnowledgeChunk`) the Agent retrieves from when answering.
_Avoid_: docs, content, RAG store.

**Insight**:
A persistent finding about a Tenant's ChatSessions and/or KnowledgeBase, with a fingerprint, a severity (Red/Orange/Green), evidence, a recommendation, and a lifecycle state. The user-facing primitive of the Insights feature. In v1, every Insight is a **Gap**.
_Avoid_: finding, observation, alert, signal, success meter.

**Gap**:
The v1 kind of Insight: a topic that one or more ChatSession customers asked about, which the Agent/KnowledgeBase did not satisfy. Identified by a fingerprint of `(tenantId, canonicalTopicId)`. Resolved by uploading a KnowledgeDocument that the next daily refresh confirms answers the topic.
_Avoid_: hole, missing answer, knowledge gap (use Gap).

**Canonical Topic**:
A normalised, human-readable topic phrase (e.g. `"pricing"`, `"emergency availability"`) that lives in a per-Tenant registry. Each Gap is keyed on one Canonical Topic. Created lazily as the LLM encounters new topic phrases in ChatSessions.
_Avoid_: tag, category, label, cluster.

**Qualifying Pain**:
The bar that gates Gap lifecycle transitions: ≥3 distinct visitorIds with an unsatisfied ask of the Canonical Topic in the last 7 days. Only Qualifying Pain opens or reopens a Gap — a satisfied ask, or a single new ask, never does. See [ADR-0005](./docs/adr/0005-gap-lifecycle-state-machine.md).
_Avoid_: signal, threshold, trigger.

**Judgment**:
One LLM verdict on one ChatSession, produced during the nightly `RefreshInsightsJob`. Stores `{ hadQuestion, satisfied, topicPhrase, canonicalTopicId, evidenceMessageIds, reasoning }`. Gap evidence is sourced exclusively from Judgments. See [ADR-0004](./docs/adr/0004-unsatisfied-detection-via-llm-judge.md).
_Avoid_: verdict, analysis, review.

**Tier**:
A Tenant's subscription level, stored on `Tenant.tier`. Marketed values are **Essential**, **Pro**, **Enterprise**. The DB enum additionally contains **`free`** as an internal-only cancellation terminal state — never offered for signup, never shown in upgrade UI, never sold. Cancellation lands a Tenant on `free`; reactivation moves them back to a marketed tier via Stripe.
_Avoid_: plan, subscription level, account type (use Tier).

**Lead**:
A contact captured during a ChatSession by the agent's `capture_lead` tool. Promoted to its own entity (rather than ChatSession metadata) at Essential tier. Holds `name`, `email`, `normalizedEmail`, `phone`, `source`, `status`, `notes`, `capturedAt`, `customFields` (Pro+ tier), and optional `assignedUserId` / `score` / `scoreReason` (Pro+/Enterprise). Upserted by `(tenantId, normalizedEmail)` so a returning visitor doesn't create duplicates. The sidebar surface is **Leads** (the things); the agent-behaviour setting/toggle is called **Lead Capture**.
_Avoid_: contact, prospect, customer, visitor (use Lead).

**Copilot**:
The platform-side AI that answers tenant-admin questions inside the portal — explaining how Axentrio works, surfacing the admin's own tenant state, pointing at the right settings page. Distinct from `Agent`, which serves the Tenant's customers via the chat widget. Pro+ feature (`platformAssistant` entitlement flag). Marketed user-facing as **AI Platform Assistant**; in code, ADRs, API responses, DB columns, and engineering discussion, always use `Copilot`.
_Avoid_: assistant, bot, helper, AI Platform Assistant (use Copilot — the marketing label is an alias, not a domain term).

## Relationships

- A **Tenant** owns one or more **Agents** and one or more **KnowledgeBases**
- An **Agent** participates in many **ChatSessions**
- An **Insight** is scoped to a **Tenant** (and may reference specific **ChatSessions** as evidence)

## Flagged ambiguities

- **"Success Meter" vs "Insight"** — used interchangeably in early discussion. Resolved: **Insight** is the persistent primitive (row with lifecycle); a "meter" or "score" is a derived rollup over Insights, not a stored object. Not building a meter primitive in v1. **Sidebar exception**: `Success Meter` is the user-facing sidebar label for the Insights surface (route stays `/insights`). In code, ADRs, API responses, DB columns, and engineering discussion, always use `Insight` / `Gap`. The label is a marketing alias, not a new domain concept.
- **Three candidate Insight kinds** (Gap / Correlation / Sentiment) — resolved per [ADR-0001](./docs/adr/0001-insights-v1-gaps-only.md): v1 ships only **Gap**. Correlation and Sentiment return in v2 reframed as experiments.
