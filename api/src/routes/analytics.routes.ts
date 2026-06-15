/**
 * Analytics Routes
 * Dashboard metrics and reporting
 */
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Agent } from '../database/entities/Agent';
import { Booking } from '../database/entities/Booking';
import { Lead } from '../database/entities/Lead';
import { AvailabilityRule } from '../database/entities/AvailabilityRule';
import { isWithinBusinessHours } from '../n8n/booking-providers/slot-engine';
import type { OutcomesResponse, OutcomeAggregates, OutcomesTimeseriesResponse } from '../contracts/analytics';
import { requireClerkAuth, autoProvision, ProvisionedRequest } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { cached } from '../utils/cache';
import { asyncHandler, ApiError, BadRequestError, ForbiddenError } from '../middleware/error-handler';
import { ERROR_CODES } from '../middleware/error-codes';
import { validate } from '../middleware/validate';
import { sendSuccess } from '../utils/response';
import { analyticsQuerySchema, analyticsExportQuerySchema } from '../schemas';
import { getEntitlements } from '../billing/entitlements';
import { getExporter, toCsv, EXPORT_DATASETS } from '../analytics/exporters';

const router = Router();
const sessionRepository = AppDataSource.getRepository(ChatSession);
const agentRepository = AppDataSource.getRepository(Agent);
const bookingRepository = AppDataSource.getRepository(Booking);
const leadRepository = AppDataSource.getRepository(Lead);
const availabilityRepository = AppDataSource.getRepository(AvailabilityRule);

// All routes require agent authentication
router.use(requireClerkAuth, autoProvision, resolveTenantContext);

/**
 * GET /analytics/dashboard
 * Aggregate metrics for the dashboard
 */
router.get(
  '/dashboard',
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;

    const dashboard = await cached(
      `dashboard:${tenantId}`,
      30,
      async () => {
        // Two consolidated queries run in parallel
        const [sessionStats, agentStats] = await Promise.all([
          // Query 1: All session counts + CSAT in one pass
          sessionRepository
            .createQueryBuilder('s')
            .select('COUNT(*)', 'total')
            .addSelect("COUNT(*) FILTER (WHERE s.status = 'active')", 'active')
            .addSelect("COUNT(*) FILTER (WHERE s.status = 'waiting')", 'waiting')
            .addSelect("COUNT(*) FILTER (WHERE s.status = 'handoff')", 'handoff')
            .addSelect("COUNT(*) FILTER (WHERE s.status = 'bot')", 'bot')
            .addSelect("COUNT(*) FILTER (WHERE s.status = 'closed')", 'closed')
            .addSelect("COUNT(*) FILTER (WHERE s.status = 'closed' AND s.assigned_agent_id IS NOT NULL)", 'humanResolved')
            .addSelect('AVG(s.satisfaction_rating) FILTER (WHERE s.satisfaction_rating IS NOT NULL)', 'csatAvg')
            .addSelect('COUNT(s.satisfaction_rating)', 'csatCount')
            .where('s.tenant_id = :tenantId', { tenantId })
            .getRawOne(),

          // Query 2: Agent counts + avg response time in one pass
          agentRepository
            .createQueryBuilder('a')
            .select('COUNT(*)', 'total')
            .addSelect("COUNT(*) FILTER (WHERE a.status = 'online')", 'online')
            .addSelect('AVG(a.avg_response_time_seconds)', 'avgResponseTime')
            .where('a.tenant_id = :tenantId', { tenantId })
            .getRawOne(),
        ]);

        const closed = parseInt(sessionStats?.closed || '0');
        const humanResolved = parseInt(sessionStats?.humanResolved || '0');
        const botResolved = closed - humanResolved;
        const csatAvg = sessionStats?.csatAvg ? parseFloat(parseFloat(sessionStats.csatAvg).toFixed(1)) : null;
        const botResolutionRate = closed > 0 ? Math.round((botResolved / closed) * 100) : null;

        return {
          sessions: {
            total: parseInt(sessionStats?.total || '0'),
            active: parseInt(sessionStats?.active || '0'),
            waiting: parseInt(sessionStats?.waiting || '0'),
            handoff: parseInt(sessionStats?.handoff || '0'),
            bot: parseInt(sessionStats?.bot || '0'),
          },
          agents: {
            total: parseInt(agentStats?.total || '0'),
            online: parseInt(agentStats?.online || '0'),
          },
          avgResponseTimeSeconds: Math.round(parseFloat(agentStats?.avgResponseTime || '0')),
          csatScore: csatAvg,
          botResolutionRate,
        };
      }
    );

    sendSuccess(res, { dashboard });
  })
);

