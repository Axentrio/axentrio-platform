import { Request, Response, NextFunction } from 'express';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { logger } from '../utils/logger';

/**
 * Requires the user to be a super admin. Returns 403 if not.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'super_admin') {
    res.status(403).json({ error: 'Super admin access required' });
    return;
  }
  next();
}

/**
 * Resolves tenant context from X-Tenant-Context header for super admins.
 * Non-super-admin users: header is ignored entirely.
 * Super admins without header: tenantId stays as their own.
 * Super admins with header: tenantId is set to the target tenant.
 */
export async function resolveTenantContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  const targetTenantId = req.headers['x-tenant-context'] as string | undefined;

  if (!targetTenantId || !req.user || req.user.role !== 'super_admin') {
    next();
    return;
  }

  try {
    const tenantRepo = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepo.findOne({ where: { id: targetTenantId } });

    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    if (tenant.status === 'suspended') {
      res.status(403).json({ error: 'Tenant is suspended' });
      return;
    }

    req.tenantId = tenant.id;
    logger.info('Super admin context switch', {
      userId: req.userId,
      targetTenantId: tenant.id,
      targetTenantName: tenant.name,
    });

    next();
  } catch (error) {
    logger.error('Failed to resolve tenant context', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
}
