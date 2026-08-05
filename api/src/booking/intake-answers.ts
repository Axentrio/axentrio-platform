/**
 * Joining stored intake ANSWERS to their question LABELS.
 *
 * Its own module, and deliberately free of database, calendar and email imports: the leads
 * projection needs exactly this one function, and importing it from `booking.service` pulled
 * that whole graph into the leads route — which is enough to perturb module load order and
 * make unrelated suites fail intermittently.
 *
 * Answers are stored keyed by the server-minted question id, so without this join every
 * surface prints a uuid where the owner's own question belongs.
 */
import type { IntakeQuestion } from '../database/entities/ServiceType';

/**
 * P3: read-side coercion of a stored intake answer — MUST mirror the write-side
 * `normalizeIntakeAnswers` so reads/writes agree on a "displayable answer".
 * string→trim; number/boolean→String; null/undefined/array/object→null; cap 2000.
 */
function coerceAnswer(value: unknown): string | null {
  let str: string;
  if (typeof value === 'string') str = value;
  else if (typeof value === 'number' || typeof value === 'boolean') str = String(value);
  else return null;
  const trimmed = str.trim();
  return trimmed ? trimmed.slice(0, 2000) : null;
}

/**
 * Build the ordered, pre-labeled answer list for one booking row: walk the
 * service's questions IN ARRAY ORDER (current label), then append any answer
 * keyed by a now-deleted/unknown question id sorted by key (deterministic) with
 * the raw id as label. A malformed/non-array `questions` degrades to "no
 * questions" (all answers fall through to the deleted branch); a non-object
 * stored value reads as no answers. Returns null when nothing displays.
 */
export function buildIntakeAnswers(
  questions: IntakeQuestion[] | null | undefined,
  stored: unknown
): Array<{ label: string; answer: string }> | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const answers = stored as Record<string, unknown>;
  const qs = Array.isArray(questions) ? questions : [];
  const out: Array<{ label: string; answer: string }> = [];
  const usedKeys = new Set<string>();
  for (const q of qs) {
    // Skip malformed question entries (non-string id/label from legacy/hand-edited
    // jsonb) WITHOUT marking the id used — a stored answer then falls through to the
    // raw-id branch below (preserved, never dropped; a non-string label can't reach React).
    if (!q || typeof q.id !== 'string' || typeof q.label !== 'string' || !(q.id in answers)) continue;
    const answer = coerceAnswer(answers[q.id]);
    if (answer === null) continue;
    out.push({ label: q.label, answer });
    usedKeys.add(q.id);
  }
  // Deleted/unknown question ids: append sorted by key (jsonb key order isn't guaranteed).
  for (const key of Object.keys(answers).sort()) {
    if (usedKeys.has(key)) continue;
    const answer = coerceAnswer(answers[key]);
    if (answer === null) continue;
    out.push({ label: key, answer });
  }
  return out.length ? out : null;
}
