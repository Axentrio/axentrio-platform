/**
 * Insights Routes — the Gaps surface (ADR-0007), tier-gated per ADR-0013:
 * the whole surface needs `gapInsights`; evidence drill-down additionally
 * needs `gapEvidence`. Gates read Features only — never tier names.
 * Wins-history retention is a query-time window keyed off the flag set
 * (rows are never deleted, so upgrades restore history instantly).
 */
import { Router, Request, Response, NextFunction } from 'express';
import { AppDataSource } from '../database/data-source';
import { aggregateLeadDemand } from '../insights/lead-demand.service';
import {
  getAnalysisStatus,
  claimAnalysisRun,
  releaseAnalysisRun,
} from '../insights/analysis-eligibility.service';
import { refreshTenantInsights } from '../insights/refresh-insights.job';
import { enrichmentAbstainStats } from '../leads/enrichment/enrich-lead.job';
import { Gap } from '../database/entities/Gap';
import { Judgment } from '../database/entities/Judgment';
import { CanonicalTopic } from '../database/entities/CanonicalTopic';
import { InsightsRefreshState } from '../database/entities/InsightsRefreshState';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler, ApiError, BadRequestError, NotFoundError } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';
import { logger } from '../utils/logger';
import { getEntitlements } from '../billing/entitlements';
import { InsightExperiment } from '../database/entities/InsightExperiment';
import { InsightDigest } from '../database/entities/InsightDigest';
import { Tenant } from '../database/entities/Tenant';
import { digestEmailEnabled } from '../insights/digest.service';
import { experimentOccurrences, priorityScore } from '../insights/priority-score';
import { getSentimentTrend } from '../insights/sentiment-trend.service';
import type {
  InsightsListResponse, GapDto, GapStatus, GapSeverity, EvidenceResponse,
  ExperimentsResponse, ExperimentDto, DigestResponse, DigestDto, DigestMetrics,
  SentimentTrendResponse,
} from '../contracts/insights';
import { decrypt } from '../utils/encryption';

const router = Router();
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

/** Wins-history retention in days, by flag set (ADR-0013 / D6). */
function retentionDays(features: { gapEvidence: boolean; aiBusinessInsights: boolean }): number {
  if (features.aiBusinessInsights) return 365;
  if (features.gapEvidence) return 90;
  return 30;
}

/**
 * The tenant this request is about.
 *
 * `resolveTenantContext` is mounted on this router and sets `req.tenantId` from the
 * super-admin `X-Tenant-Context` header, falling back to the caller's own tenant. Every
 * route here read `user.tenantId` directly instead, so the header was ignored and the
 * middleware was decorative: a super admin who switched tenants was shown their OWN
 * insights while the switcher said otherwise, and the Enterprise-only panels 403'd on a
 * tenant that was in fact entitled (observed on production against an enterprise tenant).
 *
 * Reading `req.tenantId` first is safe by construction — the header is honoured only for
 * role `super_admin`, and only for a tenant that exists and is not suspended
 * (super-admin.middleware.ts) — and matches how every other router resolves tenancy.
 */
function insightsTenantId(req: Request): string | undefined {
  return req.tenantId ?? (req as ProvisionedRequest).user?.tenantId;
}

/** Feature gate factory — 403 with a stable code so the portal can render the locked state. */
function requireInsightsFeature(flag: 'gapInsights' | 'gapEvidence' | 'aiBusinessInsights') {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const tenantId = insightsTenantId(req);
    if (!tenantId) throw new BadRequestError('Tenant context required');
    const entitlements = await getEntitlements(tenantId);
    if (!entitlements.features[flag]) {
      // disabled_by_tenant (entitled but toggled off) vs not_entitled — the
      // portal must not show upgrade copy for the former. Plan § 9b.11.
      const reason = entitlements.entitledFeatures[flag] ? 'disabled_by_tenant' : 'not_entitled';
      throw new ApiError(`Feature ${flag} not available`, 403, 'FORBIDDEN', { feature: flag, reason });
    }
    next();
  });
}

/**
 * GET /insights/analysis-status
 * Whether analysis can be run right now, and what is standing in the way.
 *
 * Gated on `gapInsights` only — every tier that HAS insights needs to know why the
 * button is disabled, including Enterprise, whose answer is "it runs by itself".
 */
router.get(
  '/analysis-status',
  requireInsightsFeature('gapInsights'),
  asyncHandler(async (req: Request, res: Response) => {
    const status = await getAnalysisStatus(insightsTenantId(req) as string);
    sendSuccess(res, status);
  }),
);

