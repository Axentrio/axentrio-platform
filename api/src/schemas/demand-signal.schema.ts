import { z } from 'zod';

/**
 * Closed allow-list of "Coming Soon" features that may emit demand signals.
 *
 * The DB column is `varchar(64)` (open) — this allow-list is the boundary
 * gate. New features land here + a deploy, not via raw client strings.
 * Plan reference: `.scratch/plan-m0-foundation-reshape.md` § PR11.
 */
const ALLOWED_FEATURES = [
  'tiktok',
  'crm_native',
  'ai_lead_intelligence',
  'ai_business_insights',
  'calendar_google',
  'calendar_outlook',
] as const;

export type DemandSignalFeature = (typeof ALLOWED_FEATURES)[number];

export const notifyMeSchema = z.object({
  feature: z.enum(ALLOWED_FEATURES),
  context: z
    .record(z.unknown())
    .refine((obj) => JSON.stringify(obj).length <= 2048, {
      message: 'context must serialize to ≤ 2 KiB JSON',
    })
    .optional()
    .default({}),
});

export type NotifyMeInput = z.infer<typeof notifyMeSchema>;