/**
 * GET /analytics/chats
 * Chat metrics with date range
 */
router.get(
  '/chats',
  validate(analyticsQuerySchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;
    const from = req.query.from as string;
    const to = req.query.to as string;

    const qb = sessionRepository.createQueryBuilder('session')
      .where('session.tenant_id = :tenantId', { tenantId });

    if (from) {
      qb.andWhere('session.created_at >= :from', { from: new Date(from) });
    }
    if (to) {
      qb.andWhere('session.created_at <= :to', { to: new Date(to) });
    }

    const total = await qb.getCount();

    const closed = await qb.clone()
      .andWhere('session.status = :status', { status: 'closed' })
      .getCount();

    // Closed sessions resolved by a human agent — same definition as the
    // dashboard endpoint (closed AND an agent was assigned).
    const humanResolved = await qb.clone()
      .andWhere('session.status = :status', { status: 'closed' })
      .andWhere('session.assigned_agent_id IS NOT NULL')
      .getCount();

    // Average duration for closed sessions
    const avgResult = await qb.clone()
      .select('AVG(session.duration_seconds)', 'avgDuration')
      .andWhere('session.status = :status', { status: 'closed' })
      .andWhere('session.duration_seconds IS NOT NULL')
      .getRawOne();

    sendSuccess(res, {
      metrics: {
        total,
        closed,
        open: total - closed,
        humanResolved,
        avgDurationSeconds: Math.round(avgResult?.avgDuration || 0),
      },
    });
  })
);

/**
 * GET /analytics/agents
 * Agent performance metrics
 */
router.get(
  '/agents',
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;

    const agents = await agentRepository.find({
      where: { tenantId },
      relations: ['user'],
    });

    sendSuccess(res, {
      agents: agents.map((a) => ({
        id: a.id,
        name: a.user?.name,
        status: a.status,
        totalChatsHandled: a.totalChatsHandled,
        avgResponseTimeSeconds: a.avgResponseTimeSeconds,
        satisfactionScore: a.satisfactionScore,
        currentChatCount: a.currentChatCount,
      })),
    });
  })
);

/**
 * GET /analytics/chats/timeseries
 * Daily chat volume grouped by status category
 */
router.get(
  '/chats/timeseries',
  validate(analyticsQuerySchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;

    // Default to last 7 days
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate ? new Date(startDate) : new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

    const rawData = await sessionRepository
      .createQueryBuilder('session')
      .select("DATE(session.created_at)", 'date')
      .addSelect("COUNT(CASE WHEN session.assigned_agent_id IS NULL AND session.status = 'closed' THEN 1 END)", 'bot')
      .addSelect("COUNT(CASE WHEN session.assigned_agent_id IS NOT NULL THEN 1 END)", 'human')
      .addSelect("COUNT(CASE WHEN session.status IN ('handoff') THEN 1 END)", 'handoff')
      .where('session.tenant_id = :tenantId', { tenantId })
      .andWhere('session.created_at >= :start', { start })
      .andWhere('session.created_at <= :end', { end })
      .groupBy("DATE(session.created_at)")
      .orderBy("DATE(session.created_at)", 'ASC')
      .limit(366)
      .getRawMany();

    const timeseries = rawData.map((row: Record<string, string>) => ({
      date: row.date,
      bot: parseInt(row.bot, 10) || 0,
      human: parseInt(row.human, 10) || 0,
      handoff: parseInt(row.handoff, 10) || 0,
    }));

    sendSuccess(res, { timeseries });
  })
);

