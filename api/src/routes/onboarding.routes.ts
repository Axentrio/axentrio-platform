/**
 * Onboarding — the first-run setup a new customer walks through.
 *
 *   GET  /company-lookup  fills the tedious fields from a VAT number, and turns away
 *                         obvious fakes.
 *   GET  /status          what the wizard renders and what the routing guard reads.
 *   PUT  /step            record one answer and advance.
 *   POST /complete        finish, refused while anything required is outstanding.
 *   POST /restart         re-open the wizard from the first step, without wiping
 *                         documents, chats, or billing.
 *
 * The state itself is data on the tenant, not a table: it is written once during setup,
 * read on every page load, and never queried across tenants. The RULES live in
 * onboarding/onboarding-state.ts — pure, and shared with the wizard — so what "can they
 * continue" means is decided in exactly one place rather than re-derived per screen.
 */
import { Router, Request, Response } from 'express';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { requireRole } from '../middleware/auth.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler, ApiError } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';
import { getRedisClient } from '../config/redis';
import { logger } from '../utils/logger';
import { lookupCompanyByVat } from '../integrations/company-lookup/company-lookup.service';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { KnowledgeDocument } from '../database/entities/KnowledgeDocument';
import { getAnchorBotConfig, replaceAnchorBotSettingsSection } from '../services/bot-config.service';
import { invalidateEntitlementsAndModules } from '../modules';
import { logAudit } from '../utils/audit';
import { prefillAccountInformation } from '../account/account-information';
import { getEntitlements } from '../billing/entitlements';
import {
  emptyState,
  isComplete,
  nextStep,
  restartOnboarding,
  validateStepSubmission,
  SKIP_DISABLES,
  type OnboardingState,
  type OnboardingStep,
  type StepOutcome,
} from '../onboarding/onboarding-state';

const router = Router();
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

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
    const count = Number(await redis.incr(key));
    // First hit only — see the escalation limiter. An unconditional expire would make
    // this a sliding window, so someone retrying a mistyped number would never get
    // their allowance back.
    if (count === 1) await redis.expire(key, WINDOW_SECONDS);
    return count <= LOOKUPS_PER_HOUR;
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


/** Read the stored state, or a fresh one for a workspace that has never started. */
async function loadState(tenantId: string): Promise<OnboardingState> {
  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
  const stored = (tenant?.settings as { onboarding?: OnboardingState } | null)?.onboarding;
  return stored ?? emptyState();
}

/**
 * Persist the state with a jsonb MERGE rather than a read-modify-write of `settings`.
 *
 * Several writers share that blob — theme, widget, business hours — and a whole-object
 * write from here would silently drop whatever any of them had just changed.
 */
async function saveState(tenantId: string, state: OnboardingState): Promise<void> {
  await AppDataSource.query(
    `UPDATE tenants
        SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('onboarding', $2::jsonb),
            updated_at = now()
      WHERE id = $1`,
    [tenantId, JSON.stringify(state)],
  );
}

/**
 * Skipping a feature step switches that feature OFF, through the same
 * `feature_toggles` column the Settings screen writes — so "not now" during setup and
 * "off" later are one decision, not two half-decisions.
 *
 */
async function applySkipEffects(tenantId: string, step: OnboardingStep): Promise<void> {
  // The website assistant is not an entitlement — it is `ai.enabled` on the tenant's
  // anchor bot — so declining it cannot go through the toggle map. It still has to
  // turn something off: a customer who said "not now" to a chatbot must not have one
  // answering their visitors.
  if (step === 'chatbot') {
    const { settings } = await getAnchorBotConfig(tenantId);
    await replaceAnchorBotSettingsSection(tenantId, 'ai', {
      ...(settings.ai ?? {}),
      enabled: false,
    } as NonNullable<typeof settings.ai>);
    return;
  }

  const keys = SKIP_DISABLES[step];
  if (!keys?.length) return;

  await writeFeatureToggles(
    tenantId,
    Object.fromEntries(keys.map((key) => [key, false])),
  );
}

async function writeFeatureToggles(
  tenantId: string,
  changes: Record<string, boolean>,
): Promise<void> {
  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
  const current = (tenant?.featureToggles ?? {}) as Record<string, boolean>;
  const next = { ...current, ...changes };

  await AppDataSource.query(
    `UPDATE tenants SET feature_toggles = $2::jsonb, updated_at = now() WHERE id = $1`,
    [tenantId, JSON.stringify(next)],
  );
  // Feature-gated modules cache their active list, so a toggle-off that skips this
  // leaves the bot holding tools for a feature the tenant just declined.
  await invalidateEntitlementsAndModules(tenantId);
}

async function applyDoneEffects(tenantId: string, step: OnboardingStep): Promise<void> {
  if (step !== 'bookings') return;
  const { entitledFeatures } = await getEntitlements(tenantId);
  await writeFeatureToggles(tenantId, {
    bookings: entitledFeatures.bookings === true,
  });
}

/**
 * Required steps that are backed by a real artifact, not just a click.
 *
 * `documents` is the one that matters: the reason it cannot be skipped is that a
 * workspace with no knowledge has a bot that cannot answer anything. Accepting `done` on
 * the client's word would make the requirement decorative — the wizard would simply post
 * it and move on. So the server checks the workspace actually has a document.
 *
 * The other required steps carry their evidence in the request itself (a language, a
 * company record), and are validated where they are read.
 */
async function evidenceFor(tenantId: string, step: OnboardingStep): Promise<string | null> {
  if (step !== 'documents') return null;
  const docs = await AppDataSource.getRepository(KnowledgeDocument).count({ where: { tenantId } });
  return docs > 0 ? null : 'Upload at least one document so your assistant has something to answer from';
}

