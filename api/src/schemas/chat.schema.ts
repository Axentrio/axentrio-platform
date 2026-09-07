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

export const renameChatSchema = z.object({
  userName: z
    .string()
    .trim()
    .transform((s) => s.replace(/[\p{Cc}\p{Cf}]/gu, ''))
    .pipe(z.string().min(1, 'Name is required').max(100)),
});

const tagString = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\p{Cc}\p{Cf}]/gu, '').trim())
  .pipe(z.string().min(1, 'Tag is required').max(100));

export const updateChatTagsSchema = z.object({
  tags: z
    .array(tagString)
    .max(20)
    .transform((tags) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const tag of tags) {
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
      }
      return out;
    }),
});

export const chatListQuerySchema = z.object({
  status: z.enum(['active', 'closed', 'waiting', 'handoff', 'bot']).optional(),
  // Filter to guardrail-paused conversations (AI auto-reply disabled by a guardrail).
  // Only 'true' is meaningful (it filters); absent = no filter.
  aiPaused: z.literal('true').optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});
