import { Request, Response } from 'express';
import { logger } from '../utils/logger';
import { updateIntegrationsSchema } from '../schemas/integrations.schema';
import { sendSuccess } from '../utils/response';
import { requireFeature } from '../billing/enforce';
import {
  getAllIntegrationProviders,
  readAllIntegrations,
  readIntegrationConfig,
  writeIntegrationConfig,
} from '../integrations/registry';
import { calcomProvider } from '../integrations';

/**
 * Thin dispatcher over the IntegrationProvider registry. Generic operations
 * (list/update) iterate registered providers; provider-specific actions (the
 * Cal.com connect + event-types endpoints) call the provider directly, the
 * same way channel-specific connect routes call their setup services.
 */

export async function getIntegrations(req: Request, res: Response) {
  const tenantId = req.tenantId!;
  const all = await readAllIntegrations(tenantId);

  const result: Record<string, unknown> = {};
  for (const provider of getAllIntegrationProviders()) {
    const config = all[provider.kind];
    if (config) result[provider.kind] = provider.redact(config);
  }

  sendSuccess(res, result);
}

export async function updateIntegrations(req: Request, res: Response) {
  const tenantId = req.tenantId!;
  const data = updateIntegrationsSchema.parse(req.body) as Record<string, unknown>;

  for (const provider of getAllIntegrationProviders()) {
    const patch = data[provider.kind];
    if (patch === undefined) continue; // not in this request

    // Setting (not clearing) requires the feature; disconnect (null) stays
    // allowed so downgraded tenants can clean up their own state.
    if (patch !== null) {
      await requireFeature(tenantId, provider.feature, provider.errorCode);
    }

    const existing = await readIntegrationConfig(tenantId, provider.kind);
    const next = patch === null ? null : provider.applyUpdate(existing, patch);
    await writeIntegrationConfig(tenantId, provider.kind, next);
    if (provider.afterUpdate) await provider.afterUpdate(tenantId, next);
  }

  // Redacted response of current state
  const result: Record<string, unknown> = {};
  for (const provider of getAllIntegrationProviders()) {
    const config = await readIntegrationConfig(tenantId, provider.kind);
    if (config) result[provider.kind] = provider.redact(config);
  }

  logger.info(`Integrations updated for tenant ${tenantId}`);
  sendSuccess(res, result);
}

export async function connectCalcom(req: Request, res: Response): Promise<void> {
  const tenantId = req.tenantId!;
  await requireFeature(tenantId, calcomProvider.feature, calcomProvider.errorCode);

  const eventTypes = await calcomProvider.connect(tenantId, req.body?.apiKey);

  logger.info(`Cal.com connected for tenant ${tenantId}: ${eventTypes.length} event types`);
  sendSuccess(res, { eventTypes });
}

export async function getCalcomEventTypes(req: Request, res: Response): Promise<void> {
  const tenantId = req.tenantId!;
  await requireFeature(tenantId, calcomProvider.feature, calcomProvider.errorCode);

  const eventTypes = await calcomProvider.listEventTypes(tenantId);
  sendSuccess(res, { eventTypes });
}
