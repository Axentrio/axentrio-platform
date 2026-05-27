import { vi } from 'vitest';

export interface MockAuthState {
  userId: string;
  tenantId: string;
  agentId: string;
  role: string;
  email: string;
  clerkUserId: string;
  clerkOrgId: string;
}

/**
 * Create all vi.mock() calls and return the hoisted auth state.
 * MUST be called at top of test file before any app/server import.
 *
 * Usage:
 *   import { createAuthMocks, configureMockAuth } from '../helpers/auth';
 *   const { auth } = createAuthMocks();
 *   import { app } from '../../server';
 */
export function createAuthMocks() {
  const auth = vi.hoisted((): MockAuthState => ({
    userId: '',
    tenantId: '',
    agentId: '',
    role: 'super_admin',
    email: 'test@example.com',
    clerkUserId: '',
    clerkOrgId: '',
  }));

  vi.mock('../../middleware/clerk.middleware', () => ({
    requireClerkAuth: (req: any, _res: any, next: any) => {
      req.userId = auth.userId;
      req.tenantId = auth.tenantId;
      req.agentId = auth.agentId;
      req.userRole = auth.role;
      req.user = {
        id: auth.userId,
        email: auth.email,
        role: auth.role,
        tenantId: auth.tenantId,
        clerkUserId: auth.clerkUserId,
        type: 'agent',
      };
      next();
    },
    autoProvision: (_req: any, _res: any, next: any) => next(),
    invalidateProvisionCache: () => {},
    resolveClerkIds: () => ({}),
  }));

  vi.mock('../../middleware/super-admin.middleware', () => ({
    requireSuperAdmin: (req: any, res: any, next: any) => {
      if (req.user?.role !== 'super_admin') {
        res.status(403).json({ error: 'Super admin access required' });
        return;
      }
      next();
    },
    resolveTenantContext: (_req: any, _res: any, next: any) => next(),
  }));

  vi.mock('../../services/clerk-sync.service', () => ({
    inviteToClerkOrganization: () => Promise.resolve(true),
    removeFromClerkOrganization: () => Promise.resolve(true),
  }));

  return { auth };
}

/**
 * Update auth state for the next request.
 */
export function configureMockAuth(
  auth: MockAuthState,
  options: Partial<MockAuthState> = {},
): MockAuthState {
  const defaults: Partial<MockAuthState> = {
    role: 'super_admin',
    email: 'test@example.com',
  };
  Object.assign(auth, defaults, options);
  return auth;
}
