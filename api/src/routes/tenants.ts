/**
 * Tenant Routes
 * Tenant management and configuration
 *
 * This file owns the router and the route table. The member, invite,
 * onboarding and webhook handlers live in sibling leaf modules
 * (`tenant-*.handlers.ts`) and are registered below.
 */

import crypto from "crypto";
import { assertSafeOutboundUrl } from "../security/ssrf-guard";
import { Router, type Request, type Response } from "express";
import { AppDataSource } from "../database/data-source";
import { Tenant } from "../database/entities/Tenant";
import { ChatSession } from "../database/entities/ChatSession";
import {
  requireAdmin,
  asyncHandler,
  NotFoundError,
  BadRequestError,
  ApiError,
} from "../middleware";
import { ERROR_CODES } from "../middleware/error-codes";
import { sendSuccess } from "../utils/response";
import {
  requireClerkAuth,
  autoProvision,
} from "../middleware/clerk.middleware";
import { updateClerkOrganization } from "../services/clerk-sync.service";
import { logger } from "../utils/logger";
import { invalidate } from "../utils/cache";
import { requireFeature } from "../billing/enforce";
import {
  getAnchorBotConfig,
  updateAnchorBotSettings,
  AnchorBotMissingError,
} from "../services/bot-config.service";
import type { BotSettings } from "../database/entities/Bot";
import { AvailabilityRule } from "../database/entities/AvailabilityRule";
import { businessHoursToAvailability } from "../booking/sync-hours-from-bot";
import { parseDefaultTakeoverHours } from "../services/inbox-prefs.service";
import { SUPPORTED_LOCALES, type SupportedLocale } from "../schemas/user.schema";
import { presentTenantSettings } from "./tenant-settings-view";
import {
  listTenantUsers,
  createTenantUser,
  updateTenantUserRole,
  deactivateTenantUser,
  reactivateTenantUser,
} from "./tenant-members.handlers";
import {
  inviteTenantUser,
  listPendingInvites,
  resendPendingInvite,
  cancelPendingInvite,
} from "./tenant-invites.handlers";
import {
  getTenantOnboardingStatus,
  getTenantAvailableTools,
} from "./tenant-onboarding.handlers";
import {
  testTenantWebhook,
  regenerateTenantWebhookSecret,
} from "./tenant-webhooks.handlers";

export { computeOnboardingStatus } from "./tenant-onboarding.handlers";

function generateApiKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * One-way sync onto the slot engine (same as PATCH /bots/:id): onboarding
 * writes businessHours to the anchor bot only; without this the spoken
 * hours and the bookable slots would drift until a bot-form save.
 */
async function syncAvailabilityFromBusinessHours(
  tenantId: string,
): Promise<void> {
  try {
    const { bot: anchor } = await getAnchorBotConfig(tenantId);
    const merged = anchor.settings?.businessHours;
    if (merged && merged.enabled) {
      const rule = await AppDataSource.getRepository(AvailabilityRule).findOne({
        where: { botId: anchor.id },
      });
      if (rule) {
        const mapped = businessHoursToAvailability(merged);
        rule.weeklyHours = mapped.weeklyHours;
        rule.dateOverrides = mapped.dateOverrides;
        await AppDataSource.getRepository(AvailabilityRule).save(rule);
      }
    }
  } catch (err) {
    if (!(err instanceof AnchorBotMissingError)) throw err;
  }
}

/** Body shape of the keys PATCH /tenants/me accepts under `settings`. */
interface TenantSettingsBody {
  ai?: unknown;
  skills?: unknown;
  automations?: unknown;
  theme?: BotSettings["theme"];
  widget?: BotSettings["widget"];
  features?: BotSettings["features"];
  integrations?: BotSettings["integrations"];
  businessHours?: Record<string, unknown>;
  inbox?: { defaultTakeoverHours?: unknown };
  businessLanguage?: unknown;
}

