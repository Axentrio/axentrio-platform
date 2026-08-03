/**
 * Onboarding — the first-run setup a new customer walks through.
 *
 * This slice carries one endpoint: look a company up from its VAT number so signup can
 * fill in the tedious fields and turn away obvious fakes.
 */
import { Router, Request, Response } from 'express';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { asyncHandler, ApiError } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';
import { getRedisClient } from '../config/redis';
import { logger } from '../utils/logger';
import { lookupCompanyByVat } from '../integrations/company-lookup/company-lookup.service';

const router = Router();
router.use(requireClerkAuth, autoProvision);

/**
 * Distinct lookups allowed per user per hour.
 *
 * This endpoint spends someone else's resource — every miss is a multi-second call to a
 * European Commission service — so it cannot be an open proxy just because the caller
 * signed in. Repeats are free (the service caches, including negative answers), so this
 * only bites on a loop over invented numbers, which is the case worth stopping. Thirty
 * is far more than a genuine signup needs and far less than a useful scraper.
 */
const LOOKUPS_PER_HOUR = 30;
const WINDOW_SECONDS = 3600;

/**
 * Fails OPEN, matching the house pattern: Redis being down must not stop people signing
 * up. That is the same trade the lookup itself makes about VIES — an unverified company
 * record is a far smaller problem than a signup nobody can complete.
 */
async function withinLookupBudget(userId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return true;
  try {
    const key = `onboarding:lookup:${userId}`;
    const [[, count]] = (await redis.multi().incr(key).expire(key, WINDOW_SECONDS).exec()) as Array<
      [Error | null, number]
    >;
    return Number(count) <= LOOKUPS_PER_HOUR;
  } catch (err) {
    logger.warn('[onboarding] lookup budget check failed, allowing', {
      error: err instanceof Error ? err.message : 'unknown',
    });
    return true;
  }
}

/**
 * GET /onboarding/company-lookup?vat=BE0400378485
 *
 * Always 200 with a status the caller can act on. The four outcomes are deliberately
 * NOT errors: `not_found` is a real answer about a real number, and `unavailable` means
 * the register is slow or down — neither is the customer's fault and neither should be
 * rendered as a failure they have to solve. Only exceeding the budget is a 429.
 */
router.get(
  '/company-lookup',
  asyncHandler(async (req: Request, res: Response) => {
    const vat = String(req.query.vat ?? '').trim();

    if (!(await withinLookupBudget(req.userId!))) {
      throw new ApiError('Too many company lookups. Try again shortly.', 429, 'RATE_LIMITED');
    }

    const result = await lookupCompanyByVat(vat, { redis: getRedisClient() });
    sendSuccess(res, result);
  }),
);

export default router;
