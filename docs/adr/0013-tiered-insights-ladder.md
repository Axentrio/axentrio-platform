# Tiered Insights ladder (supersedes ADR-0002)

Every paying tier gets AI Insights at a different level, shipping in v1 (Deviation 36 — stakeholder re-asserted AC7 on 2026-06-11). The ladder uses exactly the axes [ADR-0002](./0002-insights-v1-not-tier-gated.md) enumerated for its future v2 ladder: insight **kinds**, evidence **drill-down**, and **retention**. Essential: Gap findings (topic, occurrences, severity, lifecycle) without evidence drill-down, 30-day Wins/resolved history. Pro: + evidence drill-down, 90 days. Enterprise ("AI Business Insights", a marketing name not a Module): + AI narrative digest, Correlation and Sentiment kinds, 365 days, export. Detection is one pipeline with one set of thresholds for every tier — the trust principle ADR-0002 protected (no quality-bucketing of identical findings) is preserved; lower tiers get fewer kinds and shallower supporting material, never worse findings. Free remains excluded (`dailyLlmCalls: 0` — nothing to analyse).

Three stored boolean Features carry the ladder: `gapInsights` (all paying tiers — the Insights surface and gap endpoints), `gapEvidence` (Pro+), `aiBusinessInsights` (Enterprise). The tier→flag mapping lives in the plan catalog (`plans.ts`), **not in this ADR** — moving a capability up or down the ladder is a catalog row + pricing-copy change, no ADR ceremony. Correspondingly, insights code never branches on tier names: every gate, the refresh-job tenant filter, and each UI affordance key off the flags alone, and contract tests assert per flag set. Retention is a query-time window keyed off the flag set (30/90/365 days); rows are never deleted, so upgrades restore history instantly and downgrades are non-destructive. Unentitled evidence shows the locked-preview affordance (Deviation 11) rather than disappearing.

The refresh-**cadence** axis ADR-0002 also listed is deliberately dropped. [ADR-0006](./0006-pure-nightly-refresh-with-completeness-watermark.md)'s watermark means each session is judged exactly once whenever the job runs — cadence changes freshness, not LLM spend — and its completeness banner would leave throttled tiers reading "Insights incomplete" most of the week: artificial staleness with UX damage and zero savings. All paying tiers refresh nightly; ADR-0006 is unchanged, except the job includes tenants by `gapInsights` (its 7-day backfill-on-enablement already covers any tenant whose flag turns true later, by plan change, upgrade, or override).

Housekeeping: ADR-0002 predates the plan rename — its "pro/premium/enterprise" reads as today's `essential/pro/enterprise` (migration `1782000000000-RenamePlansEnumToEssentialPro`).

---

## Amendment, 2026-08-17: cadence shipped; it is not dropped

The paragraph above that drops the refresh-cadence axis and says every paying tier refreshes nightly is stale. Shipped policy lives in `api/src/insights/analysis-policy.ts` and is read from the Feature flags, never a tier name:

- **Essential** (`gapInsights` alone) — manual only, ≥15 new analysable conversations, at most once per 72h.
- **Pro** (`+gapEvidence`) — manual only, ≥8 new analysable conversations, at most once per 24h.
- **Enterprise** (`+aiBusinessInsights`) — automatic rolling; no button and no cooldown.

The nightly `RefreshInsightsJob` therefore includes only tenants whose policy is `automatic`. Essential and Pro analyse on demand (`POST /insights/analyse`). Cadence *does* change spend: each analysed conversation is one LLM call unless the prefilter (the two-layer cost model) skips it, and the min + cooldown exist to protect the output and the bill respectively. The ADR-0006 watermark is unchanged as the delta mechanism — each session is still judged at most once whenever a run happens.