/**
 * The tenant name IS the business name shown to customers and used by the AI
 * ({businessName}); a rename must also propagate to the Clerk organization so
 * the two never drift. Sync FIRST, then persist locally — if Clerk rejects it,
 * fail the request rather than leave the two out of sync.
 */
async function applyTenantRename(tenant: Tenant, name: string): Promise<void> {
  if (tenant.clerkOrgId) {
    const synced = await updateClerkOrganization(tenant.clerkOrgId, { name });
    if (!synced) {
      throw new ApiError(
        "Could not rename the organization right now. Please try again.",
        502,
        ERROR_CODES.UPSTREAM_FAILED,
      );
    }
  }
  tenant.name = name;
}

/**
 * The webhook URL is the legacy external-n8n escape hatch: setting it routes the
 * whole bot to an external endpoint (losing booking/chips/guardrails). Callers
 * gate on super_admin before reaching here.
 */
function applyWebhookUrl(tenant: Tenant, webhookUrl: string): void {
  // Reject non-public / non-https webhook URLs up front (SSRF #A). Empty
  // string clears the webhook (preserved).
  if (webhookUrl) {
    try {
      assertSafeOutboundUrl(webhookUrl);
    } catch {
      throw new BadRequestError("Webhook URL must be a public https:// URL");
    }
  }
  tenant.webhookUrl = webhookUrl;
  // Auto-generate webhook secret on first webhookUrl save
  if (webhookUrl && !tenant.webhookSecret) {
    tenant.webhookSecret = crypto.randomBytes(32).toString("hex");
  }
}

/** Sections that own dedicated endpoints are rejected on the generic PATCH. */
function rejectDelegatedSettingsSections(settings?: TenantSettingsBody): void {
  if (settings?.ai !== undefined) {
    throw new BadRequestError(
      "AI settings cannot be updated via this endpoint. Use PATCH /tenants/me/ai-settings instead.",
    );
  }

  if (settings?.skills !== undefined) {
    throw new BadRequestError(
      "Skills cannot be updated via this endpoint. Use /tenants/me/skills instead.",
    );
  }

  if (settings?.automations !== undefined) {
    throw new BadRequestError(
      "Automations cannot be updated via this endpoint. Use /tenants/me/automations instead.",
    );
  }
}

function applyInboxPrefs(tenant: Tenant, settings: TenantSettingsBody): void {
  const parsed = parseDefaultTakeoverHours(settings.inbox?.defaultTakeoverHours);
  if (parsed === null) {
    throw new BadRequestError(
      'defaultTakeoverHours must be an integer 1–24 or "indefinite"',
    );
  }
  tenant.settings = {
    ...(tenant.settings ?? {}),
    inbox: { defaultTakeoverHours: parsed },
  };
}

/**
 * The language internal notification emails are written in. Customer-facing copy never
 * reads it, so this is a business preference and not a customer one. Stored on the tenant
 * because one business has one internal language, whatever bot took the booking.
 */
function applyBusinessLanguage(tenant: Tenant, settings: TenantSettingsBody): void {
  const raw = settings.businessLanguage;
  const parsed = typeof raw === "string" ? raw.trim().toLowerCase() : null;
  if (!parsed || !(SUPPORTED_LOCALES as readonly string[]).includes(parsed)) {
    throw new BadRequestError("businessLanguage must be one of en, nl, fr");
  }
  tenant.settings = {
    ...(tenant.settings ?? {}),
    businessLanguage: parsed as SupportedLocale,
  };
}

/**
 * Multi-bot Phase 4 (#16d): per-bot config (theme/widget/features/
 * integrations/etc.) now lives on Bot.settings. Build a patch with only the
 * moved keys present in the request body; ai/skills/automations are rejected
 * by rejectDelegatedSettingsSections and never relayed here.
 */
