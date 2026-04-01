import { Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { encrypt } from '../utils/encryption';
import { logger } from '../utils/logger';
import { updateIntegrationsSchema } from '../schemas/integrations.schema';

export async function getIntegrations(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });

  const integrations = tenant.settings?.integrations || {};
  const result: Record<string, any> = {};

  if (integrations.calcom) {
    const { apiKey, ...rest } = integrations.calcom;
    result.calcom = { ...rest, hasApiKey: !!apiKey };
  }

  res.json(result);
}

export async function updateIntegrations(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const data = updateIntegrationsSchema.parse(req.body);
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });

  const existing = tenant.settings?.integrations || {};
  const updated: any = { ...existing };

  if (data.calcom === null) {
    // Remove Cal.com integration
    delete updated.calcom;
  } else if (data.calcom) {
    const existingCalcom = existing.calcom || {};
    updated.calcom = { ...existingCalcom };

    if (data.calcom.apiKey !== undefined) {
      updated.calcom.apiKey = data.calcom.apiKey ? encrypt(data.calcom.apiKey) : null;
    }
    if (data.calcom.eventTypeId) updated.calcom.eventTypeId = data.calcom.eventTypeId;
    if (data.calcom.collectFields) updated.calcom.collectFields = data.calcom.collectFields;
    if (data.calcom.language) updated.calcom.language = data.calcom.language;
  }

  tenant.settings = { ...tenant.settings, integrations: updated };
  await tenantRepo.save(tenant);

  // Return redacted response
  const response: Record<string, any> = {};
  if (updated.calcom) {
    const { apiKey, ...rest } = updated.calcom;
    response.calcom = { ...rest, hasApiKey: !!apiKey };
  }

  logger.info(`Integrations updated for tenant ${tenantId}`);
  res.json(response);
}
