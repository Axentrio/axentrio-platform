import { Router, Request, Response } from 'express';
import { AppDataSource, runInTransaction } from '../database/data-source';
import { DemandSignal } from '../database/entities/DemandSignal';
import { Tenant } from '../database/entities/Tenant';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { asyncHandler, ApiError } from '../middleware/error-handler';
import { validate } from '../middleware/validate';
import { sendCreated } from '../utils/response';
import { notifyMeSchema } from '../schemas/demand-signal.schema';
import { logger } from '../utils/logger';

const router = Router();

router.use(requireClerkAuth, autoProvision);

const RATE_LIMIT_COUNT = 10;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h rolling window

/**
 * Resolve locale per the precedence in the PR11 plan:
 *   1. req.user.locale (if the field exists at runtime)
 *   2. First language code from Accept-Language header
 *   3. 'en'
 */
function resolveLocale(req: Request): string {
  // (1) RequestUser doesn't currently expose `locale` in the type but the
  // plan calls for defensive lookup in case it gets added later (Clerk
  // publicMetadata or our User.locale). Use a structural read.
  const userLocale = (req as { user?: { locale?: unknown } }).user?.locale;
  if (typeof userLocale === 'string' && userLocale.length > 0) {
    return userLocale.slice(0, 8);
  }

  // (2) Accept-Language: e.g. "nl-BE,fr;q=0.8" → "nl"
  const header = req.headers['accept-language'];
  if (typeof header === 'string' && header.length > 0) {
    const firstTag = header.split(',')[0]?.trim();
    if (firstTag) {
      const lang = firstTag.split(/[-;]/)[0]?.toLowerCase();
      if (lang && /^[a-z]{2,3}$/.test(lang)) {
        return lang.slice(0, 8);
      }
    }
  }

  // (3) Fallback
  return 'en';
}

/**
 * POST /demand-signals/notify-me
 *
 * Records a "Notify me" / "Contact Sales" click for a Coming Soon feature.
 * Body: { feature, context? } — server fills tenantId, currentTier, locale.
 *
 * Rate-limited to 10 rows per (tenant, feature) per 24h rolling window via
 * a per-key pg advisory lock + count-then-insert in a single tx.
 */
router.post(
  '/notify-me',
  validate(notifyMeSchema),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.tenantId!;
    const { feature, context } = req.body as { feature: string; context: Record<string, unknown> };

    const locale = resolveLocale(req);

    // Snapshot Tenant.tier at click time (lookup outside the rate-limit tx so
    // we don't hold the advisory lock across this read).
    const tenant = await AppDataSource.getRepository(Tenant).findOne({
      where: { id: tenantId },
      select: { id: true, tier: true },
    });
    if (!tenant) {
      throw new ApiError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }
    const currentTier = tenant.tier;

    // Count-then-insert under a per-(tenant, feature) advisory lock.
    // Returns one of:
    //   { status: 'created', row }
    //   { status: 'locked' }       — concurrent in-flight request, treat as full
    //   { status: 'limited', retryAfterSeconds }
    const result = await runInTransaction(async (manager) => {
      const lockRows: Array<{ got: boolean }> = await manager.query(
        `SELECT pg_try_advisory_xact_lock(
           hashtext('demand_signal_rate:' || $1::text || ':' || $2::text)
         ) AS got`,
        [tenantId, feature]
      );
      if (!lockRows[0]?.got) {
        return { status: 'locked' as const };
      }

      const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);

      const countRows: Array<{ count: string }> = await manager.query(
        `SELECT COUNT(*)::text AS count
           FROM chatbot_demand_signals
          WHERE tenant_id = $1
            AND feature = $2
            AND created_at > $3`,
        [tenantId, feature, windowStart]
      );
      const currentCount = parseInt(countRows[0]?.count ?? '0', 10);

      if (currentCount >= RATE_LIMIT_COUNT) {
        // Compute seconds until the oldest in-window row falls out.
        const oldestRows: Array<{ created_at: Date }> = await manager.query(
          `SELECT created_at
             FROM chatbot_demand_signals
            WHERE tenant_id = $1
              AND feature = $2
              AND created_at > $3
            ORDER BY created_at ASC
            LIMIT 1`,
          [tenantId, feature, windowStart]
        );
        let retryAfterSeconds = 60;
        const oldest = oldestRows[0]?.created_at;
        if (oldest) {
          const oldestTime = oldest instanceof Date ? oldest.getTime() : new Date(oldest).getTime();
          const expiresAt = oldestTime + RATE_LIMIT_WINDOW_MS;
          retryAfterSeconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
        }
        return { status: 'limited' as const, retryAfterSeconds };
      }

      const insertRows: Array<DemandSignal> = await manager.query(
        `INSERT INTO chatbot_demand_signals (tenant_id, feature, current_tier, locale, context)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING id, tenant_id AS "tenantId", feature, current_tier AS "currentTier",
                   locale, context, created_at AS "createdAt"`,
        [tenantId, feature, currentTier, locale, JSON.stringify(context ?? {})]
      );

      return { status: 'created' as const, row: insertRows[0] };
    });

    if (result.status === 'locked') {
      logger.info('Demand signal rate-limit: concurrent in-flight', { tenantId, feature });
      res.setHeader('Retry-After', '60');
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Another notify-me request is in flight. Please retry shortly.',
        },
      });
      return;
    }

    if (result.status === 'limited') {
      logger.info('Demand signal rate-limit: window full', {
        tenantId,
        feature,
        retryAfterSeconds: result.retryAfterSeconds,
      });
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Notify-me limit reached for this feature. Retry in ${result.retryAfterSeconds}s.`,
          details: { retryAfterSeconds: result.retryAfterSeconds },
        },
      });
      return;
    }

    sendCreated(res, result.row);
  })
);

export default router;