/**
 * POST /insights/analyse
 * Start an on-demand analysis (Essential and Pro). Returns 202 — this does NOT wait.
 *
 * Waiting was the first design and it was wrong. The pass is one LLM call per
 * conversation, and Essential cannot even unlock the button below fifteen of them, so
 * the smallest permitted run already approaches the portal's 30-second HTTP timeout and
 * a first run over a backlog takes minutes. The operator would have seen "analysis
 * failed" while the server quietly succeeded — and, because the cooldown is stamped up
 * front, they would have spent 72 hours on a run they were told had failed.
 *
 * So the work runs in the background behind a claim lease and the portal polls
 * `analysis-status`. Eligibility is still re-checked here rather than trusted from the
 * button: that view is seconds stale by definition, and the cooldown is the cost control.
 */
router.post(
  '/analyse',
  requireInsightsFeature('gapInsights'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = insightsTenantId(req) as string;
    const status = await getAnalysisStatus(tenantId);
    if (!status.eligible) {
      // 403 for "your tier has no such button", 409 for "not right now" — an Enterprise
      // tenant is not in conflict with anything, they simply do not have this control.
      const httpStatus = status.reason === 'automatic' || status.reason === 'not_entitled' ? 403 : 409;
      throw new ApiError('Analysis is not available yet', httpStatus, 'FORBIDDEN', {
        reason: status.reason,
        newChats: status.newChats,
        minNewChats: status.minNewChats,
        nextAllowedAt: status.nextAllowedAt,
      });
    }

    // The claim IS the cooldown stamp — one atomic write, so two clicks in the same
    // second cannot both start a pass.
    if (!(await claimAnalysisRun(tenantId))) {
      throw new ApiError('Analysis is already running', 409, 'CONFLICT', { reason: 'running' });
    }

    // Deliberately not awaited. Failures are logged and the lease is always released,
    // so a crash frees the tenant to try again rather than stranding them on "analysing".
    void refreshTenantInsights(tenantId)
      .catch((err) => {
        logger.error('[insights] on-demand analysis failed', {
          tenantId,
          error: err instanceof Error ? err.message : 'unknown',
        });
      })
      .finally(() => {
        void releaseAnalysisRun(tenantId).catch(() => {});
      });

    res.status(202);
    sendSuccess(res, await getAnalysisStatus(tenantId));
  }),
);

/**
 * GET /insights
 * Gap list for the tenant: open (incl. dormant) + wins within the retention
 * window, each with its canonical topic phrase, plus freshness/completeness
 * metadata for the banners (ADR-0006/0007).
 */
router.get(
  '/',
  requireInsightsFeature('gapInsights'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = insightsTenantId(req) as string;
    const entitlements = await getEntitlements(tenantId);

    const windowDays = retentionDays(entitlements.features);
    const retentionStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const gaps: Array<Record<string, unknown>> = await AppDataSource.getRepository(Gap)
      .createQueryBuilder('g')
      .leftJoin(CanonicalTopic, 'ct', 'ct.id = g.canonical_topic_id')
      .select(['g.*'])
      .addSelect('ct.topic', 'topic')
      .where('g.tenant_id = :tenantId', { tenantId })
      .andWhere(
        `(g.status IN ('open', 'dormant')
          OR (g.status IN ('resolved_data', 'resolved_manual') AND g.resolved_at >= :retentionStart)
          OR (g.status = 'archived' AND g.archived_at >= :retentionStart))`,
        { retentionStart },
      )
      .orderBy('g.last_seen_at', 'DESC')
      .getRawMany();

    const priorityEnabled = entitlements.features.gapEvidence;
    const trendRows: Array<{ canonicalTopicId: string; currentVisitors: number; baselineVisitors: number }> =
      priorityEnabled
        ? await AppDataSource.query(
            `SELECT j.canonical_topic_id AS "canonicalTopicId",
                    COUNT(DISTINCT j.visitor_id) FILTER (
                      WHERE j.session_started_at >= $2
                    )::int AS "currentVisitors",
                    COUNT(DISTINCT j.visitor_id) FILTER (
                      WHERE j.session_started_at >= $3 AND j.session_started_at < $2
                    )::int AS "baselineVisitors"
               FROM chatbot_judgments j
              WHERE j.tenant_id = $1
                AND j.satisfied = false
                AND j.canonical_topic_id IS NOT NULL
                AND j.session_started_at >= $3
              GROUP BY j.canonical_topic_id`,
            [
              tenantId,
              new Date(Date.now() - 7 * 86_400_000),
              new Date(Date.now() - 14 * 86_400_000),
            ],
          )
        : [];
    const trends = new Map(trendRows.map((row) => [row.canonicalTopicId, row]));
    const state = await AppDataSource.getRepository(InsightsRefreshState).findOne({ where: { tenantId } });

    // Typed against the shared wire contract (src/contracts/insights.ts).
    const gapDtos = gaps.map((g): GapDto => {
      const occurrences = Number(g.occurrences);
      const distinctVisitors = Number(g.distinct_visitors);
      const trend = trends.get(g.canonical_topic_id as string);
      return {
        id: g.id as string,
        topic: g.topic as string,
        status: g.status as GapStatus,
        severity: g.severity as GapSeverity,
        priorityScore: priorityEnabled
          ? priorityScore({
              severity: g.severity as GapSeverity,
              occurrences,
              currentVolume: Number(trend?.currentVisitors ?? distinctVisitors),
              baselineVolume: Number(trend?.baselineVisitors ?? distinctVisitors),
            })
          : null,
        recommendation:
          priorityEnabled && g.status === 'open'
            ? (g.recommendation as string | null) ?? null
            : null,
        occurrences,
        distinctVisitors,
        firstDetectedAt: g.first_detected_at as string,
        lastSeenAt: g.last_seen_at as string,
        resolvedAt: (g.resolved_at ?? null) as string | null,
        archivedAt: (g.archived_at ?? null) as string | null,
      };
    });
    if (priorityEnabled) gapDtos.sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0));

    const payload: InsightsListResponse = {
      gaps: gapDtos,
      meta: {
        lastRefreshedAt: (state?.lastRefreshedAt ?? null) as unknown as string | null,
        completeness: state?.judgmentsCompleteness != null ? Number(state.judgmentsCompleteness) : null,
        retentionDays: windowDays,
        evidenceEnabled: entitlements.features.gapEvidence,
      },
    };
    sendSuccess(res, payload);
  }),
);

