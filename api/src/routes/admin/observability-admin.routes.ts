/**
 * Super-admin observability — a read-only "Rollout Health" operational snapshot
 * over existing data (no new instrumentation). Lets an operator watch the
 * features shipped recently — guardrails shadow→enforce, handoffs, channel
 * delivery + health — across all tenants. Inherits Clerk + autoProvision +
 * super-admin from admin.routes.ts.
 *
 *   GET /admin/observability/overview?days=N   (N clamped 1..90, default 7)
 *   GET /admin/observability/llm-cost?days=N   (same clamp; reads llm_usage_daily)
 *
 * Each aggregate is independent + fail-safe: a single failing metric degrades to
 * 0/[] rather than blanking the whole snapshot. Counts are simple grouped
 * aggregates over (tenant_id, created_at)-indexed tables, run via QueryBuilder so
 * entity→column mapping handles the mixed snake_case / camelCase column naming.
 *
 * Intentionally OUT of v1 (see plan-platform-usage-readiness.md): coalescer lag.
 * Per-call cost/token spend lives in llm_usage_daily. Per-tenant deliveryFailures
 * is omitted too — message_deliveries has no tenant column, so only the platform
 * total is reported. If volume grows, add a Postgres statement_timeout + a
 * message_deliveries (status, "createdAt") index for the failure query.
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
import { PLATFORM_TENANT_SENTINEL } from '../../database/entities/LlmUsageDaily';
import { AgentTrace } from '../../database/entities/AgentTrace';
import { asyncHandler, NotFoundError } from '../../middleware/error-handler';

/** The parts of the persisted `trace` jsonb this endpoint reads. Deliberately
 *  narrow: anything not named here (notably toolCalls args/results) is never
 *  projected onto the response. */
interface TraceShape {
  prompt?: Record<string, unknown>;
  terminal?: { result?: string; error?: { kind?: string; message?: string } };
  /** Guards that made the model try again. Names only — see `AgentTrace.corrections`. */
  corrections?: string[];
  iterations?: Array<{
    llmCall?: { model?: string; latencyMs?: number; promptTokens?: number; completionTokens?: number };
    toolCalls?: Array<{ name: string; latencyMs?: number; result?: { success?: boolean; error?: string } }>;
  }>;
}
import { sendSuccess } from '../../utils/response';
import { logger } from '../../utils/logger';
import { decrypt } from '../../utils/encryption';
import { isCustomerMemoryEnabled } from '../../memory/memory-config';
import { MEMORY_FACT_KEYS, isMemoryFactKey, type MemoryFactKey } from '../../memory/fact-keys';
import { hashSubjectKey } from '../../memory/subject-key';
import type { CustomerMemoryRunState } from '../../database/entities/CustomerMemoryRun';

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
      enforcedResumedRows,
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
      // Implied-FP proxy (INBOUND only, POST-ENFORCE): enforced inbound blocks in
      // the window whose session was later resumed (resume-AI sets guardrail_status
      // back to 'normal' + ai_auto_reply_enabled=true). Empty while 0 tenants
      // enforce — it's a canary metric, NOT a pre-flip gate. Output guardrails never
      // pause, so they can't be proxied this way. (SpamScamLog.conversationId is the
      // chat_sessions id — verified.)
      safe(
        'enforcedResumed',
        AppDataSource.query(
          `SELECT count(*)::int AS n
             FROM guardrail_spam_logs l
             JOIN chat_sessions s ON s.id = l.conversation_id
            WHERE l.enforced = true AND l.created_at >= $1
              AND s.guardrail_status = 'normal' AND s.ai_auto_reply_enabled = true`,
          [since],
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

    // Lazy, not a static import: `travel-health` pulls in the mail and Redis graph, and a new
    // static edge from a route module has reordered module loading and broken unrelated unit
    // tests in this repository before.
    const travelSnapshot = await safe(
      'travelHealth',
      import('../../booking/travel/travel-health').then((m) => m.travelHealthSnapshot()),
      {
        monitoring: 'unknown' as const,
        lastProbe: null,
        incidents: { probe: false, observed: false },
        observedPlatformFailures: 0,
        rates: {},
        spread: { capExhaustedTenants: 0, sharedItineraryBots: 0 },
      },
    );

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
        // Handoff-REQUESTS per session (request-row based — excludes the session-only
        // /handoffs/request path that writes no HandoffRequest; labeled "Handoffs/session"
        // in the UI). A ratio, can exceed 1.
        handoffRate: sessions > 0 ? handoffs / sessions : 0,
        deliveryFailures,
        channelsDown: channelsDownCount,
        enforceOnTenants: enforceRows[0]?.n ?? 0,
        // True-positive load the operator is carrying.
        enforcedBlocks: spamEnforced + outEnforced,
        // Implied-FP proxy — INBOUND only, POST-ENFORCE (empty while 0 tenants
        // enforce). Not a pre-flip gate; the pre-flip FP gate is a manual shadow review.
        impliedInboundFp: {
          enforcedResumed: enforcedResumedRows[0]?.n ?? 0,
          ofEnforcedInbound: spamEnforced,
        },
      },
      channelsDown: channelsDownDetail,
      byTenant: top,
      // #68 §5c. `no_route` and `budget_spent` are watched but never mailed - one of either is
      // ordinary, a sustained rate is a regression - so this is the only place they surface.
      // Alongside them, the last PROBE result, which answers "is routing working" for an operator
      // who would otherwise have to wait for an alert to find out. Read from the cached state, so
      // opening the page never spends an element.
      travel: travelSnapshot,
    });
  }),
);

