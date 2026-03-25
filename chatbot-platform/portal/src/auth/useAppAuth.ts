/**
 * useAppAuth - Clerk-based authentication hook
 * Wraps Clerk hooks into the interface the rest of the app expects.
 */
import { useState, useEffect, useCallback } from 'react';
import { useUser, useAuth, useOrganization } from '@clerk/clerk-react';
import type { User, UserRole } from '@app-types/index';
import { API_CONFIG, ENDPOINTS } from '@config/api.config';

// Map Clerk org role to app role
function mapClerkRole(clerkRole?: string): UserRole {
  if (clerkRole === 'org:admin') return 'admin';
  if (clerkRole === 'org:supervisor') return 'supervisor';
  return 'agent';
}

// Permission map
const rolePermissions: Record<string, string[]> = {
  admin: ['*'],
  supervisor: [
    'view:tenant_chats',
    'view:agents',
    'view:analytics',
    'takeover:tenant_chat',
    'assign:chats',
  ],
  agent: [
    'view:assigned_chats',
    'takeover:assigned_chat',
    'send:messages',
    'view:own_analytics',
  ],
};

function checkPermission(role: UserRole, permission: string): boolean {
  if (role === 'admin') return true;
  return rolePermissions[role]?.includes(permission) || false;
}

// DB IDs fetched from /auth/me
interface DbIds {
  agentId: string;
  tenantId: string;
  role: UserRole;
  tenantName: string;
  email: string;
}

export function useAppAuth() {
  const { user: clerkUser, isLoaded: userLoaded } = useUser();
  const { isSignedIn, getToken, orgRole } = useAuth();
  const { organization, isLoaded: orgLoaded } = useOrganization();

  const [dbIds, setDbIds] = useState<DbIds | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isAuthenticated = !!isSignedIn && !!organization;

  // Fetch DB IDs from /auth/me when authenticated with org
  useEffect(() => {
    if (!isSignedIn || !organization) {
      setDbIds(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchMe() {
      try {
        setIsLoading(true);
        setError(null);
        const token = await getToken();
        const res = await fetch(`${API_CONFIG.baseURL}${ENDPOINTS.auth.me}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });

        if (!res.ok) throw new Error(`Failed to fetch user info: ${res.status}`);

        const data = await res.json();
        if (!cancelled) {
          setDbIds({
            agentId: data.agentId,
            tenantId: data.tenantId,
            role: data.role as UserRole,
            tenantName: data.tenantName,
            email: data.email,
          });
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || 'Failed to load user data');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    fetchMe();
    return () => { cancelled = true; };
  }, [isSignedIn, organization?.id, getToken]);

  // Build the User object the app expects
  const user: User | null = clerkUser && dbIds ? {
    id: dbIds.agentId,
    email: dbIds.email || clerkUser.emailAddresses?.[0]?.emailAddress || '',
    firstName: clerkUser.firstName || '',
    lastName: clerkUser.lastName || '',
    role: dbIds.role || mapClerkRole(orgRole ?? undefined),
    status: 'online',
    tenantId: dbIds.tenantId,
    createdAt: clerkUser.createdAt?.toISOString() || new Date().toISOString(),
    updatedAt: clerkUser.updatedAt?.toISOString() || new Date().toISOString(),
    preferences: {
      theme: 'system',
      notifications: { sound: true, desktop: true, handsoffOnly: false },
      language: 'en',
    },
  } : null;

  const hasPermission = useCallback((permission: string): boolean => {
    if (!user) return false;
    return checkPermission(user.role, permission);
  }, [user]);

  const isRole = useCallback((role: UserRole | UserRole[]): boolean => {
    if (!user) return false;
    if (Array.isArray(role)) return role.includes(user.role);
    return user.role === role;
  }, [user]);

  return {
    user,
    isAuthenticated,
    isLoading: isLoading || !userLoaded || !orgLoaded,
    error,
    hasPermission,
    isRole,
    getToken,
    agentId: dbIds?.agentId || null,
    tenantId: dbIds?.tenantId || null,
    tenantName: dbIds?.tenantName || null,
  };
}

// Re-exports for convenience
export { useUser, useAuth } from '@clerk/clerk-react';
export { useAppAuth as useAuthStore } from './useAppAuth';