/** GET /insights/sentiment/trend — basic sentiment distribution for Pro+. */
router.get(
  '/sentiment/trend',
  requireInsightsFeature('gapEvidence'),
  asyncHandler(async (req: Request, res: Response) => {
    const windowDays: 7 | 30 = Number(req.query.days) === 7 ? 7 : 30;
    const payload: SentimentTrendResponse = await getSentimentTrend(
      insightsTenantId(req) as string,
      windowDays,
    );
    sendSuccess(res, payload);
  }),
);

/**
 * GET /insights/:gapId/evidence
 * The judgments (and their cited messages, original language) behind a Gap.
 * Pro+ only (`gapEvidence`).
 */
router.get(
  '/:gapId/evidence',
  requireInsightsFeature('gapEvidence'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = insightsTenantId(req) as string;
    const { gapId } = req.params;

    const gap = await AppDataSource.getRepository(Gap).findOne({ where: { id: gapId, tenantId } });
    if (!gap) throw new NotFoundError('Gap not found');

    const judgments = await AppDataSource.getRepository(Judgment)
      .createQueryBuilder('j')
      .where('j.tenant_id = :tenantId', { tenantId })
      .andWhere('j.canonical_topic_id = :topicId', { topicId: gap.canonicalTopicId })
      .andWhere('j.satisfied = false')
      .orderBy('j.session_started_at', 'DESC')
      .limit(50)
      .getMany();

    const allMessageIds = judgments.flatMap((j) => j.evidenceMessageIds ?? []);
    const messages: Array<{ id: string; content: string; contentEncrypted: boolean; sender: string; created_at: Date }> =
      allMessageIds.length > 0
        ? await AppDataSource.query(
            `SELECT m.id, m.content, m.content_encrypted AS "contentEncrypted", p.type AS sender, m.created_at
             FROM messages m JOIN participants p ON p.id = m.participant_id
             WHERE m.id = ANY($1)`,
            [allMessageIds],
          )
        : [];
    // Message content is encrypted at rest — evidence must render plaintext.
    const messageById = new Map(
      messages.map((m) => [m.id, { ...m, content: m.contentEncrypted ? decrypt(m.content) : m.content }]),
    );

    const evidencePayload: EvidenceResponse = {
      evidence: judgments.map((j) => ({
        sessionId: j.sessionId,
        sessionStartedAt: j.sessionStartedAt as unknown as string,
        reasoning: j.reasoning ?? null,
        messages: (j.evidenceMessageIds ?? [])
          .map((id) => messageById.get(id))
          .filter(Boolean)
          .map((m) => ({ id: m!.id, sender: m!.sender, content: m!.content, at: m!.created_at as unknown as string })),
      })),
    };
    sendSuccess(res, evidencePayload);
  }),
);