/**
 * L9/AC4 — list bots whose bound template is UNAVAILABLE (the "missing vertical"),
 * so an operator can find stranded bots instead of scraping warn logs. Deterministic
 * query (no new table, no AgentTrace scan): a bound, live bot whose template is
 * missing/archived OR has no published version. (Pinned-but-unavailable is excluded —
 * it still serves the latest published version.) Mirrors the templateUnavailable
 * classification in template-resolver.
 *
 *   GET /admin/observability/unavailable-templates
 */
router.get(
  '/observability/unavailable-templates',
  asyncHandler(async (_req: Request, res: Response) => {
    const bots = await safe(
      'unavailableTemplates',
      AppDataSource.query(
        `SELECT b.id AS "botId", b.tenant_id AS "tenantId", b.name AS "botName",
                b.template_id AS "templateId", b.template_version AS "pinnedVersion",
                t.name AS "tenantName",
                CASE WHEN bt.id IS NULL OR bt.status <> 'active'
                     THEN 'missing_or_archived' ELSE 'no_published_version' END AS reason
           FROM chatbot_bots b
           JOIN tenants t ON t.id = b.tenant_id
           LEFT JOIN bot_templates bt ON bt.id = b.template_id
          WHERE b.template_id IS NOT NULL
            AND b.deleted_at IS NULL
            AND (
              bt.id IS NULL
              OR bt.status <> 'active'
              OR NOT EXISTS (
                SELECT 1 FROM bot_template_versions v
                 WHERE v.template_id = b.template_id AND v.status = 'published')
            )
          ORDER BY t.name, b.name
          LIMIT 200`,
      ) as Promise<Array<Record<string, unknown>>>,
      [],
    );
    sendSuccess(res, { bots, count: bots.length });
  }),
);

/**
 * GET /admin/observability/traces — recent agent turns, newest first.
 * GET /admin/observability/traces/:id — one turn in full.
 *
 * WHY THIS EXISTS. Diagnosing why a bot said something required querying the
 * production database by hand. Two real bugs were found that way in minutes and
 * would have been invisible for days otherwise: a prompt ledger showing
 * CUSTOM_INSTRUCTIONS included exposed 1211 characters of a previous business's
 * instructions still steering a live bot, and KB_CONTEXT empty with zero tool
 * calls exposed an agent that never retrieved anything and confidently answered
 * "[services not specified]" to a prospect.
 *
 * STRUCTURE, NOT CONTENT — deliberately. Neither diagnosis needed a single tool
 * payload; both needed to know WHICH blocks composed the prompt and WHETHER a
 * tool ran. So this returns block keys, tool names, outcomes and timings, and
 * never `toolCalls[].args` or `toolCalls[].result`.
 *
 * That is not squeamishness. The stored trace masks only a handful of top-level
 * arg fields (email/phone in trace-logger); tool RESULTS are stored raw, so a
 * kb_search or list_bookings result can carry a customer's own content and
 * contact details. Returning the shape sidesteps that entirely rather than
 * relying on a scrubber to be exhaustive.
 */
