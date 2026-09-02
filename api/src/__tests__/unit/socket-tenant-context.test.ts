import { describe, it, expect, vi } from 'vitest';
import { applySocketTenantContext } from '../../websocket/socket.handler';
import type { Tenant } from '../../database/entities/Tenant';
import type { TenantSocket } from '../../middleware/tenant.middleware';

const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function mockSocket(opts: {
  role?: string;
  type?: 'agent' | 'widget';
  tenantContext?: string;
  tenantId?: string;
}) {
  const tenantId = opts.tenantId ?? HOME;
  return {
    handshake: {
      auth: opts.tenantContext !== undefined ? { tenantContext: opts.tenantContext } : {},
    },
    data: {
      user: opts.role
        ? {
            id: 'agent-1',
            userId: 'user-1',
            email: 'a@b.c',
            role: opts.role,
            tenantId,
            type: opts.type ?? 'agent',
          }
        : undefined,
      tenantId,
    },
  } as TenantSocket;
}

describe('applySocketTenantContext', () => {
  it('super admin + valid UUID + active tenant -> overwrites tenantId', async () => {
    const socket = mockSocket({ role: 'super_admin', tenantContext: TARGET });
    const loadTenant = vi.fn(async () => ({ id: TARGET, status: 'active' }) as Tenant);
    await applySocketTenantContext(socket, loadTenant);
    expect(socket.data.tenantId).toBe(TARGET);
    expect(socket.data.user?.tenantId).toBe(TARGET);
    expect(loadTenant).toHaveBeenCalledWith(TARGET);
  });

  it('super admin + loadTenant null -> Tenant not found', async () => {
    const socket = mockSocket({ role: 'super_admin', tenantContext: TARGET });
    await expect(applySocketTenantContext(socket, async () => null)).rejects.toThrow(
      'Authentication error: Tenant not found',
    );
  });

  it('super admin + suspended -> Tenant is suspended', async () => {
    const socket = mockSocket({ role: 'super_admin', tenantContext: TARGET });
    await expect(
      applySocketTenantContext(socket, async () => ({ id: TARGET, status: 'suspended' }) as Tenant),
    ).rejects.toThrow('Authentication error: Tenant is suspended');
  });

  it('super admin + non-UUID -> Invalid tenant context', async () => {
    const socket = mockSocket({ role: 'super_admin', tenantContext: 'not-a-uuid' });
    const loadTenant = vi.fn();
    await expect(applySocketTenantContext(socket, loadTenant)).rejects.toThrow(
      'Authentication error: Invalid tenant context',
    );
    expect(loadTenant).not.toHaveBeenCalled();
  });

  it('role admin + valid target -> no change, loadTenant not called', async () => {
    const socket = mockSocket({ role: 'admin', tenantContext: TARGET });
    const loadTenant = vi.fn();
    await applySocketTenantContext(socket, loadTenant);
    expect(socket.data.tenantId).toBe(HOME);
    expect(socket.data.user?.tenantId).toBe(HOME);
    expect(loadTenant).not.toHaveBeenCalled();
  });

  it('no tenantContext -> no change', async () => {
    const socket = mockSocket({ role: 'super_admin' });
    const loadTenant = vi.fn();
    await applySocketTenantContext(socket, loadTenant);
    expect(socket.data.tenantId).toBe(HOME);
    expect(loadTenant).not.toHaveBeenCalled();
  });
});