/**
 * POST /insights/:gapId/resolve  — tenant clicked "I fixed this" (ADR-0005
 * resolved_manual: for actual fixes, not silencing).
 * POST /insights/:gapId/archive  — tenant clicked "Not relevant".
 */
async function transitionGap(
  tenantId: string,
  gapId: string,
  to: 'resolved_manual' | 'archived',
): Promise<Gap> {
  const repo = AppDataSource.getRepository(Gap);
  const gap = await repo.findOne({ where: { id: gapId, tenantId } });
  if (!gap) throw new NotFoundError('Gap not found');
  if (gap.status !== 'open' && gap.status !== 'dormant') {
    throw new BadRequestError(`Cannot ${to === 'archived' ? 'archive' : 'resolve'} a ${gap.status} gap`);
  }
  gap.status = to;
  gap.severity = to === 'resolved_manual' ? 'green' : gap.severity;
  gap.recommendation = null;
  if (to === 'resolved_manual') gap.resolvedAt = new Date();
  else gap.archivedAt = new Date();
  return repo.save(gap);
}

router.post(
  '/:gapId/resolve',
  requireInsightsFeature('gapInsights'),
  asyncHandler(async (req: Request, res: Response) => {
    const gap = await transitionGap(insightsTenantId(req) as string, req.params.gapId, 'resolved_manual');
    sendSuccess(res, { id: gap.id, status: gap.status });
  }),
);

router.post(
  '/:gapId/archive',
  requireInsightsFeature('gapInsights'),
  asyncHandler(async (req: Request, res: Response) => {
    const gap = await transitionGap(insightsTenantId(req) as string, req.params.gapId, 'archived');
    sendSuccess(res, { id: gap.id, status: gap.status });
  }),
);

/* ------------------------------------------------------------------ */
/*  P3 — experiments (correlation + sentiment). Enterprise-gated.      */
/* ------------------------------------------------------------------ */

/**
 * GET /insights/experiments
 * Active correlation + sentiment experiments for the tenant (ADR-0014 D3/D8).
 * Observations only — no resolution state; dismissed rows are excluded.
 */
router.get(
  '/experiments',
  requireInsightsFeature('aiBusinessInsights'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = insightsTenantId(req) as string;

    // Severity is a varchar ('red'|'orange'|'green'), so ORDER BY severity ASC sorts
    // ALPHABETICALLY — green, orange, red — i.e. LEAST severe first. Order explicitly.
    const rows = await AppDataSource.getRepository(InsightExperiment)
      .createQueryBuilder('e')
      .where('e.tenant_id = :tenantId', { tenantId })
      .andWhere("e.state = 'active'")
      .orderBy(
        `CASE e.severity WHEN 'red' THEN 0 WHEN 'orange' THEN 1 WHEN 'green' THEN 2 ELSE 3 END`,
        'ASC',
      )
      .addOrderBy('e.last_seen_at', 'DESC')
      .getMany();

    const experiments = rows.map((e): ExperimentDto => {
      const payload = e.payload ?? {};
      const occurrences = experimentOccurrences(payload);
      return {
        id: e.id,
        kind: e.kind,
        severity: e.severity,
        priorityScore: priorityScore({
          severity: e.severity,
          occurrences,
          currentVolume: occurrences,
          baselineVolume: occurrences,
        }),
        title: e.title,
        detail: e.detail ?? null,
        payload,
        firstSeenAt: e.firstSeenAt as unknown as string,
        lastSeenAt: e.lastSeenAt as unknown as string,
      };
    });
    experiments.sort((a, b) => b.priorityScore - a.priorityScore);
    const payload: ExperimentsResponse = { experiments };
    sendSuccess(res, payload);
  }),
);

/**
 * POST /insights/experiments/:id/dismiss
 * Tenant dismisses an experiment (active → dismissed). Dismissed experiments
 * persist so they don't re-surface; there is no resolve (ADR-0001).
 */
router.post(
  '/experiments/:id/dismiss',
  requireInsightsFeature('aiBusinessInsights'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = insightsTenantId(req) as string;
    const repo = AppDataSource.getRepository(InsightExperiment);
    const exp = await repo.findOne({ where: { id: req.params.id, tenantId } });
    if (!exp) throw new NotFoundError('Experiment not found');
    if (exp.state !== 'dismissed') {
      exp.state = 'dismissed';
      exp.dismissedAt = new Date();
      await repo.save(exp);
    }
    sendSuccess(res, { id: exp.id, state: exp.state });
  }),
);

/* ------------------------------------------------------------------ */
/*  Weekly improvement snapshot (latest) + email preference. Pro+-gated. */
/* ------------------------------------------------------------------ */

