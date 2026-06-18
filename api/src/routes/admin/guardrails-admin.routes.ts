/**
 * Super-admin guardrails operations — the operator cockpit for the shadow→enforce
 * rollout (.scratch/plan-platform-usage-readiness.md Slice A). All routes inherit
 * Clerk + autoProvision + super-admin from admin.routes.ts.
 *
 *   GET  /admin/guardrails/flagged   — recent flagged events (inbound + output)
 *   GET  /admin/guardrails/summary   — counts for the daily shadow review
 *   PUT  /admin/tenants/:id/guardrails — flip per-tenant enforce
 *
 * The global break-glass kill switch is the GUARDRAILS_KILL_SWITCH env var (see
 * isGuardrailsEnforcing) — when set, no tenant enforces regardless of its flag.
 */
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../../database/data-source';
import { Tenant } from '../../database/entities/Tenant';
import { SpamScamLog } from '../../database/entities/SpamScamLog';
import { GuardrailOutputLog } from '../../database/entities/GuardrailOutputLog';
import { ChatSession } from '../../database/entities/ChatSession';
import { HandoffRequest } from '../../database/entities/HandoffRequest';
import { asyncHandler, NotFoundError, ValidationError } from '../../middleware/error-handler';
import { sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';
import { invalidate } from '../../utils/cache';
import { logAudit } from '../../utils/audit';
import { redisLoopStore } from '../../guardrails/loop-store';

const router = Router();

interface FlaggedFilter {
  tenantId?: string;
  enforced?: boolean;
}

function parseFilter(req: Request): FlaggedFilter {
  const f: FlaggedFilter = {};
  if (typeof req.query.tenantId === 'string') f.tenantId = req.query.tenantId;
  if (req.query.enforced === 'true') f.enforced = true;
  else if (req.query.enforced === 'false') f.enforced = false;
  return f;
}

// GET /admin/guardrails/flagged — most-recent flagged events across BOTH logs,
// normalized into one feed. `source` filter (inbound|output) narrows it; the
// conversationId is the deep-link target for the inbox.
router.get(
  '/guardrails/flagged',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const filter = parseFilter(req);
    const source = req.query.source === 'inbound' || req.query.source === 'output' ? req.query.source : undefined;

    const wantInbound = source !== 'output';
    const wantOutput = source !== 'inbound';

    const [spam, output] = await Promise.all([
      wantInbound
        ? AppDataSource.getRepository(SpamScamLog).find({ where: filter, order: { createdAt: 'DESC' }, take: limit })
        : Promise.resolve([]),
      wantOutput
        ? AppDataSource.getRepository(GuardrailOutputLog).find({ where: filter, order: { createdAt: 'DESC' }, take: limit })
        : Promise.resolve([]),
    ]);

    const events = [
      ...spam.map((r) => ({
        source: 'inbound' as const,
        id: r.id,
        tenantId: r.tenantId,
        conversationId: r.conversationId,
        category: r.detectedCategory,
        reasons: r.reasons ?? [],
        enforced: r.enforced,
        createdAt: r.createdAt,
      })),
      ...output.map((r) => ({
        source: 'output' as const,
        id: r.id,
        tenantId: r.tenantId,
        conversationId: r.conversationId,
        category: (r.families ?? []).join(', '),
        reasons: r.reasons ?? [],
        enforced: r.enforced,
        createdAt: r.createdAt,
      })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);

    sendSuccess(res, { events });
  }),
);

// GET /admin/guardrails/conversations/:id — incident-response lookup (#9): a single
// conversation's enforcement state + BOTH guardrail journals + handoff state. Keyed
// by chat_sessions id (= the conversationId both journals carry). Cross-tenant —
// super-admin scope (the router enforces requireSuperAdmin), so NO tenant filter.
router.get(
  '/guardrails/conversations/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id;
    const session = await AppDataSource.getRepository(ChatSession).findOne({ where: { id } });
    if (!session) throw new NotFoundError('Conversation not found');

    const [inboundLogs, outputLogs, handoffs] = await Promise.all([
      AppDataSource.getRepository(SpamScamLog).find({ where: { conversationId: id }, order: { createdAt: 'DESC' }, take: 50 }),
      AppDataSource.getRepository(GuardrailOutputLog).find({ where: { conversationId: id }, order: { createdAt: 'DESC' }, take: 50 }),
      AppDataSource.getRepository(HandoffRequest).find({ where: { sessionId: id }, order: { createdAt: 'DESC' }, take: 50 }),
    ]);

    sendSuccess(res, {
      session: {
        id: session.id,
        tenantId: session.tenantId,
        status: session.status,
        aiAutoReplyEnabled: session.aiAutoReplyEnabled,
        guardrailStatus: session.guardrailStatus,
        assignedAgentId: session.assignedAgentId ?? null,
        channel: session.channel,
        lastActivityAt: session.lastActivityAt,
        createdAt: session.createdAt,
      },
      inboundLogs,
      outputLogs,
      handoffs,
    });
  }),
);

