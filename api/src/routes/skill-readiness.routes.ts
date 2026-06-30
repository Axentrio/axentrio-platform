/**
 * GET /bots/:botId/skill-readiness — advisory per-skill state + remedy for a bot
 * (composable-templates Phase 6). Read-only: tenants see "Bookings — finish setup",
 * "Lead capture — upgrade plan" etc. alongside their template bindings.
 *
 * Kept in its own router (mounted on the same `/bots` base as the bot CRUD routes
 * with the same middleware stack) so this additive endpoint never touches the
 * bots.routes.ts file. Read is admin/supervisor, mirroring `/bots/:id/templates`.
 *
 * Fails CLOSED: a readiness compute error 5xxes (asyncHandler) rather than paint a
 * misleading "ready" — see modules/bot-skill-readiness.ts for the error policy.
 */
import { Router, Request, Response } from 'express';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { requireRole } from '../middleware/auth.middleware';
import { asyncHandler, NotFoundError } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';
import { getOwnedBot, BotNotFoundConfigError } from '../services/bot-config.service';
import { computeBotSkillReadiness } from '../modules/bot-skill-readiness';
import type { SkillReadinessResponse } from '../contracts/skill-readiness';

const router = Router();
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

router.get(
  '/:botId/skill-readiness',
  requireRole('admin', 'supervisor'),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const tenantId = (req as Request & { tenantId: string }).tenantId;
    let bot;
    try {
      bot = await getOwnedBot(req.params.botId, tenantId);
    } catch (err) {
      if (err instanceof BotNotFoundConfigError) throw new NotFoundError('Bot not found');
      throw err;
    }
    const payload: SkillReadinessResponse = await computeBotSkillReadiness(bot, tenantId);
    sendSuccess(res, payload);
  }),
);

export default router;
