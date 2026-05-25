import { Request, Response } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { encrypt } from '../utils/encryption';
import { logger } from '../utils/logger';
import { updateIntegrationsSchema } from '../schemas/integrations.schema';
import { config } from '../config/environment';
import { sendSuccess } from '../utils/response';
import { ApiError, BadRequestError, RateLimitError } from '../middleware/error-handler';
import { ERROR_CODES } from '../middleware/error-codes';
import { getAnchorBotConfig, replaceAnchorBotSettingsSection } from '../services/bot-config.service';
import { requireFeature } from '../billing/enforce';

export async function getIntegrations(req: Request, res: Response) {
  const tenantId = req.tenantId!;
  // Multi-bot Phase 4 (#16d): integrations live on Bot.settings.
  const { settings } = await getAnchorBotConfig(tenantId);
  const integrations = settings.integrations || {};
  const result: Record<string, any> = {};

  if (integrations.calcom) {
    const { apiKey, ...rest } = integrations.calcom;
    result.calcom = { ...rest, hasApiKey: !!apiKey };
  }

  sendSuccess(res, result);
}

export async function updateIntegrations(req: Request, res: Response) {
  const tenantId = req.tenantId!;
  const data = updateIntegrationsSchema.parse(req.body);

  // Setting (not clearing) Cal.com requires the calendarIntegrations
  // entitlement. Disconnect (`calcom: null`) stays allowed so downgraded
  // tenants can still clean up their own state.
  if (data.calcom && data.calcom !== null) {
    await requireFeature(tenantId, 'calendarIntegrations', 'plan_limit_calendar_integrations');
  }

  // Multi-bot Phase 4 (#16d): read+write integrations on Bot.settings.
  const { settings: existingSettings } = await getAnchorBotConfig(tenantId);
  const existing = existingSettings.integrations || {};
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

  // Write integrations to anchor bot via the section-replacement writer
  // (wholesale, so removing calcom actually deletes it from persisted state —
  // the deep-merge writer would resurrect the old calcom from base).
  await replaceAnchorBotSettingsSection(tenantId, 'integrations', updated);

  // Auto-set webhook URL on Tenant if saving Cal.com with eventTypeId and
  // webhook not configured. webhookUrl/webhookSecret stay on Tenant (not
  // moved to Bot).
  if (updated.calcom?.eventTypeId) {
    const tenantRepo = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });
    if (!tenant.webhookUrl && config.n8n.defaultWebhookUrl) {
      tenant.webhookUrl = config.n8n.defaultWebhookUrl;
      if (!tenant.webhookSecret) {
        tenant.webhookSecret = crypto.randomBytes(32).toString('hex');
      }
      await tenantRepo.save(tenant);
    }
  }

  // Return redacted response
  const response: Record<string, any> = {};
  if (updated.calcom) {
    const { apiKey, ...rest } = updated.calcom;
    response.calcom = { ...rest, hasApiKey: !!apiKey };
  }

  logger.info(`Integrations updated for tenant ${tenantId}`);
  sendSuccess(res, response);
}

export async function connectCalcom(req: Request, res: Response): Promise<void> {
  const tenantId = req.tenantId!;

  // Tier gate at the write boundary. Single source of truth alongside the
  // egress-side `getCalcomIntegrationForBot` helper.
  await requireFeature(tenantId, 'calendarIntegrations', 'plan_limit_calendar_integrations');

  const { apiKey } = req.body;

  if (!apiKey || typeof apiKey !== 'string' || apiKey.length > 256) {
    throw new BadRequestError('A valid API key is required');
  }

  // Validate key against Cal.com and fetch event types
  let rawEventTypes: any[];
  try {
    const response = await axios.get('https://api.cal.com/v2/event-types', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'cal-api-version': '2024-06-14',
      },
      timeout: 10000,
    });

    const responseData = response.data?.data;
    if (Array.isArray(responseData)) {
      rawEventTypes = responseData;
    } else {
      const groups: any[] = responseData?.eventTypeGroups ?? [];
      rawEventTypes = groups.flatMap((g: any) => g.eventTypes ?? []);
    }
  } catch (err: any) {
    if (err?.response?.status === 401) {
      throw new BadRequestError('Invalid or expired API key');
    }
    if (err?.response?.status === 429) {
      throw new RateLimitError('Cal.com rate limit exceeded. Please try again later.');
    }
    logger.error('Cal.com connect failed', { status: err?.response?.status, message: err?.message });
    throw new ApiError('Could not reach Cal.com. Please try again later.', 502, ERROR_CODES.UPSTREAM_FAILED);
  }

  if (rawEventTypes.length === 0) {
    throw new BadRequestError('No event types found. Create one in Cal.com first.');
  }

  // Persist: encrypt key, clear eventTypeId on reconnect, preserve other settings.
  // Multi-bot Phase 4 (#16d): integrations live on Bot.settings.
  const { settings: existingSettings } = await getAnchorBotConfig(tenantId);
  const existing = existingSettings.integrations || {};
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

  // Write the integrations section wholesale via the service writer.
  await replaceAnchorBotSettingsSection(tenantId, 'integrations', {
    ...existing,
    calcom: updatedCalcom,
  });

  const eventTypes = rawEventTypes.map((et: any) => ({
    id: et.id,
    title: et.title || et.slug,
    length: et.lengthInMinutes ?? et.length ?? 0,
    slug: et.slug,
  }));

  logger.info(`Cal.com connected for tenant ${tenantId}: ${eventTypes.length} event types`);

  sendSuccess(res, { eventTypes });
}

export async function getCalcomEventTypes(req: Request, res: Response): Promise<void> {
  const tenantId = req.tenantId!;

  // Querying Cal.com via our API uses platform compute on a paid feature —
  // gate the read alongside the writes.
  await requireFeature(tenantId, 'calendarIntegrations', 'plan_limit_calendar_integrations');

  // Multi-bot Phase 4 (#16d): integrations live on Bot.settings.
  const { settings } = await getAnchorBotConfig(tenantId);

  const calcom = settings.integrations?.calcom;
  if (!calcom?.apiKey) {
    throw new BadRequestError('Cal.com not connected');
  }

  const { decrypt } = await import('../utils/encryption');
  const decryptedKey = decrypt(calcom.apiKey);

  try {
    const response = await axios.get('https://api.cal.com/v2/event-types', {
      headers: {
        Authorization: `Bearer ${decryptedKey}`,
        'cal-api-version': '2024-06-14',
      },
      timeout: 10000,
    });

    const responseData = response.data?.data;
    const raw = Array.isArray(responseData) ? responseData : (responseData?.eventTypeGroups ?? []).flatMap((g: any) => g.eventTypes ?? []);

    const eventTypes = raw.map((et: any) => ({
      id: et.id,
      title: et.title || et.slug,
      length: et.lengthInMinutes ?? et.length ?? 0,
      slug: et.slug,
    }));

    sendSuccess(res, { eventTypes });
  } catch (err: any) {
    if (err?.response?.status === 401) {
      throw new BadRequestError('Cal.com API key is invalid or expired');
    }
    throw new ApiError('Could not reach Cal.com', 502, ERROR_CODES.UPSTREAM_FAILED);
  }
}