async function buildAnchorBotPatch(
  settings: TenantSettingsBody,
  withDerivedTimezone: (
    bh: Record<string, unknown>,
  ) => Promise<BotSettings["businessHours"]>,
): Promise<Partial<BotSettings>> {
  const botPatch: Partial<BotSettings> = {};
  if (settings.theme !== undefined) botPatch.theme = settings.theme;
  if (settings.widget !== undefined) botPatch.widget = settings.widget;
  if (settings.features !== undefined) botPatch.features = settings.features;
  if (settings.integrations !== undefined)
    botPatch.integrations = settings.integrations;
  if (settings.businessHours !== undefined) {
    botPatch.businessHours = await withDerivedTimezone(settings.businessHours);
  }
  return botPatch;
}


async function businessHoursWithDerivedTimezone(
  tenantId: string,
  bh: Record<string, unknown>,
): Promise<BotSettings["businessHours"]> {
  const { bot: anchor } = await getAnchorBotConfig(tenantId);
  const derived = anchor.businessTimezone || "Europe/Brussels";
  if (
    typeof bh.timezone === "string" &&
    bh.timezone &&
    bh.timezone !== derived
  ) {
    logger.warn(
      "[BusinessTimezone] client-sent businessHours.timezone conflicts with the derived value — ignored",
      {
        tenantId,
        botId: anchor.id,
        received: bh.timezone,
        derived,
      },
    );
  }
  return { ...bh, timezone: derived } as BotSettings["businessHours"];
}

async function applyTenantMePatch(
  tenant: Tenant,
  tenantId: string,
  input: {
    name?: string;
    settings?: TenantSettingsBody;
    webhookUrl?: string;
    businessHours?: Record<string, unknown>;
    userRole: string;
  },
): Promise<void> {
  const { name, settings, webhookUrl, businessHours, userRole } = input;

  if (name && name !== tenant.name) {
    await applyTenantRename(tenant, name);
  }
  if (webhookUrl !== undefined && userRole === "super_admin") {
    applyWebhookUrl(tenant, webhookUrl);
  }

  rejectDelegatedSettingsSections(settings);

  if (settings?.theme !== undefined) {
    await requireFeature(
      tenantId,
      "customWidgetAppearance",
      "plan_limit_custom_branding",
    );
  }

  if (settings?.inbox !== undefined) {
    applyInboxPrefs(tenant, settings);
  }

  if (settings?.businessLanguage !== undefined) {
    applyBusinessLanguage(tenant, settings);
  }

  if (settings) {
    const botPatch = await buildAnchorBotPatch(
      settings,
      (bh) => businessHoursWithDerivedTimezone(tenantId, bh),
    );
    if (Object.keys(botPatch).length > 0) {
      await updateAnchorBotSettings(tenantId, botPatch);
    }
  }

  if (businessHours) {
    const { settings: currentBot } = await getAnchorBotConfig(tenantId);
    await updateAnchorBotSettings(tenantId, {
      businessHours: await businessHoursWithDerivedTimezone(tenantId, {
        ...(currentBot.businessHours ?? {}),
        ...businessHours,
      }),
    });
  }

  if (businessHours || settings?.businessHours !== undefined) {
    await syncAvailabilityFromBusinessHours(tenantId);
  }
}

const router = Router();

/**
 * Get current tenant
 * GET /api/v1/tenants/me
 */
