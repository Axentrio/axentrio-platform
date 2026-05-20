/**
 * Webhook Admin Routes
 * Tenant-scoped webhook management: status, delivery log, test ping
 */

import { Router, Request, Response } from 'express';
import axios from 'axios';
import { AppDataSource } from '../database/data-source';
import { WebhookDeliveryLog } from '../database/entities/WebhookDeliveryLog';
import { Tenant } from '../database/entities/Tenant';
import { parsePaginationParams, applyPagination } from '../utils/pagination';
import { asyncHandler, BadRequestError } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';

const router = Router();

/**
 * GET /api/v1/tenants/me/webhooks/deliveries — paginated delivery log
 */
router.get('/deliveries', asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const params = parsePaginationParams(req.query as Record<string, unknown>);
  const qb = AppDataSource.getRepository(WebhookDeliveryLog)
    .createQueryBuilder('log')
    .where('log.tenantId = :tenantId', { tenantId })
    .orderBy('log.createdAt', 'DESC');

  const result = await applyPagination(qb, params);
  sendSuccess(res, result.data, { pagination: result.meta });
}));

/**
 * GET /api/v1/tenants/me/webhooks/status — health + circuit breaker state
 */
router.get('/status', asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const repo = AppDataSource.getRepository(WebhookDeliveryLog);

  const lastDelivery = await repo.findOne({
    where: { tenantId, direction: 'outbound' },
    order: { createdAt: 'DESC' },
  });

  const lastSuccess = await repo.findOne({
    where: { tenantId, direction: 'outbound', status: 'success' },
    order: { createdAt: 'DESC' },
  });

  // Determine health indicator
  let health: 'green' | 'yellow' | 'red' = 'green';
  if (lastDelivery && lastDelivery.status === 'failed') {
    health = 'red';
  } else if (lastDelivery && lastDelivery.status === 'dropped') {
    health = 'red';
  } else if (!lastDelivery) {
    health = 'yellow'; // No deliveries yet
  }

  sendSuccess(res, {
    health,
    lastDelivery: lastDelivery ? {
      status: lastDelivery.status,
      httpStatus: lastDelivery.httpStatus,
      createdAt: lastDelivery.createdAt,
      durationMs: lastDelivery.durationMs,
    } : null,
    lastSuccessAt: lastSuccess?.createdAt || null,
  });
}));

/**
 * POST /api/v1/tenants/me/webhooks/test — send test ping
 */
router.post('/test', asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;

  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOne({ where: { id: tenantId } });

  if (!tenant?.webhookUrl) throw new BadRequestError('No webhook URL configured');

  const startTime = Date.now();
  try {
    const response = await axios.post(tenant.webhookUrl, {
      event: 'webhook.test',
      tenantId,
      payload: { message: 'Test ping from chatbot platform' },
      timestamp: new Date().toISOString(),
    }, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        ...(tenant.webhookSecret ? { 'X-Webhook-Secret': tenant.webhookSecret } : {}),
      },
    });

    const durationMs = Date.now() - startTime;

    // Log successful test
    const logRepo = AppDataSource.getRepository(WebhookDeliveryLog);
    await logRepo.save(logRepo.create({
      tenantId,
      event: 'webhook.test',
      direction: 'outbound' as const,
      url: tenant.webhookUrl,
      status: 'success' as const,
      httpStatus: response.status,
      durationMs,
    }));

    sendSuccess(res, { status: response.status, durationMs });
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const axiosErr = err as { response?: { status: number }; message?: string };

    // Log failed test
    const logRepo = AppDataSource.getRepository(WebhookDeliveryLog);
    await logRepo.save(logRepo.create({
      tenantId,
      event: 'webhook.test',
      direction: 'outbound' as const,
      url: tenant.webhookUrl,
      status: 'failed' as const,
      httpStatus: axiosErr.response?.status,
      durationMs,
      error: axiosErr.message || 'Unknown error',
    }));

    // Return failure info (not an error — the test completed, webhook just failed)
    sendSuccess(res, {
      status: axiosErr.response?.status || 0,
      durationMs,
      error: axiosErr.message,
      testFailed: true,
    });
  }
}));

export default router;
