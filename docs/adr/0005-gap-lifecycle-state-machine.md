# Gap lifecycle state machine — pain-gated, five states

Each Gap has one of five states: `open`, `dormant`, `resolved_data`, `resolved_manual`, `archived`. All transitions are gated on **qualifying pain** (≥3 distinct unsatisfied visitorIds in a 7-day window), not on the topic merely appearing in chats. A satisfied ask is not regression.

| State | Definition |
|---|---|
| `open` | Current qualifying pain |
| `dormant` | No qualifying pain for 14 days, never reached positive evidence |
| `resolved_data` | Positive evidence: ≥3 distinct visitorIds asked in 7 days AND ≤1 of them unsatisfied |
| `resolved_manual` | Tenant clicked "I fixed this" — for actual fixes, not silencing |
| `archived` | Tenant clicked "Not relevant" — explicit non-resolution exit. Distinct from `resolved_*` so Wins tab and manual-action learning aren't polluted by silencing |

Transitions: `open → resolved_data` (positive evidence accrues), `open → resolved_manual` (tenant action), `open → archived` (tenant marks "not relevant"), `open → dormant` (14 days without qualifying pain), `dormant → open` (qualifying pain returns at the full ≥3-unsatisfied bar), `resolved_data → open`, `resolved_manual → open`, and `archived → open` (regression at the same bar — tenant can re-archive if still irrelevant). A single new ask never reopens a Gap.

We chose `≥3 asked AND ≤1 unsatisfied` over `≥5 asked AND ≥80% satisfied` for data-confirmed resolution because at SMB ChatSession volumes (20-200/week) waiting for 5 same-topic asks means most wins never get counted; three with at most one fail is a defensible floor that's actually achievable. Codex pressure-tested an earlier draft that conflated surfacing eligibility with lifecycle truth (allowing low-volume topics to be trapped `open` forever and letting topic appearance reopen Gaps); this ADR is the revised version that separates the two.

`acknowledged` ("I'm working on this") was considered as another state and rejected for v1 — workflow sugar, not lifecycle truth.

`archived` was added on the second codex pass: without it, Tenants who hit an irrelevant Gap (seasonal, out-of-scope, badly-clustered topic) had no exit other than to lie via `resolved_manual` — which would poison the Wins tab and any future learning signal sourced from manual actions. `archived` is the explicit non-resolution exit.