router.get(
  '/observability/traces',
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, sessionId, finishReason, correction } = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const qb = AppDataSource.getRepository(AgentTrace)
      .createQueryBuilder('t')
      .orderBy('t.createdAt', 'DESC')
      .limit(limit);
    if (tenantId) qb.andWhere('t."tenantId" = :tenantId', { tenantId });
    if (sessionId) qb.andWhere('t."sessionId" = :sessionId', { sessionId });
    // The reason to open this page is usually "something went wrong", so make the
    // failures filterable rather than something to scroll for.
    if (finishReason) qb.andWhere('t."finishReason" = :finishReason', { finishReason });
    // "Is that guard firing, and for whom" in one request. Containment on the jsonb array, so
    // the name is a bound parameter and never concatenated into the SQL.
    if (correction) {
      qb.andWhere(`t.trace -> 'corrections' @> :correction::jsonb`, {
        correction: JSON.stringify([correction]),
      });
    }

    const rows = await qb.getMany();
    const traces = rows.map((r) => {
      const t = (r.trace ?? {}) as TraceShape;
      const iterations = t.iterations ?? [];
      return {
        id: r.id,
        tenantId: r.tenantId,
        sessionId: r.sessionId ?? null,
        createdAt: r.createdAt,
        finishReason: r.finishReason ?? null,
        totalTokens: r.totalTokens ?? null,
        totalLatencyMs: r.totalLatencyMs ?? null,
        // `finishReason` names the SHAPE of the ending; this names the CAUSE. On the list
        // because "which of these errors are the platform's fault" is the first question
        // asked of this page, and opening fifty rows to answer it is not an answer.
        terminalErrorKind: t.terminal?.error?.kind ?? null,
        iterationCount: iterations.length,
        // WHICH GUARDS HAD TO STEP IN. On the list, not just the detail, because the question
        // this answers is "is that guard firing at all" - and opening rows one at a time to
        // find out is how a guard nobody can observe stays unobserved.
        corrections: t.corrections ?? [],
        // The single most diagnostic number on the list: a turn that answered a
        // factual question with zero tool calls never consulted the knowledge base.
        toolCallCount: iterations.reduce((n, it) => n + (it.toolCalls?.length ?? 0), 0),
        model: iterations[0]?.llmCall?.model ?? null,
      };
    });

    sendSuccess(res, { traces, count: traces.length });
  }),
);

/**
 * A DOMAIN error code from a failed tool call, and NOTHING ELSE.
 *
 * `booking.tool.ts` formats a BookingError as "CODE: message" (e.g.
 * "SERVICE_NOT_FOUND: That serviceId is not..."), so the leading UPPER_SNAKE token is a safe,
 * enum-like code. Everything after the colon - and any raw exception with no such prefix - is
 * free text that can carry PII or internal detail, so it is never projected: an unmatched error
 * reports a bare 'error'. This is the one field that made a booking failure diagnosable from the
 * trace at all (a customer told "the service is unavailable" was a bare SERVICE_NOT_FOUND with no
 * visible reason), without loosening the args/results embargo this route exists to enforce.
 */
function toolErrorCode(error: unknown): string {
  const m = typeof error === 'string' ? /^([A-Z][A-Z0-9_]{2,}):/.exec(error) : null;
  return m ? m[1] : 'error';
}

