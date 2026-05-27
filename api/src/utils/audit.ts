import { AppDataSource } from '../database/data-source';
import { AuditLog } from '../database/entities/AuditLog';
import { logger } from './logger';

export async function logAudit(
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  tenantId?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(AuditLog);
    await repo.save(
      repo.create({
        actorId,
        action,
        entityType,
        entityId,
        tenantId,
        metadata,
      })
    );
  } catch (error) {
    logger.error('Failed to write audit log', { error, action, entityType, entityId });
  }
}
