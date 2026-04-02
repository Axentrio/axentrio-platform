import { Request, Response } from 'express';
import axios from 'axios';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { encrypt } from '../utils/encryption';
import { logger } from '../utils/logger';
import { updateIntegrationsSchema } from '../schemas/integrations.schema';
import { config } from '../config/environment';

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

export async function connectCalcom(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const { apiKey } = req.body;

  if (!apiKey) {
    return res.status(400).json({ error: 'apiKey is required' });
  }

  // Validate key against Cal.com and fetch event types
  let rawEventTypes: any[];
  try {
    const response = await axios.get('https://api.cal.com/v2/event-types', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'cal-api-version': '2024-09-04',
      },
    });

    const groups: any[] = response.data?.data?.eventTypeGroups ?? [];
    rawEventTypes = groups.flatMap((g: any) => g.eventTypes ?? []);
  } catch (err: any) {
    if (err?.response?.status === 401) {
      return res.status(400).json({ error: 'Invalid or expired API key' });
    }
    throw err;
  }

  if (rawEventTypes.length === 0) {
    return res.status(400).json({ error: 'No event types found. Create one in Cal.com first.' });
  }

  // Persist: encrypt key, clear eventTypeId on reconnect, preserve other settings
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });

  const existing = tenant.settings?.integrations || {};
  const existingCalcom = (existing as any).calcom || {};

  // Auto-set webhookUrl only when not already set
  const webhookUrl = existingCalcom.webhookUrl || config.n8n.defaultWebhookUrl || undefined;

  const updatedCalcom: any = {
    ...existingCalcom,
    apiKey: encrypt(apiKey),
    webhookUrl,
  };

  // Clear eventTypeId on reconnect so tenant picks a new one
  delete updatedCalcom.eventTypeId;

  tenant.settings = {
    ...tenant.settings,
    integrations: {
      ...existing,
      calcom: updatedCalcom,
    },
  };

  await tenantRepo.save(tenant);

  const eventTypes = rawEventTypes.map((et: any) => ({
    id: et.id,
    title: et.title || et.slug,
    length: et.lengthInMinutes ?? et.length ?? 0,
    slug: et.slug,
  }));

  logger.info(`Cal.com connected for tenant ${tenantId}: ${eventTypes.length} event types`);

  return res.json({ eventTypes });
}