/**
 * GET /insights/digest
 * The most recent weekly digest (header metrics + narrative), or null before
 * the first Monday run. `emailEnabled` reflects the tenant's opt-out pref so
 * the surface can render the toggle (ADR-0014 D6/D8).
 */
/**
 * GET /insights/lead-demand — Story 3's Enterprise "AI Lead Intelligence".
 *
 * A DESCRIPTIVE frequency, not an experiment: it reports what customers asked for and
 * always publishes the denominator it is a share OF. Deliberately not a
 * `chatbot_insight_experiments` kind — that table is for hypotheses that cleared a
 * significance bar, and a count is not a finding.
 *
 * Primary figures come from the tenant's own booking + service catalogue, so this works
 * whether or not LLM enrichment is switched on; extracted tags are reported separately
 * as the inferred, sparser view.
 */
router.get(
  '/lead-demand',
  requireInsightsFeature('aiBusinessInsights'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = insightsTenantId(req) as string;
    const entitlements = await getEntitlements(tenantId);
    const windowDays = retentionDays(entitlements.features);

    // Cap the window: "demand" means recent demand. A year of history would blend a
    // seasonal trade's winter and summer into one meaningless average.
    const requested = parseInt(String(req.query.days ?? 30), 10);
    const days = Math.min(
      Number.isFinite(requested) && requested > 0 ? requested : 30,
      Math.min(windowDays, 90),
    );

    sendSuccess(res, await aggregateLeadDemand(tenantId, days));
  }),
);

/**
 * GET /insights/lead-enrichment-health — is extraction still working?
 *
 * Exists because the operational advice for Release B is "watch the abstain rate", and
 * that was previously unfollowable: the stats function was written and exported but had
 * no caller, no endpoint and no surface. Guidance you cannot act on is worse than none.
 *
 * The signal to watch is counter-intuitive: a sharp DROP in abstentions after a model
 * change is the alarm, not good news. Fail-closed extraction is SUPPOSED to abstain
 * often; a sudden fall means the grounding checks stopped biting and values are being
 * accepted that previously were not.
 */
router.get(
  '/lead-enrichment-health',
  requireInsightsFeature('aiBusinessInsights'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = insightsTenantId(req) as string;
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? 7), 10) || 7, 1), 90);
    const stats = await enrichmentAbstainStats(tenantId, days);

    const total = Number(stats.total ?? 0);
    const abstained = Number(stats.abstained ?? 0);
    sendSuccess(res, {
      windowDays: days,
      analyzed: total,
      abstained,
      // Null rather than 0 when nothing ran: "0% abstention" reads as a healthy system,
      // whereas the truth is that we have no data.
      abstainRate: total > 0 ? Math.round((abstained / total) * 1000) / 1000 : null,
      perField: {
        request: Number(stats.no_request ?? 0),
        address: Number(stats.no_address ?? 0),
        urgency: Number(stats.no_urgency ?? 0),
        intent: Number(stats.no_intent ?? 0),
      },
    });
  }),
);

router.get(
  '/digest',
  requireInsightsFeature('gapEvidence'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = insightsTenantId(req) as string;

    const [digest, tenant] = await Promise.all([
      AppDataSource.getRepository(InsightDigest).findOne({
        where: { tenantId },
        order: { weekStart: 'DESC' },
      }),
      AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId }, select: ['id', 'settings'] }),
    ]);

    const dto: DigestDto | null = digest
      ? {
          weekStart: digest.weekStart,
          summaryMd: digest.summaryMd,
          metrics: digest.metrics as unknown as DigestMetrics,
        }
      : null;

    const payload: DigestResponse = {
      digest: dto,
      emailEnabled: tenant ? digestEmailEnabled(tenant) : true,
    };
    sendSuccess(res, payload);
  }),
);

/**
 * PUT /insights/digest/email  { enabled: boolean }
 * Toggle the weekly digest email. Pref lives in tenant.settings.insights
 * (default-ON) — a future generation reads it; an in-flight 'pending' row is
 * left to the reconciler, which honours the row's own state.
 */
router.put(
  '/digest/email',
  requireInsightsFeature('gapEvidence'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = insightsTenantId(req) as string;
    const enabled = (req.body as { enabled?: unknown })?.enabled;
    if (typeof enabled !== 'boolean') throw new BadRequestError('`enabled` must be a boolean');

    const repo = AppDataSource.getRepository(Tenant);
    const tenant = await repo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');
    tenant.settings = {
      ...tenant.settings,
      insights: { ...tenant.settings?.insights, digestEmail: enabled },
    };
    await repo.save(tenant);
    sendSuccess(res, { emailEnabled: enabled });
  }),
);

export default router;
