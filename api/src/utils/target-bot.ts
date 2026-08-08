/**
 * Which Agent an admin request is about.
 *
 * ONE READER, shared by the scheduler and both calendar controllers, because #86 exists
 * precisely because "which Agent is this?" was answered differently in different places. Three
 * copies of this would be the same bug in a new form.
 *
 * OMITTED, EMPTY AND MALFORMED ARE THREE DIFFERENT ANSWERS:
 *
 * - **Omitted** means the tenant's anchor. That is what keeps a single-Agent tenant untouched —
 *   their portal sends no id and every byte of behaviour is what it was.
 * - **Malformed** is the caller's mistake and gets a 400 here, rather than travelling on to
 *   become a confusing 404 about an Agent that could never have existed.
 * - **Well-formed but unknown** is not this function's business. `resolveTargetBot` answers that
 *   with a 404, because "no such Agent in your tenant" is a refusal rather than a validation
 *   error — and it must not leak whether the id exists in some OTHER tenant.
 */
import { z } from 'zod';
import type { Request } from 'express';
import { ApiError } from '../middleware/error-handler';

export function targetBotId(req: Request): string | undefined {
  // Optional read: `req.query` is always present in Express, and treating its absence as "no
  // parameter" is the honest answer rather than a crash.
  const raw = req.query?.botId;
  if (raw === undefined || raw === '') return undefined;
  const parsed = z.string().uuid().safeParse(raw);
  if (!parsed.success) throw new ApiError('botId must be a UUID', 400, 'INVALID_BOT_ID');
  return parsed.data;
}
