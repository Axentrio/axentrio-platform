/**
 * Public one-click unsubscribe for the weekly digest (P3 / ADR-0014, D6).
 * No Clerk auth — the signed token IS the authorization. Mounted before the
 * Clerk middleware in server.ts.
 *
 * - GET  serves a small confirmation page (the human-visible footer link).
 * - POST is the RFC 8058 one-click target (List-Unsubscribe-Post) mail clients
 *   hit directly; it returns 200 with no body.
 * Both are idempotent: they set tenant.settings.insights.digestEmail = false.
 */
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { asyncHandler } from '../middleware/error-handler';
import { verifyUnsubscribeToken } from '../insights/digest-token';
import { logger } from '../utils/logger';

export const digestUnsubscribeRouter = Router();

async function optOut(token: unknown): Promise<boolean> {
  if (typeof token !== 'string') return false;
  const tenantId = verifyUnsubscribeToken(token);
  if (!tenantId) return false;
  const repo = AppDataSource.getRepository(Tenant);
  const tenant = await repo.findOne({ where: { id: tenantId } });
  if (!tenant) return false;
  tenant.settings = {
    ...tenant.settings,
    insights: { ...tenant.settings?.insights, digestEmail: false },
  };
  await repo.save(tenant);
  logger.info('[digest-unsubscribe] opted out', { tenantId });
  return true;
}

function page(title: string, body: string): string {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f1f5f9;margin:0;padding:48px;">
  <div style="max-width:460px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;text-align:center;">
    <h1 style="font-size:18px;color:#0f172a;margin:0 0 8px;">${title}</h1>
    <p style="color:#64748b;font-size:14px;margin:0;">${body}</p>
  </div></body></html>`;
}

// One-click (RFC 8058): clients POST without rendering anything.
digestUnsubscribeRouter.post(
  '/digest',
  asyncHandler(async (req: Request, res: Response) => {
    await optOut(req.query.token ?? (req.body as { token?: unknown })?.token);
    res.status(200).end();
  }),
);

digestUnsubscribeRouter.get(
  '/digest',
  asyncHandler(async (req: Request, res: Response) => {
    const ok = await optOut(req.query.token);
    res
      .status(ok ? 200 : 400)
      .type('html')
      .send(
        ok
          ? page('Unsubscribed', "You won't receive any more weekly summary emails. You can re-enable them anytime from your Insights settings.")
          : page('Link expired', 'This unsubscribe link is invalid or has expired. Manage your email preferences from your Insights settings.'),
      );
  }),
);
