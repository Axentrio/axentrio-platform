/**
 * Keep the path the user asked for after Clerk sign-in.
 * SignIn sits outside BrowserRouter, so we read window.location.
 */
export function afterAuthRedirectPath(location: {
  pathname: string;
  search?: string;
  hash?: string;
}): string {
  const path = location.pathname || '/';
  if (!path.startsWith('/') || path.startsWith('//')) return '/';
  return `${path}${location.search ?? ''}${location.hash ?? ''}`;
}
