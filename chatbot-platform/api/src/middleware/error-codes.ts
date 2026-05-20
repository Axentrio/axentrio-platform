/**
 * Machine-readable error codes used by the global error handler and route
 * modules that throw `ApiError(...)` with a custom code.
 *
 * Source: chatbot-platform/docs/api-response-standardization-plan.md §2.1, §4
 * (Phase 0). Keep this file free of runtime dependencies — it is imported by
 * middleware that is exercised on every request.
 *
 * Two groups:
 *   1. Platform codes (auth/tenant/file/quota/etc.) — used by middleware and
 *      route modules being migrated in Phases 2+.
 *   2. Billing provider codes + their HTTP status map — the single source of
 *      truth for `BillingProviderError.code` → HTTP status used by
 *      `routes/billing.routes.ts`.
 */

// ---------------------------------------------------------------------------
// Platform codes
// ---------------------------------------------------------------------------

export const ERROR_CODES = {
  CLERK_UPSTREAM_FAILED: 'CLERK_UPSTREAM_FAILED',
  PROVISIONING_FAILED: 'PROVISIONING_FAILED',
  FILE_SERVICE_UNAVAILABLE: 'FILE_SERVICE_UNAVAILABLE',
  UPSTREAM_FAILED: 'UPSTREAM_FAILED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  RATE_LIMIT_FALLBACK: 'RATE_LIMIT_FALLBACK',
  FILE_VALIDATION_FAILED: 'FILE_VALIDATION_FAILED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ---------------------------------------------------------------------------
// Billing provider codes + HTTP status map
// ---------------------------------------------------------------------------
//
// The code strings + the 400/409 status mapping are co-located here so
// callers throwing `new ApiError(msg, status, code)` and the
// `BillingProviderError` → `ApiError` adapter in `routes/billing.routes.ts`
// share a single source of truth.
//
// Conflict (409) is used for two cases where the client *can* recover by
// looking at fresh state — there's an existing subscription, or a pending
// change is already in flight. Everything else is 400 (precondition not
// met, bad input). Codes outside this table fall through to 500 (a genuine
// unexpected provider failure).

export const BILLING_ERROR_CODES = {
  NO_STRIPE_SUBSCRIPTION: 'no_stripe_subscription',
  NO_ACTIVE_ACCOUNT: 'no_active_account',
  PAST_DUE_BLOCK: 'past_due_block',
  CHECKOUT_PLAN_INVALID: 'checkout_plan_invalid',
  BILLING_EMAIL_UNRESOLVABLE: 'billing_email_unresolvable',
  NO_OP_PLAN_CHANGE: 'no_op_plan_change',
  NO_PENDING_CHANGE: 'no_pending_change',
  SUBSCRIPTION_SHAPE_UNEXPECTED: 'subscription_shape_unexpected',
  SUBSCRIPTION_EXISTS: 'subscription_exists',
  PENDING_CHANGE_EXISTS: 'pending_change_exists',
} as const;

export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[keyof typeof BILLING_ERROR_CODES];

export const BILLING_ERROR_STATUS: Record<BillingErrorCode, number> = {
  [BILLING_ERROR_CODES.NO_STRIPE_SUBSCRIPTION]: 400,
  [BILLING_ERROR_CODES.NO_ACTIVE_ACCOUNT]: 400,
  [BILLING_ERROR_CODES.PAST_DUE_BLOCK]: 400,
  [BILLING_ERROR_CODES.CHECKOUT_PLAN_INVALID]: 400,
  [BILLING_ERROR_CODES.BILLING_EMAIL_UNRESOLVABLE]: 400,
  [BILLING_ERROR_CODES.NO_OP_PLAN_CHANGE]: 400,
  [BILLING_ERROR_CODES.NO_PENDING_CHANGE]: 400,
  [BILLING_ERROR_CODES.SUBSCRIPTION_SHAPE_UNEXPECTED]: 400,
  [BILLING_ERROR_CODES.SUBSCRIPTION_EXISTS]: 409,
  [BILLING_ERROR_CODES.PENDING_CHANGE_EXISTS]: 409,
};