/* ------------------------------------------------------------------ */
/*  Outcome metrics (Deviation 36 / ADR-0013 P1)                       */
/*  Same response shape for every paying tier — no tier gating here;   */
/*  bookings/channel sections simply contain what the tenant's plan    */
/*  generates (see .scratch/plan-insights-tiering.md Principle 2/3).   */
/* ------------------------------------------------------------------ */

interface OutcomeWindow {
  from: Date;
  to: Date;
  prevFrom: Date;
  prevTo: Date;
}

/**
 * Resolve [from, to) plus the same-length window immediately before it
 * (for vs-previous-period deltas). Half-open so boundary rows are never
 * double-counted across the two windows. Defaults to the last 7 days.
 */
function resolveOutcomeWindow(fromStr?: string, toStr?: string): OutcomeWindow {
  const to = toStr ? new Date(toStr) : new Date();
  const from = fromStr ? new Date(fromStr) : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  const spanMs = Math.max(to.getTime() - from.getTime(), 1);
  return {
    from,
    to,
    prevFrom: new Date(from.getTime() - spanMs),
    prevTo: from,
  };
}

/** Sum the COUNT column of a grouped raw result. */
function sumCounts(rows: Array<{ count: string }>): number {
  return rows.reduce((acc, r) => acc + (parseInt(r.count, 10) || 0), 0);
}

/** Fold grouped rows into a { key: count } record. */
function toBreakdown(rows: Array<{ key: string; count: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.key] = parseInt(r.count, 10) || 0;
  return out;
}

/**
 * Classify the window's sessions as inside/outside business hours, using the
 * tenant's scheduler AvailabilityRules (one per bot). Sessions whose bot has
 * a rule are classifiable; when a session's bot has none but the tenant has
 * exactly one rule, that rule is used (the common one-bot-with-scheduler
 * case). Returns null when the tenant has no rules at all — the metric has
 * no meaning without business hours, and the portal hides the card.
 */
async function computeAfterHours(
  tenantId: string,
  from: Date,
  to: Date,
  rules: AvailabilityRule[],
): Promise<{ count: number; classifiable: number } | null> {
  if (rules.length === 0) return null;

  const byBot = new Map(rules.map((r) => [r.botId, r]));
  const fallback = rules.length === 1 ? rules[0] : null;

  const sessions: Array<{ botId: string | null; createdAt: string | Date }> = await sessionRepository
    .createQueryBuilder('s')
    .select('s.bot_id', 'botId')
    .addSelect('s.created_at', 'createdAt')
    .where('s.tenant_id = :tenantId', { tenantId })
    .andWhere('s.created_at >= :from', { from })
    .andWhere('s.created_at < :to', { to })
    .limit(10_000)
    .getRawMany();

  let count = 0;
  let classifiable = 0;
  for (const s of sessions) {
    const rule = (s.botId && byBot.get(s.botId)) || fallback;
    if (!rule) continue;
    classifiable += 1;
    if (!isWithinBusinessHours(rule, new Date(s.createdAt))) count += 1;
  }
  return { count, classifiable };
}

