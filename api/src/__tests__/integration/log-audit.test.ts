import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { AppDataSource } from '../../database/data-source';
import { AuditLog } from '../../database/entities/AuditLog';
import { logAudit } from '../../utils/audit';
import { createTestTenant } from '../helpers/factories';

describe('logAudit', () => {
  it('should create an audit log record', async () => {
    const tenant = await createTestTenant();
    const actorId = randomUUID();

    await logAudit(actorId, 'tenant.create', 'tenant', tenant.id, tenant.id);

    const repo = AppDataSource.getRepository(AuditLog);
    const logs = await repo.find({ where: { entityId: tenant.id } });

    expect(logs).toHaveLength(1);
    expect(logs[0].actorId).toBe(actorId);
    expect(logs[0].action).toBe('tenant.create');
    expect(logs[0].entityType).toBe('tenant');
    expect(logs[0].tenantId).toBe(tenant.id);
  });

  it('should store metadata as JSON', async () => {
    const tenant = await createTestTenant();
    const actorId = randomUUID();
    const entityId = randomUUID();
    const meta = { oldRole: 'agent', newRole: 'admin' };

    await logAudit(actorId, 'user.promote', 'user', entityId, tenant.id, meta);

    const repo = AppDataSource.getRepository(AuditLog);
    const logs = await repo.find({ where: { actorId } });

    expect(logs).toHaveLength(1);
    expect(logs[0].metadata).toEqual(meta);
  });

  it('should work without tenantId (platform-level action)', async () => {
    const actorId = randomUUID();
    const entityId = randomUUID();

    await logAudit(actorId, 'tenant.create', 'tenant', entityId);

    const repo = AppDataSource.getRepository(AuditLog);
    const logs = await repo.find({ where: { actorId } });

    expect(logs).toHaveLength(1);
    expect(logs[0].tenantId).toBeNull();
  });

  it('should not throw on DB errors (graceful failure)', async () => {
    await expect(logAudit('', '', '', '')).resolves.toBeUndefined();
  });
});
