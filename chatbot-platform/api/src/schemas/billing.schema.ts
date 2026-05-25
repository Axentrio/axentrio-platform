/**
 * Billing route input validation schemas.
 *
 * Plan: .scratch/plan-billing.md § Implementation outline step 9.
 *
 * `planId` is gated to the self-serve set ('essential' | 'pro') here so the
 * route layer rejects 'free' / 'enterprise' before the service even runs.
 * 'free' is the internal-only cancellation sink; 'enterprise' is sales-led
 * per the M0 epic. The service has a defensive runtime check too — both
 * layers because route handlers also accept HTTP clients that bypass the schema.
 */

import { z } from 'zod';

export const startCheckoutSchema = z.object({
  planId: z.enum(['essential', 'pro']),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

export const portalSessionSchema = z.object({
  returnUrl: z.string().url(),
});

export const changePlanSchema = z.object({
  planId: z.enum(['essential', 'pro']),
});

export const updateBillingEmailSchema = z.object({
  email: z.string().email(),
});

/**
 * VAT ID update schema — see plan PR5.
 *
 * v1 is EU-only (post-Brexit: GB is explicitly rejected per the M0
 * acceptance criterion). The regex is permissive enough to allow valid
 * EU VAT IDs that include letters after the country code (e.g. Spanish
 * `ESA12345674`, Irish `IE1234567T`) — Stripe Tax does canonical VIES
 * validation downstream. `null` and `''` both mean "clear the VAT ID".
 *
 * The `.refine` blocks `GB`-prefixed IDs at the schema layer so the
 * rejection is uniform across every entry point.
 */
export const updateVatIdSchema = z.object({
  vatId: z.union([
    z
      .string()
      .regex(/^[A-Z]{2}[A-Z0-9]{2,12}$/)
      .refine((v) => !v.startsWith('GB'), {
        message: 'UK VAT IDs are not supported — VIES validation is EU-only in v1',
      }),
    z.null(),
    z.literal(''),
  ]),
});
