import { z } from 'zod';

/**
 * Publishing an answer to a Gap. The first validated body on the insights router.
 *
 * The lower bound stops a one-word answer becoming a customer-facing document. The upper
 * bound is a guard, not a target: the text is indexed verbatim, and one focused paragraph
 * retrieves better than an essay.
 */
export const answerGapSchema = z.object({
  answer: z.string().trim().min(20).max(5000),
});