router.get(
  '/observability/traces/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const row = await AppDataSource.getRepository(AgentTrace).findOne({ where: { id: req.params.id } });
    if (!row) throw new NotFoundError('Trace not found');

    const t = (row.trace ?? {}) as TraceShape;
    sendSuccess(res, {
      trace: {
        id: row.id,
        tenantId: row.tenantId,
        sessionId: row.sessionId ?? null,
        messageId: row.messageId ?? null,
        createdAt: row.createdAt,
        finishReason: row.finishReason ?? null,
        totalTokens: row.totalTokens ?? null,
        totalLatencyMs: row.totalLatencyMs ?? null,
        // Which guards had to step in, in the order they fired.
        corrections: t.corrections ?? [],
        // The prompt ledger is the payload here: block keys and the REASON each
        // was excluded. No prompt text, so nothing tenant-authored leaks.
        prompt: t.prompt ?? null,
        // Why the run ended. Super-admin only, like the rest of this route, and the
        // message is the error's own words truncated at the writer — never a stack.
        terminal: t.terminal ?? null,
        iterations: (t.iterations ?? []).map((it, i) => ({
          index: i,
          model: it.llmCall?.model ?? null,
          latencyMs: it.llmCall?.latencyMs ?? null,
          promptTokens: it.llmCall?.promptTokens ?? null,
          completionTokens: it.llmCall?.completionTokens ?? null,
          // Names + outcomes only, plus a DOMAIN error CODE on failure (never args, results, or
          // the error's free-text message — see toolErrorCode).
          toolCalls: (it.toolCalls ?? []).map((tc) => ({
            name: tc.name,
            ok: tc.result?.success !== false,
            ...(tc.result?.success === false ? { errorCode: toolErrorCode(tc.result?.error) } : {}),
            latencyMs: tc.latencyMs ?? null,
          })),
        })),
      },
    });
  }),
);

const MEMORY_RUN_STATES: CustomerMemoryRunState[] = [
  'pending',
  'claimed',
  'extracted',
  'abstained',
  'failed',
  'skipped_disabled',
  'skipped_no_subject',
];

function clampDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 7;
  return Math.min(90, Math.max(1, Math.trunc(n)));
}

function countN(rows: Array<{ n?: number }> | undefined): number {
  return Number(rows?.[0]?.n ?? 0);
}

function tallyRuns(rows: Array<{ state: string; n: number }>): Record<CustomerMemoryRunState, number> {
  const runsByState = Object.fromEntries(MEMORY_RUN_STATES.map((s) => [s, 0])) as Record<CustomerMemoryRunState, number>;
  for (const row of rows) {
    if ((MEMORY_RUN_STATES as string[]).includes(row.state)) {
      runsByState[row.state as CustomerMemoryRunState] = Number(row.n);
    }
  }
  return runsByState;
}

function tallyFactKeys(rows: Array<{ fact_key: string; n: number }>): Record<MemoryFactKey, number> {
  const factsByKey = Object.fromEntries(MEMORY_FACT_KEYS.map((k) => [k, 0])) as Record<MemoryFactKey, number>;
  for (const row of rows) {
    if (isMemoryFactKey(row.fact_key)) factsByKey[row.fact_key] = Number(row.n);
  }
  return factsByKey;
}

