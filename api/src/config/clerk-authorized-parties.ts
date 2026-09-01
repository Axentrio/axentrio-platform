/**
 * Parse CLERK_AUTHORIZED_PARTIES and the options object for clerkMiddleware.
 * An empty list means do not pass authorizedParties (dev/prod today).
 */
export function parseClerkAuthorizedParties(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function clerkMiddlewareOptions(
  parties: string[],
): { authorizedParties: string[] } | undefined {
  if (parties.length === 0) {
    return undefined;
  }
  return { authorizedParties: parties };
}
