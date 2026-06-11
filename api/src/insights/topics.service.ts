/**
 * Canonical-topic registry — merge-or-create (ADR-0003), guarded per
 * ADR-0009 layer 2 (validation on the candidate canonical phrase) and
 * layer 4 (evidence grounding: the merge decision must cite message ids
 * from the source judgment's own evidence).
 *
 * No locks needed: the refresh job is sequential within a tenant (ADR-0006),
 * which eliminates the merge-or-create race by construction.
 */
import { AppDataSource } from '../database/data-source';
import { CanonicalTopic } from '../database/entities/CanonicalTopic';
import { getProvider } from '../llm/provider-factory';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../llm/defaults';
import { normalizeTopic, validateTopic, TopicRejectReason } from './topic-validation';
import { logger } from '../utils/logger';

export type CanonicalizeResult =
  | { ok: true; canonicalTopicId: string }
  | { ok: false; rejectReason: TopicRejectReason | 'merge_invalid' | 'merge_ungrounded' };

const MERGE_PROMPT = `You maintain a registry of short English topic phrases for one small business's customer questions.

Given a NEW topic phrase and the EXISTING registry, decide whether the new phrase names the same underlying topic as an existing entry, or is genuinely new.

Answer ONLY with JSON: {"decision": "merge_with_existing:<id>" or "create_new", "canonical_topic": string, "evidence_message_ids": string[]}

Rules:
- Merge when the phrases name the same thing a customer asks about ("pricing" / "rates" / "how much it costs").
- canonical_topic: for merge, the EXISTING entry's exact phrase; for create_new, the new phrase normalised to 1-6 plain English words.
- evidence_message_ids: copy the message ids you were given as evidence — never invent ids.`;

/**
 * Resolve a validated topic phrase to a canonical topic id, creating or
 * merging via one LLM call on registry miss. Returns a reject result rather
 * than throwing for guardrail failures — the caller persists those as
 * unsatisfied_unmapped diagnostics (ADR-0009 layer 3).
 */
export async function canonicalizeTopic(
  tenantId: string,
  rawPhrase: string,
  evidenceMessageIds: string[],
): Promise<CanonicalizeResult> {
  // Layer 2, judge end.
  const judgeReject = validateTopic(rawPhrase);
  if (judgeReject) return { ok: false, rejectReason: judgeReject };

  const normalized = normalizeTopic(rawPhrase);
  const repo = AppDataSource.getRepository(CanonicalTopic);

  // Exact normalised match — the cheap path.
  const existing = await repo.findOne({ where: { tenantId, topic: normalized } });
  if (existing) return { ok: true, canonicalTopicId: existing.id };

  const registry = await repo.find({ where: { tenantId }, take: 300 });
  if (registry.length === 0) {
    const created = await repo.save(repo.create({ tenantId, topic: normalized }));
    return { ok: true, canonicalTopicId: created.id };
  }

  // Registry miss with existing entries → one merge-or-create LLM call.
  const provider = getProvider(DEFAULT_PROVIDER);
  const response = await provider.chat(
    [
      { role: 'system', content: MERGE_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          new_phrase: normalized,
          evidence_message_ids: evidenceMessageIds,
          registry: registry.map((r) => ({ id: r.id, topic: r.topic })),
        }),
      },
    ],
    { model: DEFAULT_MODEL, maxTokens: 200, temperature: 0, jsonMode: true },
  );

  let parsed: { decision?: string; canonical_topic?: string; evidence_message_ids?: unknown };
  try {
    parsed = JSON.parse(response.content);
  } catch {
    logger.warn('[insights-topics] unparseable merge-or-create response', { tenantId, normalized });
    return { ok: false, rejectReason: 'merge_invalid' };
  }

  // Layer 4: evidence grounding — cited ids must be a subset of the source evidence.
  const cited = Array.isArray(parsed.evidence_message_ids) ? parsed.evidence_message_ids : [];
  const sourceSet = new Set(evidenceMessageIds);
  if (!cited.every((id) => typeof id === 'string' && sourceSet.has(id))) {
    logger.warn('[insights-topics] merge-or-create cited ungrounded evidence — rejected', {
      tenantId,
      normalized,
    });
    return { ok: false, rejectReason: 'merge_ungrounded' };
  }

  const decision = typeof parsed.decision === 'string' ? parsed.decision : '';
  if (decision.startsWith('merge_with_existing:')) {
    const targetId = decision.slice('merge_with_existing:'.length);
    const target = registry.find((r) => r.id === targetId);
    if (target) return { ok: true, canonicalTopicId: target.id };
    return { ok: false, rejectReason: 'merge_invalid' };
  }

  if (decision === 'create_new') {
    // Layer 2, canonical end.
    const candidate = normalizeTopic(parsed.canonical_topic ?? normalized);
    const canonReject = validateTopic(candidate);
    if (canonReject) return { ok: false, rejectReason: canonReject };
    const created = await repo.save(repo.create({ tenantId, topic: candidate }));
    return { ok: true, canonicalTopicId: created.id };
  }

  return { ok: false, rejectReason: 'merge_invalid' };
}
