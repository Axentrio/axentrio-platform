# Pure-nightly refresh with completeness watermark

A single per-Tenant cron at 02:00 UTC runs `RefreshInsightsJob`: judges all `closed`/`handoff` ChatSessions since `lastRefreshedAt`, persists each Judgment, then aggregates the last 7 days into Gap state per [ADR-0005](./0005-gap-lifecycle-state-machine.md). Sequential within a Tenant — no concurrent workers — which incidentally eliminates the canonical-topic merge-or-create race condition without needing locks. Codex pushed back on an earlier event-driven proposal: at 20-200 sessions/week per Tenant the smoother-spend and per-session-auditability gains don't justify the extra complexity of two job paths.

**Completeness watermark.** Treating LLM-failed or unjudged sessions as "missing evidence is neutral" silently corrupts Gap state — 20 unjudged sessions in the window could include unsatisfied asks that would otherwise open a Gap. Every Tenant-window therefore carries a `judgments_completeness` ratio (judged eligible / total eligible). Below 90%, the Insights UI surfaces "Insights incomplete — analysing N more chats" rather than presenting state as authoritative. The state machine still runs; the UI guards.

**7-day backfill on enablement.** First run for a newly-enabled Tenant also judges the prior 7 days of closed sessions, capped at 500. Avoids the empty "warming up" first impression that hurts launch.

**No hard daily cap on judgments.** A fixed per-Tenant cap creates permanent backlog for noisy Tenants and invisible freshness drift. v1 monitors token spend per Tenant via existing billing telemetry; if/when a Tenant blows costs, v1.1 adds a budget mechanism.

UTC scheduling for v1 — APAC Tenants will see "yesterday's" state mid-workday, mitigated by surfacing `lastRefreshedAt` and the window boundaries in the panel. Per-Tenant local scheduling is v2.
