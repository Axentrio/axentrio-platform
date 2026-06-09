// @axentrio/contracts — shared DTOs across the portal, API consumers, and mobile.
// Skeleton: concrete request/response shapes are extracted per feature slice
// (auth #25, inbox #26, ...) as those endpoints are wired on mobile.

/** Operator roles, mirrored from the API's RBAC. */
export type OperatorRole = 'admin' | 'supervisor' | 'agent' | 'super_admin';
