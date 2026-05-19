import { z } from 'zod';

export const SUPPORTED_LOCALES = ['en', 'nl', 'fr'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  avatar: z.string().url().optional(),
  locale: z.enum(SUPPORTED_LOCALES).optional(),
});
