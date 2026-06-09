// @axentrio/api-client — shared HTTP client + react-query keys for mobile
// (reusable by the portal). Skeleton: the axios instance, Bearer-token
// interceptor, and react-query hook factories are implemented in the auth
// tracer-bullet slice (#25). For now this only fixes the shared contract for
// how a Clerk session token is supplied to the client.

/** Supplies a fresh Clerk session JWT for the Authorization header. */
export type TokenProvider = () => Promise<string | null>;

/** Stable react-query cache keys, shared so screens never hand-roll keys. */
export const queryKeys = {
  authMe: ['auth', 'me'] as const,
};
