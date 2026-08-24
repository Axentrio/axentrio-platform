/**
 * Tenant onboarding handlers
 *
 * Onboarding-progress computation plus the two read-only endpoints the portal
 * banner and the bot-config screens use. Registered by routes/tenants.ts.
 */

import { type Request, type Response } from "express";
import { AppDataSource } from "../database/data-source";
import { Tenant } from "../database/entities/Tenant";
import { asyncHandler, NotFoundError } from "../middleware";
import { sendSuccess } from "../utils/response";
import {
  getAnchorBotConfig,
  AnchorBotMissingError,
} from "../services/bot-config.service";
import type { BotSettings } from "../database/entities/Bot";

export function computeOnboardingStatus(
  tenant: any,
  kbDocCount: number,
  hadConversation = false,
  orgName?: string,
) {
  const settings = tenant.settings || {};
  const ai = settings.ai || {};
  const automations = settings.automations || {};
  const bv = ai.brandVoice;

  // A new tenant's anchor bot ships with brandVoice.name = `${orgName} Assistant`
  // (see defaultBotAi), so the old `!== 'Organization Assistant'` sentinel marked
  // every real tenant "configured" on day one. Treat brand voice as configured only
  // if the user actually personalised it: custom instructions, a business name, a
  // non-default tone, or a name that differs from the generated default (and the
  // legacy default literal).
  const defaultBrandName = orgName ? `${orgName} Assistant` : null;

  // Cal.com is shelved, so the former `calcomConnected` onboarding step is gone.
  const steps = {
    aiEnabled: !!ai.enabled,
    brandVoiceConfigured: !!(
      bv?.customInstructions?.trim() ||
      bv?.businessName?.trim() ||
      (bv?.tone && bv.tone !== "friendly") ||
      (bv?.name &&
        bv.name !== "Organization Assistant" &&
        bv.name !== defaultBrandName)
    ),
    knowledgeBaseHasDocs: kbDocCount > 0,
    automationsConfigured: !!(
      automations.emailNotifications?.bookingConfirmation?.enabled ||
      automations.emailNotifications?.newLeadAlert?.enabled ||
      automations.emailNotifications?.conversationSummary?.enabled
    ),
    // The point of onboarding is a *working* bot, not just a configured one — so
    // track whether the bot has actually answered at least once (a persisted bot
    // reply exists; see the route handler for the exact signal). This is the
    // "time to first useful answer" metric; the banner uses it to steer new
    // tenants to try their bot rather than stalling at setup steps.
    firstConversation: hadConversation,
  };

  const totalCount = Object.keys(steps).length;
  const completedCount = Object.values(steps).filter(Boolean).length;

  return {
    complete: completedCount === totalCount,
    completedCount,
    totalCount,
    steps,
  };
}

/**
 * Get onboarding status
 * GET /api/v1/tenants/me/onboarding-status
 */
export const getTenantOnboardingStatus = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const tenant = await AppDataSource.getRepository(Tenant).findOne({
      where: { id: tenantId },
    });
    if (!tenant) throw new NotFoundError("Tenant not found");

    const kbResult = await AppDataSource.query(
      `SELECT COUNT(*)::int AS count FROM knowledge_documents WHERE "tenantId" = $1 AND status = 'indexed'`,
      [tenantId],
    ).catch(() => [{ count: 0 }]);

    // Multi-bot Phase 4 (#16d): onboarding steps inspect ai/integrations/
    // automations — all on Bot.settings. Pass the anchor bot's settings into
    // computeOnboardingStatus (the function expects `{ settings }` shape).
    let botSettings: BotSettings = {};
    try {
      ({ settings: botSettings } = await getAnchorBotConfig(tenantId));
    } catch (err) {
      if (!(err instanceof AnchorBotMissingError)) throw err;
    }

    // "First conversation" = the bot has actually ANSWERED a prompt at least once:
    // a persisted bot text message that FOLLOWS a user message in the same session.
    // We can't use a bare bot-message-exists check because /widget/init persists a
    // bot *greeting* before the visitor types anything (widget.ts), and we can't use
    // `chat_sessions.message_count > 0` because that flips on the visitor's inbound
    // message alone (unanswered prompt / LLM failure / AI-disabled). The ephemeral
    // in-portal test chat does NOT persist, so only real conversations (embedded
    // widget / connected channel / standalone /widget-test) count. Fail-safe to
    // false so a query error never blocks the rest of onboarding status.
    const convResult = await AppDataSource.query(
      `SELECT EXISTS(
         SELECT 1
         FROM messages bm
         JOIN participants bp ON bp.id = bm.participant_id
         WHERE bm.tenant_id = $1
           AND bp.type = 'bot' AND bm.type = 'text' AND bm.is_deleted = false
           AND EXISTS (
             SELECT 1
             FROM messages um
             JOIN participants up ON up.id = um.participant_id
             WHERE um.session_id = bm.session_id
               AND up.type = 'user' AND um.is_deleted = false
               AND (um.created_at, um.id) < (bm.created_at, bm.id)
           )
       ) AS has`,
      [tenantId],
    ).catch(() => [{ has: false }]);

    const status = computeOnboardingStatus(
      { settings: botSettings },
      kbResult[0]?.count || 0,
      !!convResult[0]?.has,
      tenant.name,
    );
    sendSuccess(res, status);
  },
);

/**
 * Get available tools for the tenant
 * GET /api/v1/tenants/me/available-tools
 */
export const getTenantAvailableTools = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const tenant = await AppDataSource.getRepository(Tenant).findOne({
      where: { id: tenantId },
    });
    if (!tenant) throw new NotFoundError("Tenant not found");

    // Multi-bot Phase 4 (#16d): tool registry resolves integrations from
    // Bot.settings now. Anchor bot drives the tenant-level tool list.
    const { settings: botSettings } = await getAnchorBotConfig(tenantId);

    const { ToolRegistry } = await import("../agent/tool-registry");
    const registry = new ToolRegistry();
    const tools = await registry.getToolsForTenant(tenant, botSettings);

    sendSuccess(res, {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        hasSideEffects: t.hasSideEffects,
        category: ["kb_search", "capture_lead", "escalate_to_human"].includes(
          t.name,
        )
          ? "always"
          : "booking",
      })),
    });
  },
);