async function customerMemorySnapshot(days: number) {
  const window = String(days);
  const [subjects, withPerson, liveFacts, superseded, runRows, factKeyRows, injections, extractStats, stuck] =
    await Promise.all([
      safe('memory.subjects', AppDataSource.query(`SELECT count(*)::int AS n FROM chatbot_customer_memory`), [{ n: 0 }]),
      safe(
        'memory.subjectsWithPersonKey',
        AppDataSource.query(`SELECT count(*)::int AS n FROM chatbot_customer_memory WHERE person_key IS NOT NULL`),
        [{ n: 0 }],
      ),
      safe(
        'memory.liveFacts',
        AppDataSource.query(`SELECT count(*)::int AS n FROM chatbot_customer_facts WHERE superseded_at IS NULL`),
        [{ n: 0 }],
      ),
      safe(
        'memory.supersededFacts',
        AppDataSource.query(`SELECT count(*)::int AS n FROM chatbot_customer_facts WHERE superseded_at IS NOT NULL`),
        [{ n: 0 }],
      ),
      safe(
        'memory.runsByState',
        AppDataSource.query(`SELECT state, count(*)::int AS n FROM chatbot_customer_memory_runs GROUP BY state`),
        [] as Array<{ state: string; n: number }>,
      ),
      safe(
        'memory.factsByKey',
        AppDataSource.query(
          `SELECT fact_key, count(*)::int AS n FROM chatbot_customer_facts WHERE superseded_at IS NULL GROUP BY fact_key`,
        ),
        [] as Array<{ fact_key: string; n: number }>,
      ),
      safe(
        'memory.injections',
        AppDataSource.query(
          `SELECT count(*)::int AS turns,
                  count(*) FILTER (WHERE trace->'customerMemory'->>'injected' = 'true')::int AS with_memory
             FROM agent_traces
            WHERE "createdAt" >= now() - ($1 || ' days')::interval`,
          [window],
        ),
        [{ turns: 0, with_memory: 0 }],
      ),
      safe(
        'memory.extractStats',
        AppDataSource.query(
          `SELECT count(*) FILTER (WHERE state = 'extracted')::int AS extracted,
                  count(*) FILTER (WHERE state = 'abstained')::int AS abstained,
                  coalesce(avg(facts_written) FILTER (WHERE state = 'extracted'), 0)::float AS avg_facts
             FROM chatbot_customer_memory_runs
            WHERE updated_at >= now() - ($1 || ' days')::interval`,
          [window],
        ),
        [{ extracted: 0, abstained: 0, avg_facts: 0 }],
      ),
      safe(
        'memory.stuck',
        AppDataSource.query(
          `SELECT
             (SELECT count(*)::int FROM chatbot_customer_memory_runs
               WHERE state = 'claimed' AND claimed_until IS NOT NULL
                 AND claimed_until < now() - interval '10 minutes') AS expired_leases,
             (SELECT count(*)::int FROM chatbot_customer_memory_runs
               WHERE state = 'failed' AND attempts >= 3) AS exhausted_attempts`,
        ),
        [{ expired_leases: 0, exhausted_attempts: 0 }],
      ),
    ]);

  const extracted = Number(extractStats[0].extracted);
  const abstained = Number(extractStats[0].abstained);
  return {
    enabled: isCustomerMemoryEnabled(),
    subjects: countN(subjects),
    subjectsWithPersonKey: countN(withPerson),
    liveFacts: countN(liveFacts),
    supersededFacts: countN(superseded),
    runsByState: tallyRuns(runRows),
    factsByKey: tallyFactKeys(factKeyRows),
    injections: {
      turns: Number(injections[0].turns),
      withMemory: Number(injections[0].with_memory),
    },
    abstainRate: extracted + abstained === 0 ? 0 : abstained / (extracted + abstained),
    avgFactsPerExtractedRun: Number(extractStats[0].avg_facts),
    stuck: {
      expiredLeases: Number(stuck[0].expired_leases),
      exhaustedAttempts: Number(stuck[0].exhausted_attempts),
    },
  };
}

router.get(
  '/observability/customer-memory',
  asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await customerMemorySnapshot(clampDays(req.query.days)));
  }),
);

router.get(
  '/observability/customer-memory/subjects',
  asyncHandler(async (req: Request, res: Response) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(20, Math.max(1, Math.trunc(limitRaw))) : 20;
    if (!q) {
      sendSuccess(res, { subjects: [] });
      return;
    }
    const rows: Array<{
      id: string;
      tenant_id: string;
      channel: string | null;
      first_seen_at: Date;
      last_seen_at: Date;
      session_count: number;
      live_fact_count: number;
      person_key: string | null;
    }> = await AppDataSource.query(
      `SELECT id, tenant_id, channel, first_seen_at, last_seen_at, session_count, live_fact_count, person_key
         FROM chatbot_customer_memory
        WHERE subject_key = $1 OR person_key = $1
        LIMIT $2`,
      [q, limit],
    );
    sendSuccess(res, {
      key: q,
      subjects: rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        channel: row.channel,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        sessionCount: Number(row.session_count),
        liveFactCount: Number(row.live_fact_count),
        hasPersonKey: row.person_key != null,
      })),
    });
  }),
);

