import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const logAuditMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  tenant: null as Record<string, unknown> | null,
}));

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: () => ({ findOne: async () => state.tenant }),
  },
}));
vi.mock('../../utils/audit', () => ({ logAudit: logAuditMock }));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { resolveTenantContext } from '../../middleware/super-admin.middleware';

const TARGET_TENANT = '11111111-2222-3333-4444-555555555555';
const HOME_TENANT = '99999999-8888-7777-6666-555555555555';

function requestFor(role: string): Request {
  return {
    headers: { 'x-tenant-context': TARGET_TENANT },
    userId: 'actor-1',
    user: { id: 'actor-1', role, tenantId: HOME_TENANT },
  } as unknown as Request;
}

beforeEach(() => {
  logAuditMock.mockReset();
  logAuditMock.mockResolvedValue(undefined);
  state.tenant = { id: TARGET_TENANT, name: 'Target BV', status: 'active' };
});

describe('resolveTenantContext audit trail', () => {
  it('writes one audit row naming the actor home tenant when a super admin switches', async () => {
    const req = requestFor('super_admin');
    const next = vi.fn() as unknown as NextFunction;

    await resolveTenantContext(req, {} as Response, next);

    expect(req.tenantId).toBe(TARGET_TENANT);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock).toHaveBeenCalledWith(
      'actor-1',
      'tenant.context_switched',
      'tenant',
      TARGET_TENANT,
      TARGET_TENANT,
      { homeTenantId: HOME_TENANT },
    );
    expect(next).toHaveBeenCalledWith();
  });

  it('audits once when overlapping router mounts run it again on the same request', async () => {
    const req = requestFor('super_admin');
    const next = vi.fn() as unknown as NextFunction;

    await resolveTenantContext(req, {} as Response, next);
    await resolveTenantContext(req, {} as Response, next);
    await resolveTenantContext(req, {} as Response, next);

    expect(req.tenantId).toBe(TARGET_TENANT);
    expect(req.user?.tenantId).toBe(TARGET_TENANT);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0][5]).toEqual({ homeTenantId: HOME_TENANT });
  });

  it('ignores the header for a normal admin and writes no audit row', async () => {
    const req = requestFor('admin');
    const next = vi.fn() as unknown as NextFunction;

    await resolveTenantContext(req, {} as Response, next);

    expect(req.tenantId).toBeUndefined();
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});
