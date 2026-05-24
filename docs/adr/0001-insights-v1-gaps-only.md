# v1 Insights ships Gaps only — Correlation and Sentiment deferred

We considered three candidate Insight kinds: **Gap** (a topic asked about that the KnowledgeBase/Agent didn't satisfy), **Correlation** (behavior X co-occurs with outcome Y), and **Sentiment** (recurring praise/complaint cluster). v1 persists and lifecycles only Gaps because they have a stable fingerprint (topic identity), a binary computable resolution signal (was the topic answered in the next daily refresh), and a concrete user action (upload a KnowledgeDocument).

Correlation insights cannot be cleanly resolved at SMB ChatSession volumes (20–200/week): outcome and lift-based rules need samples we don't have, and labeling mere adoption-of-X as "resolved" would damage trust because the original insight made a causal claim. Sentiment clusters have no resolution path at all. Both return in v2 reframed as **experiments** ("try this — here's whether you adopted it") rather than resolvable Insights.
