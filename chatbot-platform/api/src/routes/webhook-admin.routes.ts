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
import { logger } from '../utils/logger';

const router = Router();

/**
 * GET /api/v1/tenants/me/webhooks/deliveries — paginated delivery log
 */
router.get('/deliveries', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const params = parsePaginationParams(req.query as Record<string, unknown>);
    const qb = AppDataSource.getRepository(WebhookDeliveryLog)
      .createQueryBuilder('log')
      .where('log.tenantId = :tenantId', { tenantId })
      .orderBy('log.createdAt', 'DESC');

    const result = await applyPagination(qb, params);
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Failed to fetch delivery logs', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/tenants/me/webhooks/status — health + circuit breaker state
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

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

    res.json({
      success: true,
      data: {
        health,
        lastDelivery: lastDelivery ? {
          status: lastDelivery.status,
          httpStatus: lastDelivery.httpStatus,
          createdAt: lastDelivery.createdAt,
          durationMs: lastDelivery.durationMs,
        } : null,
        lastSuccessAt: lastSuccess?.createdAt || null,
      },
    });
  } catch (error) {
    logger.error('Failed to fetch webhook status', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/tenants/me/webhooks/test — send test ping
 */
router.post('/test', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const tenantRepo = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepo.findOne({ where: { id: tenantId } });

    if (!tenant?.webhookUrl) {
      res.status(400).json({ error: 'No webhook URL configured' });
      return;
    }

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

      res.json({
        success: true,
        data: { status: response.status, durationMs },
      });
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

      res.json({
        success: false,
        data: {
          status: axiosErr.response?.status || 0,
          durationMs,
          error: axiosErr.message,
        },
      });
    }
  } catch (error) {
    logger.error('Failed to send test webhook', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
