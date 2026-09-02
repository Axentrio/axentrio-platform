import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const findOne = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: () => ({ findOne }),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { resolveTenantContext } from '../../middleware/super-admin.middleware';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function mockReq(opts: { role?: string; header?: string; tenantId?: string }) {
  const tenantId = opts.tenantId ?? HOME;
  return {
    headers: opts.header !== undefined ? { 'x-tenant-context': opts.header } : {},
    user: opts.role
      ? {
          id: 'agent-1',
          email: 'a@b.c',
          role: opts.role,
          tenantId,
          type: 'agent',
        }
      : undefined,
    tenantId,
    userId: 'user-1',
  } as unknown as Request;
}

function nextRecorder() {
  const calls: unknown[] = [];
  const next = ((err?: unknown) => {
    calls.push(err);
  }) as NextFunction;
  return { next, calls };
}

describe('resolveTenantContext', () => {
  beforeEach(() => {
    findOne.mockReset();
  });

  it('super admin + active tenant overwrites req.user.tenantId and req.tenantId', async () => {
    findOne.mockResolvedValue({ id: TARGET, name: 'Viewed', status: 'active' });
    const req = mockReq({ role: 'super_admin', header: TARGET });
    const { next, calls } = nextRecorder();
    await resolveTenantContext(req, {} as Response, next);
    expect(req.tenantId).toBe(TARGET);
    expect(req.user?.tenantId).toBe(TARGET);
    expect(calls).toEqual([undefined]);
    expect(findOne).toHaveBeenCalledWith({ where: { id: TARGET } });
  });

  it('role admin + header leaves tenantId unchanged', async () => {
    const req = mockReq({ role: 'admin', header: TARGET });
    const { next, calls } = nextRecorder();
    await resolveTenantContext(req, {} as Response, next);
    expect(req.tenantId).toBe(HOME);
    expect(req.user?.tenantId).toBe(HOME);
    expect(findOne).not.toHaveBeenCalled();
    expect(calls).toEqual([undefined]);
  });

  it('super admin with no header leaves tenantId unchanged', async () => {
    const req = mockReq({ role: 'super_admin' });
    const { next, calls } = nextRecorder();
    await resolveTenantContext(req, {} as Response, next);
    expect(req.tenantId).toBe(HOME);
    expect(req.user?.tenantId).toBe(HOME);
    expect(findOne).not.toHaveBeenCalled();
    expect(calls).toEqual([undefined]);
  });

  it('super admin + missing tenant calls next with not found', async () => {
    findOne.mockResolvedValue(null);
    const req = mockReq({ role: 'super_admin', header: TARGET });
    const { next, calls } = nextRecorder();
    await resolveTenantContext(req, {} as Response, next);
    expect(req.user?.tenantId).toBe(HOME);
    expect(calls[0]).toMatchObject({ message: 'Tenant not found' });
  });

  it('super admin + suspended tenant calls next with forbidden', async () => {
    findOne.mockResolvedValue({ id: TARGET, name: 'Viewed', status: 'suspended' });
    const req = mockReq({ role: 'super_admin', header: TARGET });
    const { next, calls } = nextRecorder();
    await resolveTenantContext(req, {} as Response, next);
    expect(req.user?.tenantId).toBe(HOME);
    expect(calls[0]).toMatchObject({ message: 'Tenant is suspended' });
  });

  it('empty header leaves tenantId unchanged', async () => {
    const req = mockReq({ role: 'super_admin', header: '' });
    const { next, calls } = nextRecorder();
    await resolveTenantContext(req, {} as Response, next);
    expect(req.tenantId).toBe(HOME);
    expect(req.user?.tenantId).toBe(HOME);
    expect(findOne).not.toHaveBeenCalled();
    expect(calls).toEqual([undefined]);
  });

  it('missing user leaves tenantId unchanged', async () => {
    const req = mockReq({ header: TARGET });
    const { next, calls } = nextRecorder();
    await resolveTenantContext(req, {} as Response, next);
    expect(req.tenantId).toBe(HOME);
    expect(findOne).not.toHaveBeenCalled();
    expect(calls).toEqual([undefined]);
  });

  it('supervisor + header leaves tenantId unchanged', async () => {
    const req = mockReq({ role: 'supervisor', header: TARGET });
    const { next, calls } = nextRecorder();
    await resolveTenantContext(req, {} as Response, next);
    expect(req.tenantId).toBe(HOME);
    expect(req.user?.tenantId).toBe(HOME);
    expect(findOne).not.toHaveBeenCalled();
    expect(calls).toEqual([undefined]);
  });

  it('does not leak the viewed tenant onto a later request object', async () => {
    findOne.mockResolvedValue({ id: TARGET, name: 'Viewed', status: 'active' });
    const viewed = mockReq({ role: 'super_admin', header: TARGET });
    const later = mockReq({ role: 'super_admin' });
    const { next } = nextRecorder();
    await resolveTenantContext(viewed, {} as Response, next);
    await resolveTenantContext(later, {} as Response, next);
    expect(viewed.user?.tenantId).toBe(TARGET);
    expect(later.user?.tenantId).toBe(HOME);
    expect(later.tenantId).toBe(HOME);
  });
});
