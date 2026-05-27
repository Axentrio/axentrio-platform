import { describe, it, vi } from 'vitest';
import { createAuthMocks } from '../helpers/auth';

createAuthMocks();

// Mock @clerk/express global middleware (clerkMiddleware) to be a no-op
vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

// Mock socket handler to avoid real WebSocket operations
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
}));

// Mock audit logging
vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

// File route auth-rejection tests are no longer meaningful with mocked auth
// (clerkMiddleware is no-op and requireClerkAuth always sets auth).
// Real file route behaviour is covered by integration tests that configure auth properly.

describe('File Routes', () => {
  it.skip('auth-rejection tests removed — auth is fully mocked in this environment', () => {});
});
