import { z } from 'zod';

/**
 * Strict full-replace schema for `PUT /bots/:id/ai-settings`.
 *
 * Unlike the legacy partial-patch `updateAiSettingsSchema`, this requires the
 * complete editable AI shape and uses `.strict()` at every object level so the
 * out-of-scope secrets/keys this slice must NOT accept — `apiKey`, `provider`,
 * `model` — are rejected with an error rather than silently dropped. The handler
 * carries `provider`/`model` forward from the existing row.
 *
 * Field-level constraints mirror `updateAiSettingsSchema` exactly (lengths,
 * email format, array caps, numeric bounds); only the envelope is new.
 */
export const putBotAiSettingsSchema = z
  .object({
    enabled: z.boolean(),
    // Required key, but accepts null / empty string (saved as null) — matches today.
    supportEmail: z.string().email().max(200).nullable().or(z.literal('')),
    brandVoice: z
      .object({
        name: z.string().min(1).max(100),
        tone: z.string().min(1).max(50),
        customInstructions: z.string().max(10000),
        // Optional per-bot commercial name. Empty/absent → inherits the tenant
        // business name at prompt-composition time (not persisted as a copy).
        businessName: z.string().max(100).optional(),
        // @deprecated Legacy client-side starter-snippet id. The authoritative
        // template binding now lives on Bot.template_id / Bot.template_version
        // (set via PUT /bots/:id/template). Accepted-but-ignored for backward
        // compatibility during the portal transition (T18); the write path
        // strips it and never persists it.
        templateId: z.string().max(100).nullable().optional(),
      })
      .strict(),
    guardrails: z
      .object({
        topicsToAvoid: z.array(z.string()).max(50),
        escalationKeywords: z.array(z.string()).max(100),
        confidenceThreshold: z.number().min(0).max(1),
        maxResponseLength: z.number().min(50).max(5000),
        greetingMessage: z.string().max(1000),
        fallbackMessage: z.string().max(1000),
        offHoursMessage: z.string().max(1000),
      })
      .strict(),
  })
  .strict();

export type PutBotAiSettingsInput = z.infer<typeof putBotAiSettingsSchema>;
