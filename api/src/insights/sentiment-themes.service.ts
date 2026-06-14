/**
 * Sentiment-theme registry (P3 / ADR-0014, D5) — a per-Tenant registry of
 * recurring praise/complaint themes, SEPARATE from the Gap canonical-topic
 * registry (Gap topics drive Gap lifecycle; conflating pollutes it).
 *
 * Reuses the ADR-0009 validation guardrails (reject "stuff"/"info"/sentence-
 * style junk), then a normalize + exact-match-or-create. (LLM near-duplicate
 * merge — "slow response" vs "slow replies" — is a deferred refinement; the
 * ≥3-distinct-session recurrence gate downstream covers fragmentation noise.)
 */
import { AppDataSource } from '../database/data-source';
import { SentimentTheme, SentimentPolarity } from '../database/entities/SentimentTheme';
import { normalizeTopic, validateTopic } from './topic-validation';

export type CanonicalizeThemeResult =
  | { ok: true; themeId: string }
  | { ok: false; rejectReason: string };

/**
 * Resolve a raw theme phrase to a sentiment-theme id, creating on miss.
 * Returns a reject result (not a throw) for guardrail failures so the caller
 * simply stores no theme on that judgment.
 */
export async function canonicalizeSentimentTheme(
  tenantId: string,
  rawTheme: string,
  polarity: SentimentPolarity,
): Promise<CanonicalizeThemeResult> {
  const reject = validateTopic(rawTheme); // same 1-6 word / stopword / sentence guardrails
  if (reject) return { ok: false, rejectReason: reject };

  const normalized = normalizeTopic(rawTheme);
  const repo = AppDataSource.getRepository(SentimentTheme);

  const existing = await repo.findOne({ where: { tenantId, theme: normalized } });
  if (existing) return { ok: true, themeId: existing.id };

  const created = await repo.save(repo.create({ tenantId, theme: normalized, polarity }));
  return { ok: true, themeId: created.id };
}