router.get(
  "/me",
  requireClerkAuth,
  autoProvision,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const isAdmin =
      req.user?.role === "admin" || req.user?.role === "super_admin";

    const tenantRepository = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundError("Tenant not found");
    }

    // Multi-bot Phase 4 (#16d): hydrate settings response from anchor Bot,
    // not Tenant.settings. Tenant retains only `ai.apiKey` (the secret) and
    // legacy rollback values. The apiKey is merged in solely to render the
    // `hasApiKey` boolean — the secret never leaves the server.
    let botSettings: BotSettings = {};
    try {
      ({ settings: botSettings } = await getAnchorBotConfig(tenantId));
    } catch (err) {
      if (!(err instanceof AnchorBotMissingError)) throw err;
      // No anchor yet (very early tenant) — fall back to empty settings.
      logger.warn(
        "Anchor bot missing during GET /tenants/me — returning empty settings",
        { tenantId },
      );
    }
    const settings = presentTenantSettings(botSettings, tenant);

    // Check if tenant has any widget sessions (for onboarding status)
    const sessionRepo = AppDataSource.getRepository(ChatSession);
    const widgetUsed = await sessionRepo
      .createQueryBuilder("s")
      .where("s.tenant_id = :tenantId", { tenantId })
      .andWhere("s.source = :source", { source: "widget" })
      .andWhere("s.deleted_at IS NULL")
      .getExists();

    sendSuccess(res, {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      apiKey: tenant.apiKey,
      tier: tenant.tier,
      status: tenant.status,
      settings,
      maxSessions: tenant.maxSessions,
      currentSessions: tenant.currentSessions,
      webhookUrl: tenant.webhookUrl,
      // The inbound-webhook HMAC secret is returned ONLY to admins (the portal
      // Integrations page surfaces it); non-admin members previously received it
      // here and could forge inbound webhooks. See security audit #3.
      hasWebhookSecret: !!tenant.webhookSecret,
      ...(isAdmin ? { webhookSecret: tenant.webhookSecret } : {}),
      customDomain: tenant.customDomain,
      createdAt: tenant.createdAt,
      onboarding: {
        widgetUsed,
      },
    });
  }),
);

/**
 * Update tenant
 * PATCH /api/v1/tenants/me
 */
router.patch(
  "/me",
  requireClerkAuth,
  autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const { name, settings, webhookUrl, businessHours } = req.body;

    const tenantRepository = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundError("Tenant not found");
    }

    await applyTenantMePatch(tenant, tenantId, {
      name,
      settings,
      webhookUrl,
      businessHours,
      userRole: req.user!.role,
    });

    await tenantRepository.save(tenant);

    // A first-time webhook secret may have just been auto-generated above; drop
    // any cached secret (see n8n/webhook.controller verifyPerTenantSecret) so
    // inbound webhooks don't keep validating against a stale `null` for the TTL.
    await invalidate(`tenant:webhook-secret:${tenantId}`);
    // Drop the coalescer's custom-webhook routing cache (turn-coalescer.ts
    // usesCustomWebhook) so a just-added/removed webhookUrl takes effect
    // immediately instead of mis-routing for up to the 60s TTL.
    await invalidate(`coalescer:custom-webhook:${tenantId}`);

    logger.info("Tenant updated", {
      tenantId,
      updates: { name, webhookUrl: !!webhookUrl, settings: !!settings },
    });

    // Build response settings from the freshly-saved anchor bot so the client
    // sees the post-write state authoritatively (no read/write asymmetry).
    let responseBotSettings: BotSettings = {};
    try {
      ({ settings: responseBotSettings } = await getAnchorBotConfig(tenantId));
    } catch (err) {
      if (!(err instanceof AnchorBotMissingError)) throw err;
    }
    const responseSettings = presentTenantSettings(responseBotSettings, tenant);

    sendSuccess(res, {
      id: tenant.id,
      name: tenant.name,
      settings: responseSettings,
      webhookUrl: tenant.webhookUrl,
      webhookSecret: tenant.webhookSecret,
      updatedAt: tenant.updatedAt,
    });
  }),
);

router.get(
  "/me/users",
  requireClerkAuth,
  autoProvision,
  requireAdmin,
  listTenantUsers,
);

router.post(
  "/me/users",
  requireClerkAuth,
  autoProvision,
  requireAdmin,
  createTenantUser,
);

/**
 * Rotate API key
 * POST /api/v1/tenants/me/api-key/rotate
 */
router.post(
  "/me/api-key/rotate",
  requireClerkAuth,
  autoProvision,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;

    const tenantRepository = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundError("Tenant not found");
    }

    // Generate new API key
    const newApiKey = generateApiKey();
    tenant.apiKey = newApiKey;

    await tenantRepository.save(tenant);

    logger.info("API key rotated", { tenantId });

    sendSuccess(res, {
      apiKey: newApiKey,
      message:
        "API key rotated successfully. Store this key safely as it will not be shown again.",
    });
  }),
);