/**
 * GET /onboarding/status
 * What the wizard renders, and what the routing guard reads to decide whether the rest
 * of the product is reachable yet.
 *
 * Deliberately open to any member, unlike the writes below. Every user's app shell calls
 * this on load; a 403 for non-admins would be read by the guard as "unknown", and the
 * safe reading of unknown is "send them to setup" — which would trap an agent in a wizard
 * they are not allowed to complete.
 */
router.get(
  '/status',
  asyncHandler(async (req: Request, res: Response) => {
    const state = await loadState(req.tenantId!);
    sendSuccess(res, {
      state,
      nextStep: nextStep(state),
      complete: isComplete(state),
    });
  }),
);

/**
 * PUT /onboarding/step
 * Record one answer and advance.
 *
 * Body: `{ step, outcome: 'done' | 'skipped', language?, company? }`
 *
 * The rules live in onboarding-state.ts and are re-checked HERE rather than trusted
 * from the wizard — a client that posts `{ step: 'documents', outcome: 'skipped' }`
 * must be refused, or the required steps are decoration.
 *
 * Admin-only, matching PUT /feature-toggles: this writes the company record and can
 * switch features off, which is the same authority that route already requires.
 */
router.put(
  '/step',
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    const body = (req.body ?? {}) as {
      step?: OnboardingStep;
      outcome?: StepOutcome;
      language?: string;
      company?: OnboardingState['company'];
    };
    const step = body.step as OnboardingStep;
    const outcome = (body.outcome ?? 'done') as StepOutcome;

    const verdict = validateStepSubmission(step, outcome);
    if (!verdict.ok) throw new ApiError(verdict.reason, 400, 'BAD_REQUEST', { step });

    const state = await loadState(tenantId);

    if (step === 'language') {
      if (!['nl', 'fr', 'en'].includes(String(body.language))) {
        throw new ApiError('Choose Dutch, French or English', 400, 'BAD_REQUEST');
      }
      state.language = body.language as OnboardingState['language'];
    }

    if (step === 'company') {
      const c = body.company;
      if (!c?.vatNumber || !c.name) {
        throw new ApiError('A VAT number and company name are required', 400, 'BAD_REQUEST');
      }
      // `verified` is decided by the SERVER from the lookup, never accepted from the
      // client — otherwise "this company was confirmed by the register" means nothing.
      const check = await lookupCompanyByVat(c.vatNumber, { redis: getRedisClient() });
      const presence = c.presence === 'physical' || c.presence === 'online' ? c.presence : undefined;
      state.company = { ...c, presence, verified: check.status === 'found' };
      const account = prefillAccountInformation({ company: state.company });
      await AppDataSource.getRepository(Tenant).update(tenantId, {
        officialBusinessName: account.officialBusinessName,
        vatNumber: account.vatNumber,
        vatVerified: account.vatVerified,
        invoiceAddress: account.invoiceAddress,
      });
      // #153: quote the account address by default. Online-only businesses can
      // explicitly turn this off in the Agent settings.
      try {
        const { settings } = await getAnchorBotConfig(tenantId);
        if (settings.quotedAddress === undefined) {
          await replaceAnchorBotSettingsSection(tenantId, 'quotedAddress', { enabled: true });
        }
      } catch {
        /* anchor missing on a brand-new tenant — absent settings resolve default-on */
      }
    }

    if (outcome === 'done') {
      const missing = await evidenceFor(tenantId, step);
      if (missing) throw new ApiError(missing, 409, 'CONFLICT', { step });
    }

    state.steps[step] = outcome;
    if (outcome === 'skipped') await applySkipEffects(tenantId, step);
    if (outcome === 'done') await applyDoneEffects(tenantId, step);

    await saveState(tenantId, state);
    sendSuccess(res, { state, nextStep: nextStep(state), complete: isComplete(state) });
  }),
);

/**
 * POST /onboarding/complete
 * Finish setup. Refuses while anything required is outstanding — the wizard should
 * never offer this, but the wizard is not the guard.
 */
router.post(
  '/complete',
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    const state = await loadState(tenantId);

    const outstanding = nextStep(state);
    if (outstanding) {
      throw new ApiError('Setup is not finished yet', 409, 'CONFLICT', { nextStep: outstanding });
    }

    state.completedAt = state.completedAt ?? new Date().toISOString();
    await saveState(tenantId, state);
    await logAudit(req.userId!, 'tenant.onboarding_completed', 'tenant', tenantId, tenantId, {
      language: state.language,
      companyVerified: state.company?.verified ?? false,
    });

    sendSuccess(res, { state, nextStep: null, complete: true });
  }),
);

/**
 * POST /onboarding/restart
 * Re-open the wizard from the first step. Admin-only, same as the writes
 * above: this is what the routing guard reads, so a non-admin posting it
 * would lock their own team out of a product they cannot finish.
 *
 * Does not delete documents, chats, or billing. Feature toggles stay as they
 * are until the customer answers a skip or done step again.
 */
router.post(
  '/restart',
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId!;
    const previous = await loadState(tenantId);
    const state = restartOnboarding(previous);
    await saveState(tenantId, state);
    await logAudit(req.userId!, 'tenant.onboarding_restarted', 'tenant', tenantId, tenantId, {
      wasComplete: isComplete(previous),
      wasGrandfathered: previous.grandfathered === true,
    });
    sendSuccess(res, { state, nextStep: nextStep(state), complete: isComplete(state) });
  }),
);

export default router;
