# Unsatisfied detection via LLM judge per closed ChatSession

Gap evidence is sourced by running one LLM judgement call per ChatSession when it transitions to `closed`, plus an automatic flag for `status='handoff'`. The judge returns `{ hadQuestion, satisfied, topic, evidenceMessageIds }`; sessions where `hadQuestion=true AND satisfied=false` (or `status='handoff'`) become Gap evidence keyed on `topic` (per [ADR-0003](./0003-gap-fingerprint-via-per-tenant-canonical-topics.md)). Open and active sessions are not judged — their outcome may still flip favourably.

We rejected stacked free signals (retrieval confidence, Agent string-match, customer follow-up heuristics, abandonment, `satisfactionRating`) because each has a known blind spot and combining them as a weighted score is fragile, hard to tune, and unexplainable to the Tenant. One opinionated LLM judgement is defensible ("the customer asked X, the Agent said Y, we judged it unsatisfied") and the reasoning surfaces directly in drill-down. At SMB ChatSession volumes (20-200/week per Tenant) the cost is ~$0.05-0.25/week per Tenant using a cheap model — negligible.

A "the LLM judged this wrong" override per evidence ChatSession is deferred to v1.1; v1 trusts the judge and we revisit if the failure rate is material.
