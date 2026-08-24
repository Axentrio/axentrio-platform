/**
 * Tenant outbound-webhook handlers
 *
 * Connectivity test and HMAC-secret rotation for the legacy external-n8n
 * webhook. Registered by routes/tenants.ts.
 */

import crypto from "crypto";
import { safeOutboundRequest } from "../security/ssrf-guard";
import { type Request, type Response } from "express";
import { AppDataSource } from "../database/data-source";
import { Tenant } from "../database/entities/Tenant";
import { asyncHandler, NotFoundError } from "../middleware";
import { sendSuccess } from "../utils/response";
import { logger } from "../utils/logger";
import { invalidate } from "../utils/cache";

/**
 * Test webhook connection
 * POST /api/v1/tenants/me/webhook-test
 */
export const testTenantWebhook = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;

    const tenantRepository = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundError("Tenant not found");
    }

    if (!tenant.webhookUrl) {
      sendSuccess(res, {
        testFailed: true,
        error: "No webhook URL configured",
      });
      return;
    }

    // Validate URL format
    try {
      new URL(tenant.webhookUrl);
    } catch {
      sendSuccess(res, {
        testFailed: true,
        error: "Invalid webhook URL format",
      });
      return;
    }

    const startTime = Date.now();
    try {
      const response = await safeOutboundRequest({
        method: "POST",
        url: tenant.webhookUrl,
        data: {
          event: "webhook.test",
          tenantId: tenant.id,
          timestamp: new Date().toISOString(),
          payload: { type: "test", content: "Webhook connectivity test" },
        },
        timeout: 5000,
        headers: {
          "Content-Type": "application/json",
          "X-Tenant-ID": tenant.id,
          ...(tenant.webhookSecret
            ? {
                "X-Webhook-Secret": tenant.webhookSecret,
              }
            : {}),
        },
        validateStatus: () => true,
      });

      const responseTimeMs = Date.now() - startTime;

      if (response.status >= 200 && response.status < 300) {
        sendSuccess(res, {
          responseTimeMs,
        });
      } else {
        sendSuccess(res, {
          testFailed: true,
          error: `Webhook returned status ${response.status}`,
          responseTimeMs,
        });
      }
    } catch (error: unknown) {
      const responseTimeMs = Date.now() - startTime;
      const err = error as { code?: string; message?: string };
      sendSuccess(res, {
        testFailed: true,
        error:
          err.code === "ECONNABORTED"
            ? "Webhook timed out (5s limit)"
            : err.message || "Connection failed",
        responseTimeMs,
      });
    }
  },
);

/**
 * Regenerate webhook secret
 * POST /api/v1/tenants/me/webhook-secret/regenerate
 */
export const regenerateTenantWebhookSecret = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;

    const tenantRepository = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundError("Tenant not found");
    }

    tenant.webhookSecret = crypto.randomBytes(32).toString("hex");
    await tenantRepository.save(tenant);

    // Drop the cached secret (see n8n/webhook.controller verifyPerTenantSecret)
    // so inbound webhooks validate against the new secret immediately.
    await invalidate(`tenant:webhook-secret:${tenantId}`);

    logger.info("Webhook secret regenerated", { tenantId });

    sendSuccess(res, {
      webhookSecret: tenant.webhookSecret,
      message:
        "Webhook secret regenerated. Update your n8n workflow with the new secret.",
    });
  },
);
