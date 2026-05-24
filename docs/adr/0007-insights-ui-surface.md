# Insights UI surface — sibling page, lifecycle-tab IA, tiered freshness banner

Insights ships as a new top-level page `Insights.tsx` in the portal sidebar, sibling to `Analytics.tsx` — not nested inside it. Analytics is a chart surface; Insights is an action surface with evidence, and the "Wins" retention hook needs primary visibility rather than being buried as a sub-tab.

**Information architecture.** Two primary tabs — `Open` and `Wins`. `Wins` holds both `resolved_data` and `resolved_manual` Gaps, visually distinguished by badge (data-confirmed ✅ vs self-reported ✓). `Dormant` and `Archived` Gaps are reachable via a filter ("Show older Gaps"), not primary tabs — codex flagged Dormant as system bookkeeping rather than an SMB-owner concept, and Archived shouldn't compete with the dopamine loop in Wins.

**Gap card.** Severity icon + Canonical Topic + headline ("N customers asked about *topic*") + LLM recommendation paragraph + three actions: `View chats`, `Mark resolved`, `Not relevant`. The third action drives the `open → archived` transition added in [ADR-0005](./0005-gap-lifecycle-state-machine.md).

**Drill-down.** `View chats` opens evidence list with masked visitorId, customer-ask excerpt, Agent-response excerpt, and LLM judge reasoning per evidence ChatSession. Full session view links out to existing Inbox — no duplicate surface.

**Freshness banner is tiered, not blocking-or-nothing.** Codex pushed back on an earlier "<90% completeness blocks the UI" proposal as too aggressive. v1 uses: ≥90% completeness → no banner; 50-89% → warn banner ("Insights based on X% of recent chats"); <50% → blocking banner. The `<20 ChatSessions in 7-day window` cold-start case shows a separate "warming up — X/20 chats analysed" state.

No "Dismiss" or "Ignore" naming — uses "Not relevant" to be clear that the action is non-resolution.
