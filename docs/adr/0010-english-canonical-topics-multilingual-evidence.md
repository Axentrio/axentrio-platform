# English canonical topics — internal dedup key, not display copy

The platform supports multilingual chat (Dutch, French, Spanish via WhatsApp/Telegram/Messenger). Without a language policy, the Canonical Topic registry would collect `"pricing"`, `"prijzen"`, `"tarifs"` as three separate canonicals for one underlying concept, permanently breaking Gap dedup across languages.

v1 normalises all canonical topic phrases to English. The LLM judge prompt instructs *"extract topic in English regardless of customer language."* The registry stores English. We rejected embedding-space IDs (harder to debug, threshold-sensitive, silently over-merging) and language-tagged composites (preserves the dedup bug under a different shape).

**The critical framing:** the English canonical topic is an **internal dedup key**, not localised display copy or evidence. Concretely:

- **Recommendation paragraph** is generated per refresh in the conversation language (it isn't part of the fingerprint per ADR-0003, so it's free to localise).
- **Evidence ChatSessions** in drill-down retain their original-language messages and Agent responses — the Dutch plumber reads Dutch customer chats in Dutch, not translated.
- **UI surfacing** uses neutral structures (`Topic: pricing`, `12 customers`) rather than grammar-heavy interpolation — avoiding the smell of an English noun stuffed into Dutch sentence flow.
- v2 adds a per-Tenant display translation layer over the English key.

Accuracy risk (multilingual judge degradation on idioms, short fragments, domain nuance) is mitigated by multilingual test fixtures, per-Judgment confidence logging, and the fact that original-language evidence is always retained on the Judgment row for drill-down trust. Per-Tenant primary language and full display translation are deferred to v2.
