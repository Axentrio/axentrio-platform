# Insights v1 is not tier-gated beyond Free

> **Superseded by [ADR-0013](./0013-tiered-insights-ladder.md)** (2026-06-11, Deviation 36): the v2 ladder this ADR anticipated ships in v1, along the axes enumerated below (minus cadence).

v1 ships Gaps only (per [ADR-0001](./0001-insights-v1-gaps-only.md)), so there is too little surface in v1 to support a meaningful tier ladder without resorting to threshold gating ("Pro plumbers see better insights than Essential plumbers") — which subtly damages trust because lower-tier Tenants get materially worse-quality findings. Instead, v1 Insights are available to all paying tiers (`pro`, `premium`, `enterprise`) at full quality. Free is excluded because Free already has `dailyLlmCalls: 0` (cannot run an Agent) and therefore has no ChatSessions to analyse.

The real tier ladder for Insights kicks in at v2, when Correlation/Sentiment kinds, drill-down, retention windows, and refresh cadence become differentiable axes. Until then, the only Insights-related entitlement is a binary `insightsEnabled: boolean` derived from `tier !== 'free'`.
