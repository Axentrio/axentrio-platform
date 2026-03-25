/**
 * useAppAuth - reads auth state from AppAuthProvider context.
 * The actual /auth/me fetch happens once in AppAuthProvider.
 */
import { useContext } from 'react';
import { AppAuthContext } from './AppAuthProvider';
import type { AppAuthContextValue } from './AppAuthProvider';

export function useAppAuth(): AppAuthContextValue {
  const ctx = useContext(AppAuthContext);
  if (!ctx) {
    throw new Error('useAppAuth must be used within an AppAuthProvider');
  }
  return ctx;
}

// Re-exports for convenience
export { useUser, useAuth } from '@clerk/clerk-react';
export { useAppAuth as useAuthStore } from './useAppAuth';
