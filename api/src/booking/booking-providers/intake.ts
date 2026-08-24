/**
 * P3/P5a intake-answer normalization and the required-question gate — the
 * single place LLM-supplied answers are sanitized and gated before persistence.
 */
import { ServiceType } from '../../database/entities/ServiceType';
import { BookingError } from './types';

/**
 * P3: normalize an LLM-supplied intake-answers object against a RESOLVED service's
 * questions — the single place answers are sanitized before persistence. Keeps only
 * entries whose key matches a current question id, coerces the value to a trimmed
 * non-empty string (string→trim; number/boolean→String; null/undefined/array/object
 * dropped — never `"[object Object]"`), caps at 2000 chars. Returns a flat
 * `{ id: string }` map or `null` if nothing remains. A malformed/non-array
 * `intakeQuestions` (legacy/hand-edited) degrades to "no questions" → null.
 */
export function normalizeIntakeAnswers(service: ServiceType, raw: unknown): Record<string, string> | null {
  const questions = Array.isArray(service.intakeQuestions) ? service.intakeQuestions : [];
  if (!questions.length) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const validIds = new Set(
    questions.map((q) => q?.id).filter((id): id is string => typeof id === 'string')
  );
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!validIds.has(key)) continue;
    let str: string;
    if (typeof value === 'string') str = value;
    else if (typeof value === 'number' || typeof value === 'boolean') str = String(value);
    else if (Array.isArray(value)) {
      // An ARRAY is what a multi-answer looks like, and dropping it silently lost the
      // customer's answer entirely — the owner saw a question with no reply rather than
      // one with several. Flattened to a readable list; the scalar members are kept and
      // anything nested is discarded rather than rendered as "[object Object]".
      const parts = value
        .filter((v): v is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof v))
        .map((v) => String(v).trim())
        .filter(Boolean);
      if (!parts.length) continue;
      str = parts.join(', ');
    } else continue; // null/undefined/object → dropped
    const trimmed = str.trim();
    if (!trimmed) continue;
    out[key] = trimmed.slice(0, 2000);
  }
  return Object.keys(out).length ? out : null;
}


/**
 * P5a — server-side gate for REQUIRED intake questions, mirroring the
 * ADDRESS_REQUIRED / PHONE_REQUIRED contact gate. The LLM is told to ask them, but
 * a model slip must not silently persist a booking missing a required answer.
 * `normalized` is the output of normalizeIntakeAnswers (keyed by question id).
 * Recoverable (INTAKE_REQUIRED, 400): the agent re-asks and re-calls the tool.
 */
export function assertRequiredIntake(service: ServiceType, normalized: Record<string, string> | null): void {
  const questions = Array.isArray(service.intakeQuestions) ? service.intakeQuestions : [];
  // `active !== false` is load-bearing, not defensive. A paused question is removed from the
  // prompt, so the bot never asks it — but this gate demanded an answer anyway, which
  // deadlocked EVERY booking for that service: the model cannot supply an answer to a
  // question it was never shown, and the error names a label it has no other knowledge of.
  // Pausing a required question must switch the requirement off with it.
  const required = questions.filter(
    (q) => q && q.required && q.active !== false && typeof q.id === 'string'
  );
  if (!required.length) return;
  const answers = normalized ?? {};
  const missing = required.filter((q) => !String(answers[q.id] ?? '').trim());
  if (missing.length) {
    throw new BookingError(
      `Please provide the required intake answer(s): ${missing.map((q) => q.label).join(', ')}`,
      'INTAKE_REQUIRED',
      400
    );
  }
}
