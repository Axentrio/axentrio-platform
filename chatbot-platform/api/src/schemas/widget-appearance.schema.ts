import { z } from 'zod';

export const updateWidgetAppearanceSchema = z.object({
  // primaryColor: required to be a valid 6-digit hex when present.
  // Cannot be cleared via '' or null — omit the field to leave it unchanged.
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'primaryColor must be a 6-digit hex like #6366f1')
    .optional(),
  avatarUrl: z
    .string()
    .url()
    .max(2048)
    .optional()
    .nullable()
    .or(z.literal('')),
  launcherPosition: z.enum(['bottom-right', 'bottom-left']).optional(),
  launcherLabel: z
    .string()
    .max(30)
    .optional()
    .nullable()
    .or(z.literal('')),
});

export type UpdateWidgetAppearanceInput = z.infer<typeof updateWidgetAppearanceSchema>;
