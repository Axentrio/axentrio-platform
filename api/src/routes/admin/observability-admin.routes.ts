/**
 * Super-admin observability — a read-only "Rollout Health" operational snapshot
 * over existing data (no new instrumentation). Lets an operator watch the
 * features shipped recently — guardrails shadow→enforce, handoffs, channel
 * delivery + health — across all tenants. Inherits Clerk + autoProvision +
 * super-admin from admin.routes.ts.
 *
 *   GET /admin/observability/overview?days=N   (N clamped 1..90, default 7)
 *
 * Each aggregate is independent + fail-safe: a single failing metric degrades to
 * 0/[] rather than blanking the whole snapshot. Counts are simple grouped
 * aggregates over (tenant_id, created_at)-indexed tables, run via QueryBuilder so
 * entity→column mapping handles the mixed snake_case / camelCase column naming.
 *
 * Intentionally OUT of v1 (see plan-platform-usage-readiness.md): per-call
 * cost/token spend (no durable per-call usage table — needs new instrumentation)
 * and coalescer lag. Per-tenant deliveryFailures is omitted too — message_deliveries
 * has no tenant column, so only the platform total is reported. If volume grows,
 * add a Postgres statement_timeout + a message_deliveries (status, "createdAt")
 * index for the failure query.
 */