/** Compute the outcome aggregates for one [from, to) window. */
async function computeOutcomes(tenantId: string, from: Date, to: Date, rules: AvailabilityRule[]): Promise<OutcomeAggregates> {
  const [conversationRows, bookingRows, leadRows, afterHours] = await Promise.all([
    sessionRepository
      .createQueryBuilder('s')
      .select('s.channel', 'key')
      .addSelect('COUNT(*)', 'count')
      .where('s.tenant_id = :tenantId', { tenantId })
      .andWhere('s.created_at >= :from', { from })
      .andWhere('s.created_at < :to', { to })
      .groupBy('s.channel')
      .getRawMany(),
    bookingRepository
      .createQueryBuilder('b')
      // Manual/unattributed bookings have no source_channel.
      .select("COALESCE(b.source_channel, 'direct')", 'key')
      .addSelect('COUNT(*)', 'count')
      .where('b.tenant_id = :tenantId', { tenantId })
      .andWhere("b.status NOT IN ('cancelled', 'failed')")
      .andWhere('b.created_at >= :from', { from })
      .andWhere('b.created_at < :to', { to })
      .groupBy("COALESCE(b.source_channel, 'direct')")
      .getRawMany(),
    leadRepository
      .createQueryBuilder('l')
      .select('l.source', 'key')
      .addSelect('COUNT(*)', 'count')
      .where('l.tenant_id = :tenantId', { tenantId })
      .andWhere('l.deleted_at IS NULL')
      .andWhere('l.created_at >= :from', { from })
      .andWhere('l.created_at < :to', { to })
      .groupBy('l.source')
      .getRawMany(),
    computeAfterHours(tenantId, from, to, rules),
  ]);

  return {
    conversations: { total: sumCounts(conversationRows), byChannel: toBreakdown(conversationRows) },
    bookings: { total: sumCounts(bookingRows), byChannel: toBreakdown(bookingRows) },
    leads: { total: sumCounts(leadRows), bySource: toBreakdown(leadRows) },
    afterHours,
  };
}

/**
 * GET /analytics/outcomes
 * Business-outcome aggregates (conversations, bookings, leads) for a date
 * range, plus the same aggregates for the preceding same-length window so
 * the portal can render vs-previous-period deltas.
 */
router.get(
  '/outcomes',
  validate(analyticsQuerySchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) {
      throw new BadRequestError('Tenant context required');
    }

    const { from, to, prevFrom, prevTo } = resolveOutcomeWindow(
      req.query.from as string | undefined,
      req.query.to as string | undefined,
    );

    const payload = await cached(
      `outcomes:${tenantId}:${from.toISOString()}:${to.toISOString()}`,
      60,
      async () => {
        // Scheduler business hours, one rule per bot — loaded once for both windows.
        const rules = await availabilityRepository.find({ where: { tenantId } });
        const [current, previous] = await Promise.all([
          computeOutcomes(tenantId, from, to, rules),
          computeOutcomes(tenantId, prevFrom, prevTo, rules),
        ]);
        // Typed against the shared wire contract (src/contracts/analytics.ts).
        const payload: OutcomesResponse = {
          range: { from: from.toISOString(), to: to.toISOString() },
          previousRange: { from: prevFrom.toISOString(), to: prevTo.toISOString() },
          current,
          previous,
        };
        return payload;
      },
    );

    sendSuccess(res, payload);
  })
);

/**
 * GET /analytics/outcomes/timeseries
 * Daily conversations/bookings/leads counts for the range. Days with no
 * activity are absent (same sparse convention as /chats/timeseries).
 */
