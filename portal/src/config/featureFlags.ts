/**
 * Client feature flags.
 *
 * The portal has no central flag service — flags are simple `VITE_*` env reads
 * (see api.config.ts / sentry.ts). This follows that convention: each flag reads
 * its `VITE_*` var, defaulting to `import.meta.env.DEV` so it is ON in local/dev
 * (vite dev server) and OFF in prod builds unless the env var explicitly enables
 * it.
 *
 * To force a flag in any environment, set the env var to the string 'true' /
 * 'false' (e.g. VITE_FEATURE_CAPABILITY_READINESS=true in a Railway/Netlify env).
 */

/** Parse a `VITE_*` flag value, falling back to `dev` (DEV-default = ON locally). */
function flag(value: string | undefined, devDefault: boolean): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return devDefault;
}

/**
 * Capability-readiness MVP (change 7) — booking readiness card + "not live yet"
 * banner on the Bookings Setup tab. ON in local/dev by default; gate via
 * VITE_FEATURE_CAPABILITY_READINESS in deployed environments.
 */
export const CAPABILITY_READINESS_ENABLED = flag(
  import.meta.env.VITE_FEATURE_CAPABILITY_READINESS,
  import.meta.env.DEV,
);