import { Router, Request, Response } from 'express';
import { In, ObjectLiteral, Repository } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { ChatSession } from '../../database/entities/ChatSession';
import { Message } from '../../database/entities/Message';
import { SpamScamLog } from '../../database/entities/SpamScamLog';
import { GuardrailOutputLog } from '../../database/entities/GuardrailOutputLog';
import { HandoffRequest } from '../../database/entities/HandoffRequest';
import { MessageDelivery } from '../../database/entities/MessageDelivery';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { Tenant } from '../../database/entities/Tenant';
import { asyncHandler } from '../../middleware/error-handler';
import { sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';

const router = Router();

/**
 * Run a metric query, degrading to a fallback so one failing metric can't blank
 * the whole snapshot — but log it (named) so a silent false-zero doesn't hide a
 * real schema/query bug.
 */
const safe = <T>(metric: string, p: Promise<T>, fallback: T): Promise<T> =>
  p.catch((err) => {
    logger.warn('[observability] metric query failed', {
      metric,
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  });

interface TenantRow {
  tenantId: string;
  name: string | null;
  tier: string | null;
  sessions: number;
  messages: number;
  guardrailBlocks: number;
  handoffs: number;
}

/**
 * `SELECT tenant_id, COUNT(*)` grouped over a (tenant_id, created_at) table,
 * filtered to the window. Property syntax (`alias.tenantId`/`alias.createdAt`) so
 * TypeORM maps to the real column regardless of snake_case / camelCase naming.
 */
function tenantGroup<T extends ObjectLiteral>(
  repo: Repository<T>,
  alias: string,
  since: Date,
): Promise<Array<{ tenantId: string; count: string }>> {
  return repo
    .createQueryBuilder(alias)
    .select(`${alias}.tenantId`, 'tenantId')
    .addSelect('COUNT(*)', 'count')
    .where(`${alias}.createdAt >= :since`, { since })
    .groupBy(`${alias}.tenantId`)
    .getRawMany<{ tenantId: string; count: string }>();
}

router.get(
  '/observability/overview',
  asyncHandler(async (req: Request, res: Response) => {
    const rawDays = parseInt(String(req.query.days ?? ''), 10);
    const days = Number.isFinite(rawDays) ? Math.min(90, Math.max(1, rawDays)) : 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const sessionRepo = AppDataSource.getRepository(ChatSession);
    const messageRepo = AppDataSource.getRepository(Message);
    const spamRepo = AppDataSource.getRepository(SpamScamLog);
    const outputRepo = AppDataSource.getRepository(GuardrailOutputLog);
    const handoffRepo = AppDataSource.getRepository(HandoffRequest);
    const deliveryRepo = AppDataSource.getRepository(MessageDelivery);
    const channelRepo = AppDataSource.getRepository(ChannelConnection);

    const [
      sessions,
      messages,
      spamEnforced,
      spamShadow,
      outEnforced,
      outShadow,
      handoffs,
      openHandoffs,
      deliveryFailures,
      channelsDownCount,
      channelsDownDetail,
      enforceRows,
      sessionsByTenant,
      messagesByTenant,
      spamByTenant,
      outputByTenant,
      handoffsByTenant,
    ] = await Promise.all([
      safe('sessions', sessionRepo.createQueryBuilder('s').where('s.createdAt >= :since', { since }).getCount(), 0),
      safe('messages', messageRepo.createQueryBuilder('m').where('m.createdAt >= :since', { since }).getCount(), 0),
      safe('spamEnforced', spamRepo.createQueryBuilder('l').where('l.createdAt >= :since', { since }).andWhere('l.enforced = true').getCount(), 0),
      safe('spamShadow', spamRepo.createQueryBuilder('l').where('l.createdAt >= :since', { since }).andWhere('l.enforced = false').getCount(), 0),
      safe('outEnforced', outputRepo.createQueryBuilder('l').where('l.createdAt >= :since', { since }).andWhere('l.enforced = true').getCount(), 0),
      safe('outShadow', outputRepo.createQueryBuilder('l').where('l.createdAt >= :since', { since }).andWhere('l.enforced = false').getCount(), 0),
      safe('handoffs', handoffRepo.createQueryBuilder('h').where('h.createdAt >= :since', { since }).getCount(), 0),
      safe('openHandoffs', handoffRepo.createQueryBuilder('h').where('h.status = :st', { st: 'requested' }).getCount(), 0),
      safe('deliveryFailures', deliveryRepo.createQueryBuilder('d').where('d.status = :st', { st: 'failed' }).andWhere('d.createdAt >= :since', { since }).getCount(), 0),
      // Count is independent of the detail cap below (don't derive the total from a
      // capped list).
      safe('channelsDownCount', channelRepo.count({ where: { status: 'error' } }), 0),
      safe(
        'channelsDownDetail',
        channelRepo.find({
          where: { status: 'error' },
          select: ['tenantId', 'channel', 'label', 'lastError'],
          order: { updatedAt: 'DESC' },
          take: 50,
        }),
        [],
      ),
      safe(
        'enforceOnTenants',
        AppDataSource.query(
          `SELECT count(*)::int AS n FROM tenants WHERE settings->'guardrails'->>'enforce' = 'true'`,
        ) as Promise<Array<{ n: number }>>,
        [{ n: 0 }],
      ),
      safe('sessionsByTenant', tenantGroup(sessionRepo, 's', since), []),
      safe('messagesByTenant', tenantGroup(messageRepo, 'm', since), []),
      safe('spamByTenant', tenantGroup(spamRepo, 'l', since), []),
      safe('outputByTenant', tenantGroup(outputRepo, 'l', since), []),
      safe('handoffsByTenant', tenantGroup(handoffRepo, 'h', since), []),
    ]);

    // ---- merge per-tenant aggregates by tenantId ----
    const byTenantMap = new Map<string, TenantRow>();
    const row = (id: string): TenantRow => {
      let r = byTenantMap.get(id);
      if (!r) {
        r = { tenantId: id, name: null, tier: null, sessions: 0, messages: 0, guardrailBlocks: 0, handoffs: 0 };
        byTenantMap.set(id, r);
      }
      return r;
    };
    for (const r of sessionsByTenant) row(r.tenantId).sessions += Number(r.count);
    for (const r of messagesByTenant) row(r.tenantId).messages += Number(r.count);
    for (const r of spamByTenant) row(r.tenantId).guardrailBlocks += Number(r.count);
    for (const r of outputByTenant) row(r.tenantId).guardrailBlocks += Number(r.count);
    for (const r of handoffsByTenant) row(r.tenantId).handoffs += Number(r.count);

    // Top 20 tenants by TOTAL activity (so guardrail/handoff-only tenants aren't
    // dropped), then attach name/tier.
    const activity = (r: TenantRow) => r.sessions + r.messages + r.guardrailBlocks + r.handoffs;
    const top = [...byTenantMap.values()].sort((a, b) => activity(b) - activity(a)).slice(0, 20);
    if (top.length) {
      const tenants = await safe(
        'tenantMeta',
        AppDataSource.getRepository(Tenant).find({
          where: { id: In(top.map((r) => r.tenantId)) },
          select: ['id', 'name', 'tier'],
        }),
        [],
      );
      const meta = new Map(tenants.map((t) => [t.id, t]));
      for (const r of top) {
        const t = meta.get(r.tenantId);
        r.name = t?.name ?? null;
        r.tier = t?.tier ?? null;
      }
    }

    sendSuccess(res, {
      windowDays: days,
      totals: {
        sessions,
        messages,
        guardrailInbound: { enforced: spamEnforced, shadow: spamShadow },
        guardrailOutput: { enforced: outEnforced, shadow: outShadow },
        handoffs,
        openHandoffs,
        deliveryFailures,
        channelsDown: channelsDownCount,
        enforceOnTenants: enforceRows[0]?.n ?? 0,
      },
      channelsDown: channelsDownDetail,
      byTenant: top,
    });
  }),
);

export default router;