router.get(
  '/observability/customer-memory/subjects/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const [subject] = await AppDataSource.query(
      `SELECT id, tenant_id, channel, subject_key, first_seen_at, last_seen_at,
              session_count, live_fact_count, person_key
         FROM chatbot_customer_memory WHERE id = $1`,
      [req.params.id],
    );
    if (!subject) throw new NotFoundError('Customer memory subject not found');
    logger.info('[customer-memory] admin read', {
      memoryId: subject.id,
      actorId: req.userId ?? (req as { user?: { id?: string } }).user?.id,
    });
    const facts: Array<{
      fact_key: string;
      value_enc: string;
      value_encrypted: boolean;
      confidence: number;
      evidence_span: string | null;
      source_session_id: string | null;
      first_seen_at: Date;
      last_confirmed_at: Date;
      superseded_at: Date | null;
    }> = await AppDataSource.query(
      `SELECT fact_key, value_enc, value_encrypted, confidence, evidence_span, source_session_id,
              first_seen_at, last_confirmed_at, superseded_at
         FROM chatbot_customer_facts
        WHERE memory_id = $1
        ORDER BY last_confirmed_at DESC, created_at DESC`,
      [subject.id],
    );
    sendSuccess(res, {
      id: subject.id,
      tenantId: subject.tenant_id,
      channel: subject.channel,
      subjectKeyHash: hashSubjectKey(subject.subject_key),
      firstSeenAt: subject.first_seen_at,
      lastSeenAt: subject.last_seen_at,
      sessionCount: Number(subject.session_count),
      liveFactCount: Number(subject.live_fact_count),
      hasPersonKey: subject.person_key != null,
      facts: facts.map((f) => {
        let value = '';
        try {
          value = f.value_encrypted ? decrypt(f.value_enc) : f.value_enc;
        } catch {
          value = '';
        }
        return {
          factKey: f.fact_key,
          value,
          confidence: Number(f.confidence),
          evidenceSpan: f.evidence_span,
          sourceSessionId: f.source_session_id,
          firstSeenAt: f.first_seen_at,
          lastConfirmedAt: f.last_confirmed_at,
          supersededAt: f.superseded_at,
        };
      }),
    });
  }),
);

router.get(
  '/observability/llm-cost',
  asyncHandler(async (req: Request, res: Response) => {
    const days = clampDays(req.query.days);

    type PathRow = {
      path: string;
      model: string;
      calls: string | number;
      promptTokens: string | number;
      completionTokens: string | number;
      costUsd: string | number;
    };
    type TenantCostRow = {
      tenantId: string;
      name: string | null;
      calls: string | number;
      costUsd: string | number;
    };

    const [byPathRaw, byTenantRaw] = await Promise.all([
      safe(
        'llmCostByPath',
        AppDataSource.query(
          `SELECT path, model,
                  SUM(calls) AS calls,
                  SUM(prompt_tokens) AS "promptTokens",
                  SUM(completion_tokens) AS "completionTokens",
                  SUM(cost_usd) AS "costUsd"
             FROM llm_usage_daily
            WHERE day >= CURRENT_DATE - ($1::int - 1)
            GROUP BY path, model
            ORDER BY SUM(cost_usd) DESC`,
          [days],
        ) as Promise<PathRow[]>,
        [] as PathRow[],
      ),
      safe(
        'llmCostByTenant',
        AppDataSource.query(
          `SELECT u.tenant_id AS "tenantId",
                  t.name AS name,
                  SUM(u.calls) AS calls,
                  SUM(u.cost_usd) AS "costUsd"
             FROM llm_usage_daily u
             LEFT JOIN tenants t ON t.id = u.tenant_id
            WHERE u.day >= CURRENT_DATE - ($1::int - 1)
            GROUP BY u.tenant_id, t.name
            ORDER BY SUM(u.cost_usd) DESC
            LIMIT 50`,
          [days],
        ) as Promise<TenantCostRow[]>,
        [] as TenantCostRow[],
      ),
    ]);

    const byPath = byPathRaw.map((row) => ({
      path: row.path,
      model: row.model,
      calls: Number(row.calls),
      promptTokens: Number(row.promptTokens),
      completionTokens: Number(row.completionTokens),
      costUsd: Number(row.costUsd),
    }));
    const byTenant = byTenantRaw.map((row) => ({
      tenantId: row.tenantId === PLATFORM_TENANT_SENTINEL ? null : row.tenantId,
      name: row.tenantId === PLATFORM_TENANT_SENTINEL ? 'platform' : row.name,
      calls: Number(row.calls),
      costUsd: Number(row.costUsd),
    }));
    const totalCostUsd = byPath.reduce((sum, row) => sum + row.costUsd, 0);

    sendSuccess(res, {
      days,
      totalCostUsd,
      byPath,
      byTenant,
    });
  }),
);

export default router;
