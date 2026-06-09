// Public runtime config. Only EXPO_PUBLIC_* vars are inlined into the bundle —
// never put secrets here. Set these in mobile/.env (see .env.example).
const apiBaseUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4081';

export const env = {
  apiBaseUrl,
  /** Versioned REST base, e.g. http://localhost:4081/api/v1 */
  apiUrl: `${apiBaseUrl}/api/v1`,
  /** Socket.IO origin (defaults to the API origin). */
  wsUrl: process.env.EXPO_PUBLIC_WS_URL ?? apiBaseUrl,
  clerkPublishableKey: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '',
};