// POST /admin/guardrails/conversations/:id/resume-ai — the reversible incident action
// (#9): re-enable AI on a (possibly guardrail-paused) conversation. CROSS-TENANT by
// design (super-admin acting outside any one tenant context) — safe ONLY because this
// router is behind requireSuperAdmin; never expose on the tenant router. Audited
// (unlike the tenant-scoped /handoff/resume-ai) so the action is reversible-with-trail.
router.post(
  '/guardrails/conversations/:id/resume-ai',
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id;
    const repo = AppDataSource.getRepository(ChatSession);
    const session = await repo.findOne({ where: { id } });
    if (!session) throw new NotFoundError('Conversation not found');

    session.aiAutoReplyEnabled = true;
    session.guardrailStatus = 'normal';
    await repo.save(session);
    await redisLoopStore.clear(id).catch(() => {});

    await logAudit(req.userId!, 'guardrails.resume_ai', 'chat_session', id, session.tenantId, {
      via: 'incident-cockpit',
    });

    sendSuccess(res, {
      message: 'AI replies re-enabled',
      session: { id: session.id, aiAutoReplyEnabled: true, guardrailStatus: 'normal' },
    });
  }),
);

// GET /admin/guardrails/summary — totals + shadow/enforced split + top tenants and
// categories over the last N days, for tuning before flipping enforce.
router.get(
  '/guardrails/summary',
  asyncHandler(async (req: Request, res: Response) => {
    // Integer days, clamped — parameterized into the interval (no interpolation).
    const days = Math.min(Math.max(Math.floor(Number(req.query.days) || 7), 1), 90);
    const since = `now() - make_interval(days => $1::int)`;
    const q = <T = Record<string, unknown>>(sql: string) => AppDataSource.query(sql, [days]) as Promise<T[]>;

    const [inbound, output, byTenant] = await Promise.all([
      q(`SELECT detected_category AS category, enforced, count(*)::int AS n
           FROM guardrail_spam_logs WHERE created_at > ${since}
          GROUP BY 1,2 ORDER BY 3 DESC`),
      q(`SELECT fam AS category, enforced, count(*)::int AS n
           FROM guardrail_output_logs, jsonb_array_elements_text(families) AS fam
          WHERE created_at > ${since} GROUP BY 1,2 ORDER BY 3 DESC`),
      q(`SELECT u.tenant_id AS tenant_id, t.name AS tenant_name,
                COALESCE((t.settings->'guardrails'->>'enforce')::boolean, false) AS enforce_on,
                count(*)::int AS n, sum((u.enforced)::int)::int AS enforced
           FROM (
             SELECT tenant_id, enforced, created_at FROM guardrail_spam_logs WHERE created_at > ${since}
             UNION ALL
             SELECT tenant_id, enforced, created_at FROM guardrail_output_logs WHERE created_at > ${since}
           ) u LEFT JOIN tenants t ON t.id = u.tenant_id
          GROUP BY u.tenant_id, t.name, enforce_on ORDER BY n DESC LIMIT 20`),
    ]);

    sendSuccess(res, { days, inbound, output, byTenant });
  }),
);

// PUT /admin/tenants/:id/guardrails — flip the per-tenant enforce flag. Shadow by
// default; this is the only way enforcement turns on for a tenant.
router.put(
  '/tenants/:id/guardrails',
  asyncHandler(async (req: Request, res: Response) => {
    const { enforce } = req.body as { enforce?: unknown };
    if (typeof enforce !== 'boolean') {
      throw new ValidationError('enforce must be a boolean');
    }
    const repo = AppDataSource.getRepository(Tenant);
    const tenant = await repo.findOne({ where: { id: req.params.id } });
    if (!tenant) throw new NotFoundError('Tenant not found');

    const settings = (tenant.settings ?? {}) as NonNullable<Tenant['settings']> & {
      guardrails?: { enforce?: boolean };
    };
    settings.guardrails = { ...(settings.guardrails ?? {}), enforce };
    tenant.settings = settings;
    await repo.save(tenant);

    // isGuardrailsEnforcing caches the flag 60s — invalidate so the toggle takes
    // effect immediately (critical for turning enforce OFF).
    await invalidate(`guardrails:enforce:${tenant.id}`);

    await logAudit(
      req.userId!,
      'tenant.guardrails_enforce_updated',
      'tenant',
      tenant.id,
      tenant.id,
      { enforce },
    );
    logger.info('[admin] guardrails enforce toggled', { tenantId: tenant.id, enforce, by: req.userId });
    sendSuccess(res, { tenantId: tenant.id, enforce });
  }),
);

export default router;
