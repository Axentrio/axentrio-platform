import { Request, Response, NextFunction } from 'express';

export function mockClerkAuth(overrides: Partial<{ userId: string; tenantId: string; agentId: string }> = {}) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.userId = overrides.userId || 'test-user-id';
    req.tenantId = overrides.tenantId || 'test-tenant-id';
    req.agentId = overrides.agentId || 'test-agent-id';
    req.user = {
      id: overrides.agentId || 'test-agent-id',
      email: 'test@example.com',
      role: 'admin',
      tenantId: overrides.tenantId || 'test-tenant-id',
      type: 'agent',
    };
    next();
  };
}
