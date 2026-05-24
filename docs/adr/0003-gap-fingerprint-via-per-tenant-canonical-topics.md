# Gap fingerprint via per-Tenant canonical topic registry

A Gap's identity must be stable across daily refreshes so the lifecycle (`open → resolved`) holds. We rejected embedding-cluster fingerprints because cluster centroids drift as session membership changes — tomorrow's "pricing" cluster is not provably the same Gap as today's. We rejected a closed taxonomy because the platform is multi-vertical (plumbers, lawyers, etc.) and one taxonomy won't fit.

Each unsatisfied ChatSession is run through an LLM that extracts a short topic phrase. The phrase is looked up against the Tenant's **canonical topic registry** (lemmatised string match); on miss, a single LLM merge-or-create call decides whether the new phrase is the same as any existing canonical topic for that Tenant. The Gap fingerprint is `(tenantId, canonicalTopicId)`. Registry is per-Tenant (not global) to prevent one Tenant's quirky vocabulary contaminating another's. Recommendation text on each Gap is generated fresh per refresh — only the canonical topic is identity.

Known failure mode: inconsistent LLM extraction may occasionally produce two canonical topics for one underlying problem ("pricing" vs "rates"). Mitigation: a manual "merge these two Gaps" UI is on the v1.1 list, not v1 critical path.
