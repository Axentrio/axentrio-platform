/**
 * Billing route input validation schemas.
 *
 * Plan: .scratch/plan-billing.md § Implementation outline step 9.
 *
 * `planId` is gated to the self-serve set ('pro' | 'premium') here so the
 * route layer rejects 'free' / 'enterprise' before the service even runs.
 * The service has a defensive runtime check too — both layers because
 * route handlers also accept HTTP clients that bypass the schema.
 */

import { z } from 'zod';

export const startCheckoutSchema = z.object({
  planId: z.enum(['pro', 'premium']),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

export const portalSessionSchema = z.object({
  returnUrl: z.string().url(),
});

export const changePlanSchema = z.object({
  planId: z.enum(['pro', 'premium']),
});

export const updateBillingEmailSchema = z.object({
  email: z.string().email(),
});