/**
 * Get tenant stats
 * GET /api/v1/tenants/me/stats
 */
router.get(
  "/me/stats",
  requireClerkAuth,
  autoProvision,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;

    const sessionStats = await AppDataSource.query(
      `
      SELECT 
        COUNT(*) as total_sessions,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active_sessions,
        COUNT(CASE WHEN status = 'closed' THEN 1 END) as closed_sessions,
        COUNT(CASE WHEN status = 'waiting' THEN 1 END) as waiting_sessions,
        AVG(duration_seconds) as avg_duration,
        AVG(satisfaction_rating) as avg_satisfaction
      FROM chat_sessions
      WHERE tenant_id = $1
    `,
      [tenantId],
    );

    const messageStats = await AppDataSource.query(
      `
      SELECT 
        COUNT(*) as total_messages,
        COUNT(CASE WHEN type = 'text' THEN 1 END) as text_messages,
        COUNT(CASE WHEN type = 'image' THEN 1 END) as image_messages,
        COUNT(CASE WHEN type = 'file' THEN 1 END) as file_messages
      FROM messages
      WHERE tenant_id = $1
    `,
      [tenantId],
    );

    const todaySessions = await AppDataSource.query(
      `
      SELECT COUNT(*) as count
      FROM chat_sessions
      WHERE tenant_id = $1 AND DATE(created_at) = CURRENT_DATE
    `,
      [tenantId],
    );

    sendSuccess(res, {
      sessions: {
        total: parseInt(sessionStats[0].total_sessions, 10),
        active: parseInt(sessionStats[0].active_sessions, 10),
        closed: parseInt(sessionStats[0].closed_sessions, 10),
        waiting: parseInt(sessionStats[0].waiting_sessions, 10),
        today: parseInt(todaySessions[0].count, 10),
        avgDuration: Math.round(sessionStats[0].avg_duration || 0),
        avgSatisfaction: parseFloat(sessionStats[0].avg_satisfaction || 0),
      },
      messages: {
        total: parseInt(messageStats[0].total_messages, 10),
        text: parseInt(messageStats[0].text_messages, 10),
        images: parseInt(messageStats[0].image_messages, 10),
        files: parseInt(messageStats[0].file_messages, 10),
      },
    });
  }),
);

router.post(
  "/me/webhook-test",
  requireClerkAuth,
  autoProvision,
  requireAdmin,
  testTenantWebhook,
);

router.post(
  "/me/webhook-secret/regenerate",
  requireClerkAuth,
  autoProvision,
  requireAdmin,
  regenerateTenantWebhookSecret,
);

router.post(
  "/me/invite",
  requireClerkAuth,
  autoProvision,
  requireAdmin,
  inviteTenantUser,
);

router.patch(
  "/me/users/:userId",
  requireClerkAuth,
  autoProvision,
  requireAdmin,
  updateTenantUserRole,
);

router.post(
  "/me/users/:userId/deactivate",
  requireClerkAuth,
  autoProvision,
  requireAdmin,
  deactivateTenantUser,
);

router.post(
  "/me/users/:userId/reactivate",
  requireClerkAuth,
  autoProvision,
  requireAdmin,
  reactivateTenantUser,
);

router.get(
  "/me/pending-invites",
  requireClerkAuth,
  autoProvision,
  requireAdmin,
  listPendingInvites,
);

router.post(
  "/me/pending-invites/:id/resend",
  requireClerkAuth,
  autoProvision,
  requireAdmin,
  resendPendingInvite,
);

router.delete(
  "/me/pending-invites/:id",
  requireClerkAuth,
  autoProvision,
  requireAdmin,
  cancelPendingInvite,
);

router.get(
  "/me/onboarding-status",
  requireClerkAuth,
  autoProvision,
  getTenantOnboardingStatus,
);

router.get(
  "/me/available-tools",
  requireClerkAuth,
  autoProvision,
  getTenantAvailableTools,
);

export { router as tenantRouter };
