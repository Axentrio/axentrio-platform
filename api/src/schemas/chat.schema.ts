import { z } from 'zod';
import { MAX_MESSAGE_CONTENT_CHARS } from '../guardrails/classify';

export const sendMessageSchema = z.object({
  // Hard ingress cap (== guardrails scan window): bounds CPU and closes the
  // "benign prefix + payload" classifier evasion — a stored message can never
  // exceed the scan window. Channel ingress (WhatsApp/Telegram/Meta) is already
  // platform-capped well below this.
  content: z.string().min(1, 'Message content is required').max(MAX_MESSAGE_CONTENT_CHARS, 'Message too long'),
  type: z.enum(['text', 'image', 'file', 'system']).default('text'),
  metadata: z.record(z.unknown()).optional(),
});

export const chatListQuerySchema = z.object({
  status: z.enum(['active', 'closed', 'waiting', 'handoff', 'bot']).optional(),
  // Filter to guardrail-paused conversations (AI auto-reply disabled by a guardrail).
  // Only 'true' is meaningful (it filters); absent = no filter.
  aiPaused: z.literal('true').optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});
