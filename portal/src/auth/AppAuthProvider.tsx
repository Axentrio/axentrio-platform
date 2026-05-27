/**
 * AppAuthProvider - Fetches /auth/me once and shares via context.
 * Wrap this around the authenticated part of the app so every
 * useAppAuth() consumer reads from the same cached result.
 */
import React, { createContext, useState, useEffect, useCallback } from 'react';
import { useUser, useAuth, useOrganization } from '@clerk/clerk-react';
import type { User, UserRole } from '@app-types/index';
import { API_CONFIG, ENDPOINTS } from '@config/api.config';
import { setTokenProvider } from '@services/apiClient';
import { useTenantContextStore } from '../stores/tenantContextStore';
import i18n, { isSupportedLocale } from '../i18n';

// Map Clerk org role to app role
function mapClerkRole(clerkRole?: string): UserRole {
  if (clerkRole === 'org:admin') return 'admin';
  if (clerkRole === 'org:supervisor') return 'supervisor';
  return 'agent';
}

// Permission map
const rolePermissions: Record<string, string[]> = {
  super_admin: ['*'],
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
  if (role === 'admin' || role === 'super_admin') return true;
  return rolePermissions[role]?.includes(permission) || false;
}

interface DbIds {
  agentId: string;
  tenantId: string;
  role: UserRole;
  tenantName: string;
  email: string;
}

export interface AppAuthContextValue {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  hasPermission: (permission: string) => boolean;
  isRole: (role: UserRole | UserRole[]) => boolean;
  getToken: () => Promise<string | null>;
  agentId: string | null;
  tenantId: string | null;
  tenantName: string | null;
}

export const AppAuthContext = createContext<AppAuthContextValue | null>(null);

export const AppAuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user: clerkUser, isLoaded: userLoaded } = useUser();
  const { isSignedIn, getToken, orgRole } = useAuth();
  const { organization, isLoaded: orgLoaded } = useOrganization();

  const [dbIds, setDbIds] = useState<DbIds | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isAuthenticated = !!isSignedIn && !!organization;

  // Wire Clerk token to API client
  useEffect(() => { setTokenProvider(getToken); }, [getToken]);

  // Fetch DB IDs from /auth/me once when authenticated with org
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

        const json = await res.json();
        // API returns { success, data: { ... } } envelope
        const data = json.data ?? json;
        if (!cancelled) {
          setDbIds({
            agentId: data.agentId,
            tenantId: data.tenantId,
            role: data.role as UserRole,
            tenantName: data.tenantName,
            email: data.email,
          });
          // Apply server-saved locale so users see their preferred language
          // immediately after sign-in on any device. If no server locale is
          // set, leave i18next on whatever the browser detector picked.
          if (isSupportedLocale(data.locale) && data.locale !== i18n.language) {
            i18n.changeLanguage(data.locale);
          }
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

  // Clear tenant impersonation context on auth state changes
  useEffect(() => {
    const { activeTenant, clearTenant } = useTenantContextStore.getState();
    if (!activeTenant) return;

    // Clear if signed out
    if (!isSignedIn) {
      clearTenant();
      return;
    }

    // Clear if user is no longer super_admin
    if (dbIds && dbIds.role !== 'super_admin') {
      clearTenant();
      return;
    }
  }, [isSignedIn, organization?.id, dbIds]);

  // Validate persisted tenant context on load
  useEffect(() => {
    if (!dbIds || dbIds.role !== 'super_admin') return;

    const { activeTenant, clearTenant } = useTenantContextStore.getState();
    if (!activeTenant) return;

    async function validateTenant() {
      try {
        const token = await getToken();
        const res = await fetch(
          `${API_CONFIG.baseURL}/admin/tenants/${activeTenant!.tenantId}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          }
        );
        if (!res.ok) {
          clearTenant();
          const { toast } = await import('sonner');
          toast.info('Previous tenant context is no longer available');
          return;
        }
        const json = await res.json();
        const tenant = json.data ?? json;
        if (tenant.status === 'suspended' || tenant.status === 'cancelled') {
          clearTenant();
          const { toast } = await import('sonner');
          toast.info('Previous tenant context is no longer available');
        }
      } catch {
        // Network error — leave context as-is, will be caught by API calls
      }
    }

    validateTenant();
  }, [dbIds, getToken]);

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
    // super_admin matches any role check
    if (user.role === 'super_admin') return true;
    if (Array.isArray(role)) return role.includes(user.role);
    return user.role === role;
  }, [user]);

  const value: AppAuthContextValue = {
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

  return (
    <AppAuthContext.Provider value={value}>
      {children}
    </AppAuthContext.Provider>
  );
};
