import { z } from 'zod';

/**
 * Tenant-facing bot↔template binding (PUT /bots/:id/template).
 *
 * A bot binds UP TO 3 templates (ordered; [0]=primary), combined by `mode`:
 * 'or' = independent specialities the AI self-selects per question; 'and' = one
 * combined offering. Authoritative binding lives on Bot.templateBindings, with
 * template_id/template_version mirrored to the primary for back-compat.
 *
 * Back-compat: the legacy single-binding shape ({templateId, templateVersion}) is
 * still accepted and normalized to a 1-element bindings list.
 */
const versionSchema = z
  .string()
  .max(20)
  .refine((v) => v === 'latest' || /^[1-9]\d*$/.test(v), {
    message: 'version must be "latest" or a positive integer',
  });

const bindingSchema = z
  .object({
    templateId: z.string().uuid(),
    version: versionSchema,
  })
  .strict();

export const putBotTemplateBindingSchema = z
  .object({
    bindings: z.array(bindingSchema).min(1).max(3).optional(),
    mode: z.enum(['and', 'or']).optional(),
    // Legacy single-binding fields (normalized below when `bindings` is absent).
    templateId: z.string().uuid().optional(),
    templateVersion: versionSchema.optional(),
  })
  .strict()
  .refine((v) => (v.bindings && v.bindings.length > 0) || !!v.templateId, {
    message: 'Provide either bindings[] or templateId',
  })
  // No duplicate template ids in a binding set.
  .refine((v) => {
    const ids = (v.bindings ?? []).map((b) => b.templateId);
    return ids.length === new Set(ids).size;
  }, { message: 'A template cannot be bound more than once' });

export type PutBotTemplateBindingInput = z.infer<typeof putBotTemplateBindingSchema>;
