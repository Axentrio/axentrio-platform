/**
 * Billing routes — exposed under `/api/v1/billing`.
 *
 * Plan: .scratch/plan-billing.md § Implementation outline step 9.
 *
 * Endpoint surface:
 *   GET  /state                       → billing snapshot for the Billing page
 *   POST /checkout-session            → start Stripe Checkout
 *   POST /portal-session              → open Stripe Customer Portal
 *   POST /change-plan                 → upgrade / downgrade
 *   POST /cancel                      → cancel at period end
 *   POST /undo-cancel                 → undo a pending cancel
 *   POST /undo-pending-change         → release a pending downgrade
 *   PUT  /email                       → update billing email
 *
 * All routes:
 *   - require Clerk auth + autoProvision,
 *   - require role ∈ {'admin', 'super_admin'},
 *   - operate on `req.tenantId` (super-admin tenant-switch via the existing
 *     X-Tenant-Context header lives in admin.routes — billing routes act on
 *     the authenticated tenant context).
 *
 * Error translation:
 *   BillingProviderError → ApiError with `code` preserved as the lowercase
 *   billing error code (e.g. `no_stripe_subscription`) and an HTTP status
 *   derived from the mapping table below. The global error handler renders
 *   `{ success: false, error: { code, message, details } }` — so callers
 *   see `error.code = 'no_stripe_subscription'` exactly as the plan spec
 *   says, with HTTP 400.
 */

import { NextFunction, Request, Response, Router } from 'express';
import { ApiError, asyncHandler } from '../middleware/error-handler';
import { autoProvision, requireClerkAuth } from '../middleware/clerk.middleware';
import { validate } from '../middleware/validate';
import { sendSuccess } from '../utils/response';
import { logger } from '../utils/logger';
import {
  changePlanSchema,
  portalSessionSchema,
  startCheckoutSchema,
  updateBillingEmailSchema,
} from '../schemas/billing.schema';
import {
  cancelAtPeriodEnd,
  CheckoutablePlanId,
  changePlan,
  getBillingState,
  openCustomerPortal,
  startCheckout,
  undoCancel,
  undoPendingChange,
  updateBillingEmail,
} from '../billing/service';
import { BillingProviderError } from '../billing/types';

const router = Router();

/**
 * Role gate. Billing actions are owner-level — neither `agent` nor
 * `supervisor` can act on subscription state. Returns 403 with the standard
 * envelope (`error.code = 'FORBIDDEN'`).
 */
function requireBillingAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'super_admin') {
    res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Admin access required' },
    });
    return;
  }
  next();
}

router.use(requireClerkAuth, autoProvision, requireBillingAdmin);

/**
 * Map service-layer `BillingProviderError.code` → HTTP status. Codes outside
 * the table fall through to 500 (a genuine unexpected provider failure).
 *
 * Conflict (409) is used for two cases where the client *can* recover by
 * looking at fresh state — there's an existing subscription, or a pending
 * change is already in flight. Everything else is 400 (precondition not
 * met, bad input).
 */
const BILLING_ERROR_STATUS: Record<string, number> = {
  no_stripe_subscription: 400,
  no_active_account: 400,
  past_due_block: 400,
  checkout_plan_invalid: 400,
  billing_email_unresolvable: 400,
  no_op_plan_change: 400,
  no_pending_change: 400,
  subscription_shape_unexpected: 400,
  subscription_exists: 409,
  pending_change_exists: 409,
};

function billingErrorToApiError(err: BillingProviderError): ApiError {
  const status = BILLING_ERROR_STATUS[err.code] ?? 500;
  return new ApiError(err.message, status, err.code, {
    providerName: err.providerName,
    ...(err.meta ?? {}),
  });
}

async function callBillingService<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof BillingProviderError) {
      throw billingErrorToApiError(err);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get(
  '/state',
  asyncHandler(async (req: Request, res: Response) => {
    const state = await getBillingState(req.tenantId!);
    sendSuccess(res, state);
  }),
);

router.post(
  '/checkout-session',
  validate(startCheckoutSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { planId, successUrl, cancelUrl } = req.body as {
      planId: CheckoutablePlanId;
      successUrl: string;
      cancelUrl: string;
    };
    const result = await callBillingService(() =>
      startCheckout(req.tenantId!, planId, { successUrl, cancelUrl }),
    );
    logger.info('Billing: checkout session created', {
      tenantId: req.tenantId,
      planId,
      actorId: req.userId,
    });
    sendSuccess(res, result);
  }),
);

router.post(
  '/portal-session',
  validate(portalSessionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { returnUrl } = req.body as { returnUrl: string };
    const result = await callBillingService(() =>
      openCustomerPortal(req.tenantId!, returnUrl),
    );
    sendSuccess(res, result);
  }),
);

router.post(
  '/change-plan',
  validate(changePlanSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { planId } = req.body as { planId: CheckoutablePlanId };
    await callBillingService(() => changePlan(req.tenantId!, planId));
    logger.info('Billing: change plan requested', {
      tenantId: req.tenantId,
      planId,
      actorId: req.userId,
    });
    // Stripe-driven op — local state updates when the webhook arrives. UI
    // polls /state for the visible change. Returning `{ queued: true }`
    // signals "accepted, watch for the webhook-driven update."
    sendSuccess(res, { queued: true });
  }),
);

router.post(
  '/cancel',
  asyncHandler(async (req: Request, res: Response) => {
    await callBillingService(() => cancelAtPeriodEnd(req.tenantId!));
    logger.info('Billing: cancel-at-period-end requested', {
      tenantId: req.tenantId,
      actorId: req.userId,
    });
    sendSuccess(res, { queued: true });
  }),
);

router.post(
  '/undo-cancel',
  asyncHandler(async (req: Request, res: Response) => {
    await callBillingService(() => undoCancel(req.tenantId!));
    logger.info('Billing: undo cancel requested', {
      tenantId: req.tenantId,
      actorId: req.userId,
    });
    sendSuccess(res, { queued: true });
  }),
);

router.post(
  '/undo-pending-change',
  asyncHandler(async (req: Request, res: Response) => {
    await callBillingService(() => undoPendingChange(req.tenantId!));
    logger.info('Billing: undo pending change requested', {
      tenantId: req.tenantId,
      actorId: req.userId,
    });
    sendSuccess(res, { queued: true });
  }),
);

router.put(
  '/email',
  validate(updateBillingEmailSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.body as { email: string };
    const result = await callBillingService(() =>
      updateBillingEmail(req.tenantId!, email),
    );
    logger.info('Billing: email updated', {
      tenantId: req.tenantId,
      actorId: req.userId,
      changed: result.changed,
    });
    sendSuccess(res, result);
  }),
);

export default router;
