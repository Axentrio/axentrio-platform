import { z } from 'zod';

export const updateIntegrationsSchema = z.object({
  calcom: z.object({
    apiKey: z.string().min(1).optional().nullable(),
    eventTypeId: z.number().int().positive().optional(),
    collectFields: z.array(z.string()).min(1).max(10).default(['name', 'email']),
    language: z.enum(['en', 'nl', 'fr', 'de']).default('en'),
  }).optional().nullable(),
});

export type UpdateIntegrationsInput = z.infer<typeof updateIntegrationsSchema>;
