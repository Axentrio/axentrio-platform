/**
 * Insights Routes — the Gaps surface (ADR-0007), tier-gated per ADR-0013:
 * the whole surface needs `gapInsights`; evidence drill-down additionally
 * needs `gapEvidence`. Gates read Features only — never tier names.
 * Wins-history retention is a query-time window keyed off the flag set
 * (rows are never deleted, so upgrades restore history instantly).
 */
import { Router, Request, Response, NextFunction } from 'express';
import { AppDataSource } from '../database/data-source';
import { Gap } from '../database/entities/Gap';
import { Judgment } from '../database/entities/Judgment';
import { CanonicalTopic } from '../database/entities/CanonicalTopic';
import { InsightsRefreshState } from '../database/entities/InsightsRefreshState';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler, BadRequestError, ForbiddenError, NotFoundError } from '../middleware/error-handler';
import { sendSuccess } from '../utils/response';
import { getEntitlements } from '../billing/entitlements';
import { decrypt } from '../utils/encryption';

const router = Router();
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

/** Wins-history retention in days, by flag set (ADR-0013 / D6). */
function retentionDays(features: { gapEvidence: boolean; aiBusinessInsights: boolean }): number {
  if (features.aiBusinessInsights) return 365;
  if (features.gapEvidence) return 90;
  return 30;
}

/** Feature gate factory — 403 with a stable code so the portal can render the locked state. */
function requireInsightsFeature(flag: 'gapInsights' | 'gapEvidence') {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) throw new BadRequestError('Tenant context required');
    const entitlements = await getEntitlements(tenantId);
    if (!entitlements.features[flag]) {
      throw new ForbiddenError(`Feature ${flag} not included in your plan`);
    }
    next();
  });
}

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
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId as string;
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

    const state = await AppDataSource.getRepository(InsightsRefreshState).findOne({
      where: { tenantId },
    });

    sendSuccess(res, {
      gaps: gaps.map((g) => ({
        id: g.id,
        topic: g.topic,
        status: g.status,
        severity: g.severity,
        occurrences: g.occurrences,
        distinctVisitors: g.distinct_visitors,
        firstDetectedAt: g.first_detected_at,
        lastSeenAt: g.last_seen_at,
        resolvedAt: g.resolved_at,
        archivedAt: g.archived_at,
        recommendation: g.recommendation,
      })),
      meta: {
        lastRefreshedAt: state?.lastRefreshedAt ?? null,
        completeness: state?.judgmentsCompleteness != null ? Number(state.judgmentsCompleteness) : null,
        retentionDays: windowDays,
        evidenceEnabled: entitlements.features.gapEvidence,
      },
    });
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
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId as string;
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

    sendSuccess(res, {
      evidence: judgments.map((j) => ({
        sessionId: j.sessionId,
        sessionStartedAt: j.sessionStartedAt,
        reasoning: j.reasoning,
        messages: (j.evidenceMessageIds ?? [])
          .map((id) => messageById.get(id))
          .filter(Boolean)
          .map((m) => ({ id: m!.id, sender: m!.sender, content: m!.content, at: m!.created_at })),
      })),
    });
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
  if (to === 'resolved_manual') gap.resolvedAt = new Date();
  else gap.archivedAt = new Date();
  return repo.save(gap);
}

router.post(
  '/:gapId/resolve',
  requireInsightsFeature('gapInsights'),
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const gap = await transitionGap(authReq.user?.tenantId as string, req.params.gapId, 'resolved_manual');
    sendSuccess(res, { id: gap.id, status: gap.status });
  }),
);

router.post(
  '/:gapId/archive',
  requireInsightsFeature('gapInsights'),
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const gap = await transitionGap(authReq.user?.tenantId as string, req.params.gapId, 'archived');
    sendSuccess(res, { id: gap.id, status: gap.status });
  }),
);

export default router;