router.get(
  '/outcomes/timeseries',
  validate(analyticsQuerySchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) {
      throw new BadRequestError('Tenant context required');
    }

    const { from, to } = resolveOutcomeWindow(
      req.query.from as string | undefined,
      req.query.to as string | undefined,
    );

    const [convRows, bookingRows, leadRows] = await Promise.all([
      sessionRepository
        .createQueryBuilder('s')
        .select('DATE(s.created_at)', 'date')
        .addSelect('COUNT(*)', 'count')
        .where('s.tenant_id = :tenantId', { tenantId })
        .andWhere('s.created_at >= :from', { from })
        .andWhere('s.created_at < :to', { to })
        .groupBy('DATE(s.created_at)')
        .orderBy('DATE(s.created_at)', 'ASC')
        .limit(366)
        .getRawMany(),
      bookingRepository
        .createQueryBuilder('b')
        .select('DATE(b.created_at)', 'date')
        .addSelect('COUNT(*)', 'count')
        .where('b.tenant_id = :tenantId', { tenantId })
        .andWhere("b.status NOT IN ('cancelled', 'failed')")
        .andWhere('b.created_at >= :from', { from })
        .andWhere('b.created_at < :to', { to })
        .groupBy('DATE(b.created_at)')
        .orderBy('DATE(b.created_at)', 'ASC')
        .limit(366)
        .getRawMany(),
      leadRepository
        .createQueryBuilder('l')
        .select('DATE(l.created_at)', 'date')
        .addSelect('COUNT(*)', 'count')
        .where('l.tenant_id = :tenantId', { tenantId })
        .andWhere('l.deleted_at IS NULL')
        .andWhere('l.created_at >= :from', { from })
        .andWhere('l.created_at < :to', { to })
        .groupBy('DATE(l.created_at)')
        .orderBy('DATE(l.created_at)', 'ASC')
        .limit(366)
        .getRawMany(),
    ]);

    // Merge the three sparse series into one row per active day.
    const byDate = new Map<string, { date: string; conversations: number; bookings: number; leads: number }>();
    const ensure = (date: string) => {
      let row = byDate.get(date);
      if (!row) {
        row = { date, conversations: 0, bookings: 0, leads: 0 };
        byDate.set(date, row);
      }
      return row;
    };
    for (const r of convRows) ensure(r.date).conversations = parseInt(r.count, 10) || 0;
    for (const r of bookingRows) ensure(r.date).bookings = parseInt(r.count, 10) || 0;
    for (const r of leadRows) ensure(r.date).leads = parseInt(r.count, 10) || 0;

    const timeseries = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

    const seriesPayload: OutcomesTimeseriesResponse = { timeseries };
    sendSuccess(res, seriesPayload);
  })
);

/**
 * GET /analytics/export?dataset=<outcomes-timeseries|gaps|leads>&from=&to=&format=csv
 * Enterprise-gated (aiBusinessInsights, P3 / ADR-0014 D7). Synchronous CSV
 * download (data is small at SMB scale). Range reuses /analytics/outcomes.
 */
router.get(
  '/export',
  validate(analyticsExportQuerySchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const authReq = req as ProvisionedRequest;
    const tenantId = authReq.user?.tenantId;
    if (!tenantId) throw new BadRequestError('Tenant context required');

    const entitlements = await getEntitlements(tenantId);
    if (!entitlements.features.aiBusinessInsights) {
      throw new ForbiddenError('Feature aiBusinessInsights not included in your plan');
    }

    const dataset = String(req.query.dataset ?? '');
    const exporter = getExporter(dataset);
    if (!exporter) {
      throw new BadRequestError(`Unknown dataset — expected one of: ${EXPORT_DATASETS.join(', ')}`);
    }
    const format = String(req.query.format ?? 'csv');
    if (format !== 'csv') throw new BadRequestError("Only format=csv is supported");

    const { from, to } = resolveOutcomeWindow(
      req.query.from as string | undefined,
      req.query.to as string | undefined,
    );
    const rows = await exporter.rows(tenantId, { from, to });
    const csv = toCsv(exporter.headers, rows);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${exporter.filename({ from, to })}"`);
    res.status(200).send(csv);
  })
);

/**
 * POST /analytics/export → 405. The endpoint moved to GET (D7); POST is
 * intentionally gone, not unimplemented.
 */
router.post(
  '/export',
  asyncHandler(async (_req: Request, res: Response) => {
    res.setHeader('Allow', 'GET');
    throw new ApiError('Use GET /analytics/export', 405, ERROR_CODES.METHOD_NOT_ALLOWED);
  })
);

export default router;
