import { z } from 'zod';

/**
 * Tenant-facing bot↔template binding (PUT /bots/:id/template).
 * The authoritative binding (Bot.template_id / Bot.template_version), replacing
 * the legacy client-side brandVoice.templateId (.scratch/plan-bot-templates.md T18).
 */
export const putBotTemplateBindingSchema = z
  .object({
    templateId: z.string().uuid(),
    // 'latest' (follow new publishes) or a stringified positive integer pin.
    templateVersion: z
      .string()
      .max(20)
      .refine((v) => v === 'latest' || /^[1-9]\d*$/.test(v), {
        message: 'templateVersion must be "latest" or a positive integer',
      }),
  })
  .strict();

export type PutBotTemplateBindingInput = z.infer<typeof putBotTemplateBindingSchema>;
