/**
 * Conversation Command Service (B-PR2b) — the ONE transactional seam for every
 * ownership / handoff write.
 *
 * Plan: .scratch/plan-pilot-operations-timezone-routing.md §B1/B2/B6 + the
 * "Codex round 1" locked decisions. Rules this file owns:
 *
 *  - Every command runs in ONE DB transaction that locks the chat_sessions row
 *    FOR UPDATE first (and the open handoff_requests row where relevant), so
 *    concurrent commands on the same conversation serialize behind the row lock.
 *  - Every ownership transition writes `ownership` AND the legacy `status`
 *    (derived via deriveStatusFromOwnership) in the same UPDATE, and bumps the
 *    monotonic `ownership_version`. Existing readers keep working; the AI
 *    finalization fence keys off the version.
 *  - Every applied transition persists exactly ONE system event (a `system`
 *    Message under a per-session system Participant — the legacy routes wrote
 *    participant_id='system' which violates the uuid FK and never landed).
 *  - Idempotency: a command that carries a client idempotency key stores its
 *    committed result in conversation_commands INSIDE the transaction; a retry
 *    replays the stored result instead of re-applying. The replay check runs
 *    AFTER the session row lock, so a racing duplicate serializes and then sees
 *    the winner's committed row (READ COMMITTED gives each statement a fresh
 *    snapshot).
 *  - Socket fan-out / notifications stay at the CALL SITES (D4: commands
 *    mutate, sockets distribute committed facts). This service never emits.
 *
 * Targeted column UPDATEs only — never save(session) — so the coalescer
 * watermark columns can never be clobbered by a stale in-memory entity.
 */

import { EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AppDataSource } from '../database/data-source';
import { ChatSession, SessionStatus, SessionOwnership } from '../database/entities/ChatSession';
import { HandoffRequest, HandoffReason } from '../database/entities/HandoffRequest';
import { NotificationOutbox, HANDOFF_OUTBOX_GRACE_MS } from '../database/entities/NotificationOutbox';
import { ConversationCommand } from '../database/entities/ConversationCommand';
import { Participant } from '../database/entities/Participant';
import { Message } from '../database/entities/Message';
import { Agent } from '../database/entities/Agent';
import { User } from '../database/entities/User';
import { deriveStatusFromOwnership } from './session-ownership';
import { returningRows } from '../utils/raw-sql';
import {
  getBotConfigForSession,
  BotPausedConfigError,
  BotNotFoundConfigError,
} from './bot-config.service';
import { ApiError, NotFoundError, BadRequestError } from '../middleware/error-handler';
import { encrypt } from '../utils/encryption';
import { logger } from '../utils/logger';

// ── Typed errors ─────────────────────────────────────────────────────────────
// All extend ApiError so the REST layer's asyncHandler/errorHandler produce the
// standard envelope with a STABLE machine-readable code.

export class ConversationAlreadyClaimedError extends ApiError {
  constructor(assignedAgentId?: string) {
    super(
      'Another operator already owns this conversation',
      409,
      'conversation_already_claimed',
      assignedAgentId ? { assignedAgentId } : undefined,
    );
  }
}

export class ConversationClosedError extends ApiError {
  constructor() {
    super('The conversation is closed', 409, 'conversation_closed');
  }
}

export class InvalidOwnershipTransitionError extends ApiError {
  constructor(from: SessionOwnership, command: string) {
    super(`Cannot ${command} a conversation in ownership state '${from}'`, 409, 'invalid_ownership_transition', { from });
  }
}

export class NotConversationOwnerError extends ApiError {
  constructor() {
    super('You are not assigned to this conversation', 403, 'not_conversation_owner');
  }
}

export class OperatorNotInTenantError extends ApiError {
  constructor() {
    super('Operator not found in this workspace', 403, 'operator_not_in_tenant');
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

/** 1–24h timed control or an indefinite AI block. B-PR5a ships the expiry
 *  worker (server.ts sweep + the inbound check in message-forwarding), so the
 *  REST layer now exposes 'timed' as well (codex ordering satisfied: a timed
 *  claim only exists together with a working expiry path). */
export type HumanControlPolicy = { mode: 'indefinite' } | { mode: 'timed'; hours: number };

export type ConversationActor =
  | { kind: 'agent'; agentId: string }
  | { kind: 'customer' }
  | { kind: 'system'; source?: string };

export type HandoffSource = 'bot' | 'widget' | 'socket' | 'api' | 'system';

/** Committed conversation facts, JSON-stable (dates as ISO strings) so a stored
 *  idempotency result replays byte-identical. */
export interface ConversationSummary {
  sessionId: string;
  tenantId: string;
  status: SessionStatus;
  ownership: SessionOwnership;
  ownershipVersion: number;
  assignedAgentId: string | null;
  humanControlMode: 'timed' | 'indefinite' | null;
  humanControlDurationHours: number | null;
  humanControlUntil: string | null;
  humanControlStartedAt: string | null;
  openHandoffId: string | null;
}

export interface RequestHandoffResult {
  outcome: 'requested' | 'already_requested' | 'already_human_owned' | 'handoff_disabled';
  handoffId: string | null;
  conversation: ConversationSummary;
  replayed?: boolean;
}

export interface ClaimResult {
  outcome: 'claimed' | 'already_owned';
  /** B-PR5a: true when a same-owner re-claim carried an explicit policy and the
   *  human_control_* columns were rewritten (the "change duration" path). */
  policyUpdated?: boolean;
  conversation: ConversationSummary;
  replayed?: boolean;
}

export interface SendHumanMessageResult {
  outcome: 'sent' | 'duplicate';
  autoClaimed: boolean;
  message: { id: string; createdAt: string };
  conversation: ConversationSummary;
  replayed?: boolean;
}

export interface ReleaseResult {
  outcome: 'released' | 'already_bot_owned';
  conversation: ConversationSummary;
  replayed?: boolean;
}

export interface ExpireHumanControlResult {
  /** 'released' = the timed deadline had passed and the conversation went back
   *  to the bot. 'not_expired' = the locked row's deadline is in the future (an
   *  operator re-claimed or a committed human reply slid it; the caller's read
   *  was stale). 'not_applicable' = not human_owned / not timed anymore (an
   *  operator released or closed it meanwhile). The last two are the no-op
   *  outcomes that make the expiry sweep and the inbound check re-entrant. */
  outcome: 'released' | 'not_expired' | 'not_applicable';
  conversation: ConversationSummary;
  replayed?: boolean;
}

export interface CancelResult {
  outcome: 'cancelled' | 'already_bot_owned';
  conversation: ConversationSummary;
  replayed?: boolean;
}

export interface CloseResult {
  outcome: 'closed' | 'already_closed';
  conversation: ConversationSummary;
  replayed?: boolean;
}

export interface TransferResult {
  outcome: 'transferred';
  conversation: ConversationSummary;
  replayed?: boolean;
}

type CommandName =
  | 'request_handoff'
  | 'claim'
  | 'send_message'
  | 'release'
  | 'cancel_handoff'
  | 'close'
  | 'transfer';

interface CommandOpts {
  /** Tenant scoping; when set the session must belong to it (404 otherwise, no
   *  cross-tenant probe distinction). System sweeps omit it. */
  tenantId?: string;
  /**
   * Super-admin impersonation (X-Tenant-Context): the caller's support_agents
   * row lives in their HOME tenant (`user_id` is globally unique), so the
   * tenant-scoped lookup would 403. Still requires a real agent row.
   */
  allowForeignAgent?: boolean;
  /**
   * Run the command inside the CALLER'S transaction instead of opening one
   * (B-PR4a: the widget new-conversation close-and-open must be atomic under
   * one advisory lock). The caller owns commit/rollback; every rule above -
   * row lock first, targeted UPDATEs, one system event - applies unchanged
   * because the same code runs on the provided manager.
   */
  manager?: EntityManager;
}

// ── Core helpers ─────────────────────────────────────────────────────────────

/**
 * One transaction per command: lock the session row FOR UPDATE, replay a stored
 * idempotent result if the key was already committed, otherwise apply + store.
 */
async function withConversation<T extends { conversation: ConversationSummary }>(
  sessionId: string,
  command: CommandName,
  idempotencyKey: string | undefined,
  opts: CommandOpts,
  apply: (manager: EntityManager, session: ChatSession) => Promise<T>,
): Promise<T> {
  const run = async (manager: EntityManager) => {
    const session = await manager.findOne(ChatSession, {
      where: { id: sessionId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!session || (opts.tenantId && session.tenantId !== opts.tenantId)) {
      throw new NotFoundError('Session not found');
    }

    if (idempotencyKey) {
      const prior = await manager.findOne(ConversationCommand, {
        where: { sessionId, command, idempotencyKey },
      });
      if (prior) {
        return { ...(prior.result as unknown as T), replayed: true };
      }
    }

    const result = await apply(manager, session);

    if (idempotencyKey) {
      await manager.insert(ConversationCommand, {
        sessionId,
        tenantId: session.tenantId,
        command,
        idempotencyKey,
        result: result as unknown as Record<string, unknown>,
      } as QueryDeepPartialEntity<ConversationCommand>);
    }
    return result;
  };
  // Caller-owned transaction (opts.manager) or our own - same body either way.
  if (opts.manager) return run(opts.manager);
  return AppDataSource.transaction(run);
}

/**
 * Apply an ownership transition: ownership + derived legacy status + version
 * bump + any extra columns, in one targeted UPDATE. Mutates the locked
 * in-memory entity to match (safe: we hold the row lock).
 */
async function applyOwnershipTransition(
  manager: EntityManager,
  session: ChatSession,
  next: SessionOwnership,
  patch: Record<string, unknown> = {},
): Promise<void> {
  let nextStatus = deriveStatusFromOwnership(next, session.status);
  // A conversation returned to BOT ownership must land on a status the AI
  // pipeline actually serves (forwardMessageToN8n/runTurn gate on
  // 'bot'/'waiting'). deriveStatusFromOwnership preserves a legacy 'active',
  // which would silence the bot forever after releasing a legacy-claimed
  // conversation — exactly what the old /handoff/return avoided by writing
  // 'bot'. Adjust here, in the one writer, instead of changing the shared util.
  if (next === 'bot_owned' && nextStatus === 'active') nextStatus = 'bot';

  await manager.update(
    ChatSession,
    session.id,
    {
      ownership: next,
      status: nextStatus,
      ownershipVersion: () => 'ownership_version + 1',
      ...patch,
    } as QueryDeepPartialEntity<ChatSession>,
  );

  session.ownership = next;
  session.status = nextStatus;
  session.ownershipVersion = (session.ownershipVersion ?? 0) + 1;
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v !== 'function') (session as unknown as Record<string, unknown>)[k] = v;
  }
}

/**
 * Persist the command's single system event. Legacy routes wrote
 * participant_id='system' (an invalid uuid — the insert always failed on the
 * FK); this creates a real per-session system Participant once.
 */
async function persistSystemEvent(
  manager: EntityManager,
  session: ChatSession,
  content: string,
): Promise<void> {
  let sys = await manager.findOne(Participant, {
    where: { sessionId: session.id, type: 'system', isDeleted: false },
  });
  if (!sys) {
    sys = await manager.save(
      Participant,
      manager.create(Participant, {
        sessionId: session.id,
        type: 'system',
        name: 'System',
        isAnonymous: false,
        joinedAt: new Date(),
      }),
    );
  }
  await manager.save(
    Message,
    manager.create(Message, {
      sessionId: session.id,
      tenantId: session.tenantId,
      participantId: sys.id,
      type: 'system' as Message['type'],
      content,
      status: 'sent' as Message['status'],
      sentAt: new Date(),
    }),
  );
}

/** Lock (FOR UPDATE) and return the newest handoff in one of `statuses`. */
async function lockHandoff(
  manager: EntityManager,
  sessionId: string,
  statuses: Array<HandoffRequest['status']>,
): Promise<HandoffRequest | null> {
  return manager
    .getRepository(HandoffRequest)
    .createQueryBuilder('h')
    .setLock('pessimistic_write')
    .where('h.sessionId = :sid', { sid: sessionId })
    .andWhere('h.status IN (:...statuses)', { statuses })
    .orderBy('h.requestedAt', 'DESC')
    .getOne();
}

async function requireTenantAgent(
  manager: EntityManager,
  tenantId: string,
  agentId: string,
  opts?: Pick<CommandOpts, 'allowForeignAgent'>,
): Promise<Agent> {
  const agent = opts?.allowForeignAgent
    ? await manager.findOne(Agent, { where: { id: agentId } })
    : await manager.findOne(Agent, { where: { id: agentId, tenantId } });
  if (!agent) throw new OperatorNotInTenantError();
  return agent;
}

function summarize(session: ChatSession, openHandoffId: string | null): ConversationSummary {
  return {
    sessionId: session.id,
    tenantId: session.tenantId,
    status: session.status,
    ownership: session.ownership,
    ownershipVersion: session.ownershipVersion ?? 0,
    assignedAgentId: session.assignedAgentId ?? null,
    humanControlMode: session.humanControlMode ?? null,
    humanControlDurationHours: session.humanControlDurationHours ?? null,
    humanControlUntil: session.humanControlUntil ? new Date(session.humanControlUntil).toISOString() : null,
    humanControlStartedAt: session.humanControlStartedAt
      ? new Date(session.humanControlStartedAt).toISOString()
      : null,
    openHandoffId,
  };
}

/**
 * Targeted-UPDATE column values for a human-control policy. DB-CLOCK AUTHORITY
 * (codex review fix 1): started_at and until are SQL expressions (`now()` plus
 * an interval), never JS dates, so ONE clock - Postgres - governs the claim,
 * the slide, the policy update, the worker's expiry SELECT, and the expiry
 * re-check alike. A node whose JS clock runs behind or ahead of the DB can
 * therefore neither starve the sweep ('not_expired' forever) nor release
 * early. `hours` is validated to an integer 1..24 BEFORE it is interpolated
 * into the raw expression (no injection surface).
 *
 * The function-valued entries are skipped by applyOwnershipTransition's
 * in-memory patch loop - callers re-read the committed timestamps via
 * syncHumanControlTimestamps so the returned summary carries DB values.
 */
function humanControlColumns(policy: HumanControlPolicy): Record<string, unknown> {
  if (policy.mode === 'timed') {
    if (!Number.isInteger(policy.hours) || policy.hours < 1 || policy.hours > 24) {
      throw new BadRequestError('Timed control requires an integer hours value between 1 and 24');
    }
    const hours = policy.hours;
    return {
      humanControlMode: 'timed',
      humanControlDurationHours: hours,
      humanControlStartedAt: () => 'now()',
      humanControlUntil: () => `now() + make_interval(hours => ${hours})`,
    };
  }
  return {
    humanControlMode: 'indefinite',
    humanControlDurationHours: null,
    humanControlStartedAt: () => 'now()',
    humanControlUntil: null,
  };
}

/** Re-read the SQL-computed control timestamps from the (locked) row so the
 *  in-memory entity - and thus the summary the caller returns - reflects the
 *  committed DB-clock values, not a JS approximation. */
async function syncHumanControlTimestamps(
  manager: EntityManager,
  session: ChatSession,
): Promise<void> {
  const [row] = (await manager.query(
    `SELECT human_control_started_at AS started_at, human_control_until AS until
       FROM chat_sessions WHERE id = $1`,
    [session.id],
  )) as Array<{ started_at: Date | string | null; until: Date | string | null }>;
  session.humanControlStartedAt = row?.started_at ? new Date(row.started_at) : undefined;
  session.humanControlUntil = row?.until ? new Date(row.until) : undefined;
}

/** True when the LOCKED row's timed deadline has passed ON THE DB CLOCK. The
 *  one expiry predicate (codex review fix 1): the JS clock never decides. */
async function timedDeadlinePassed(manager: EntityManager, sessionId: string): Promise<boolean> {
  const [row] = (await manager.query(
    `SELECT (human_control_until <= now()) AS expired
       FROM chat_sessions WHERE id = $1`,
    [sessionId],
  )) as Array<{ expired: boolean | null }>;
  return row?.expired === true;
}

/** The one wording for a materialized expiry, shared by the worker/inbound
 *  release and the post-deadline reply / policy-update paths. */
const EXPIRY_EVENT_TEXT =
  'Timed human control expired and the conversation was returned to the assistant';

const CLEAR_HUMAN_CONTROL: Record<string, unknown> = {
  humanControlMode: null,
  humanControlDurationHours: null,
  humanControlStartedAt: null,
  humanControlUntil: null,
};

/** Shared claim transition, used by claimConversation and the sendHumanMessage
 *  auto-claim (B2) — SAME transaction in the latter case. Caller has validated
 *  the state machine. */
async function applyClaim(
  manager: EntityManager,
  session: ChatSession,
  agentId: string,
  policy: HumanControlPolicy,
): Promise<string | null> {
  const now = new Date();
  const open = await lockHandoff(manager, session.id, ['requested']);
  if (open) {
    await manager.update(HandoffRequest, open.id, {
      status: 'accepted',
      assignedAgentId: agentId,
      acceptedAt: now,
      waitTimeSeconds: Math.max(0, Math.floor((now.getTime() - new Date(open.requestedAt).getTime()) / 1000)),
    });
  }
  await applyOwnershipTransition(manager, session, 'human_owned', {
    assignedAgentId: agentId,
    ...humanControlColumns(policy),
  });
  // The control timestamps were computed by the DB clock (function-valued
  // patch entries, skipped by the in-memory sync above) - re-read them so the
  // summary carries the committed values.
  await syncHumanControlTimestamps(manager, session);
  // NO currentChatCount increment (review fix S2): nothing ever decremented it,
  // so the legacy /accept parity write was a monotonically-growing counter —
  // and the only cross-row session→agent write in a command. Nothing reads the
  // counter as authoritative.
  await persistSystemEvent(manager, session, 'An agent has joined the conversation');
  return open?.id ?? null;
}

/** Shared HUMAN_OWNED -> BOT_OWNED transition, used by releaseConversation and
 *  releaseExpiredHumanControl. SAME rules either way: complete the accepted
 *  handoff, clear assignment + human-control, bump the version, one event.
 *  Caller has validated the state machine. */
async function applyRelease(
  manager: EntityManager,
  session: ChatSession,
  eventText: string,
): Promise<void> {
  const accepted = await lockHandoff(manager, session.id, ['accepted']);
  if (accepted) {
    const now = new Date();
    await manager.update(HandoffRequest, accepted.id, {
      status: 'completed',
      completedAt: now,
      handleTimeSeconds: accepted.acceptedAt
        ? Math.max(0, Math.floor((now.getTime() - new Date(accepted.acceptedAt).getTime()) / 1000))
        : 0,
    });
  }
  await applyOwnershipTransition(manager, session, 'bot_owned', {
    assignedAgentId: null,
    ...CLEAR_HUMAN_CONTROL,
  });
  await persistSystemEvent(manager, session, eventText);
}

// ── Commands ─────────────────────────────────────────────────────────────────

export const conversationCommands = {
  /**
   * BOT_OWNED -> HANDOFF_REQUESTED. Creates (or reuses) the single open
   * HandoffRequest. A handoff-disabled bot (Bot.settings.features.handoffEnabled
   * === false) creates NOTHING and reports 'handoff_disabled' so the caller can
   * keep its customer-facing fallback behaviour.
   */
  async requestHandoff(
    sessionId: string,
    reason: HandoffReason,
    source: HandoffSource,
    idempotencyKey?: string,
    opts: CommandOpts & { requestedBy?: string; note?: string; notify?: boolean } = {},
  ): Promise<RequestHandoffResult> {
    return withConversation(sessionId, 'request_handoff', idempotencyKey, opts, async (manager, session) => {
      if (session.ownership === 'closed') throw new ConversationClosedError();

      // Per-bot feature gate. Paused/deleted bot config mirrors handleBotHandoff:
      // proceed with the handoff anyway (a broken bot must not strand a customer).
      let handoffDisabled = false;
      try {
        const { settings } = await getBotConfigForSession(session);
        handoffDisabled = settings?.features?.handoffEnabled === false;
      } catch (err) {
        if (!(err instanceof BotPausedConfigError) && !(err instanceof BotNotFoundConfigError)) throw err;
      }
      if (handoffDisabled) {
        logger.info(`Handoff skipped for session ${session.id} (handoff disabled)`, { reason, source });
        return {
          outcome: 'handoff_disabled' as const,
          handoffId: null,
          conversation: summarize(session, null),
        };
      }

      if (session.ownership === 'human_owned') {
        // A human already has it — the customer's ask is satisfied; nothing to move.
        return {
          outcome: 'already_human_owned' as const,
          handoffId: null,
          conversation: summarize(session, null),
        };
      }

      const existing = await lockHandoff(manager, session.id, ['requested']);
      if (session.ownership === 'handoff_requested' || existing) {
        // Concurrent/duplicate request: converge on the one open handoff. Repair
        // the ownership column if a legacy writer left it behind.
        if (session.ownership !== 'handoff_requested') {
          await applyOwnershipTransition(manager, session, 'handoff_requested');
        }
        return {
          outcome: 'already_requested' as const,
          handoffId: existing?.id ?? null,
          conversation: summarize(session, existing?.id ?? null),
        };
      }

      // requested_by is a NOT NULL uuid: prefer the explicit participant (bot
      // path), else the session's user participant, else the session id itself.
      let requestedBy = opts.requestedBy;
      if (!requestedBy) {
        const userParticipant = await manager.findOne(Participant, {
          where: { sessionId: session.id, type: 'user', isDeleted: false },
        });
        requestedBy = userParticipant?.id ?? session.id;
      }

      const handoff = await manager.save(
        HandoffRequest,
        manager.create(HandoffRequest, {
          sessionId: session.id,
          tenantId: session.tenantId,
          requestedBy,
          requestedAt: new Date(),
          reason,
          priority: 'medium',
          ...(opts.note ? { notes: opts.note } : {}),
        } as Partial<HandoffRequest>),
      );

      await applyOwnershipTransition(manager, session, 'handoff_requested');
      await persistSystemEvent(
        manager,
        session,
        `Handoff requested: ${opts.note || reason.replace(/_/g, ' ')}`,
      );

      // Durable notification intent (ADR-0018), written IN this transaction so an
      // operator alert cannot be lost to a crash between the commit and the
      // immediate notify. Distribution still happens OUTSIDE this service (the
      // call-site notify + the outbox worker), preserving "commands mutate,
      // callers distribute". Gated: only paths that alert operators pass `notify`.
      if (opts.notify) {
        await manager.insert(NotificationOutbox, {
          tenantId: session.tenantId,
          kind: 'handoff',
          relatedId: handoff.id,
          payload: {
            tenantId: session.tenantId,
            handoffId: handoff.id,
            sessionId: session.id,
            reason,
            requestedAt: handoff.requestedAt.toISOString(),
          },
          status: 'pending',
          attemptCount: 0,
          nextAttemptAt: new Date(Date.now() + HANDOFF_OUTBOX_GRACE_MS),
        });
      }

      logger.info(`Handoff requested for session ${session.id}`, { reason, source, handoffId: handoff.id });
      return {
        outcome: 'requested' as const,
        handoffId: handoff.id,
        conversation: summarize(session, handoff.id),
      };
    });
  },

  /**
   * BOT_OWNED | HANDOFF_REQUESTED -> HUMAN_OWNED. Locks the session row and the
   * open handoff in one transaction; two concurrent claims yield exactly one
   * success and one stable `conversation_already_claimed` 409.
   */
  async claimConversation(
    sessionId: string,
    agentId: string,
    policy: HumanControlPolicy,
    idempotencyKey?: string,
    opts: CommandOpts & {
      /**
       * B-PR5a "change duration": a same-owner re-claim REWRITES the
       * human_control_* columns from `policy` instead of no-opping. Set only
       * when the caller carried an EXPLICIT mode (the REST route), so the
       * shipped portal's empty-body /takeover retry can never silently rewrite
       * a timed policy to indefinite. Ownership does not move, so (like the
       * reply slide) the ownership_version stays put.
       */
      updatePolicyIfOwned?: boolean;
    } = {},
  ): Promise<ClaimResult> {
    return withConversation(sessionId, 'claim', idempotencyKey, opts, async (manager, session) => {
      await requireTenantAgent(manager, session.tenantId, agentId, opts);

      if (session.ownership === 'closed') throw new ConversationClosedError();
      if (session.ownership === 'human_owned') {
        if (session.assignedAgentId === agentId) {
          if (opts.updatePolicyIfOwned) {
            // Codex review fix 2 (no resurrection): an EXPIRED timed control
            // cannot be silently renewed. If the locked row's deadline has
            // already passed ON THE DB CLOCK, the old control is over -
            // materialize the expiry and make the new policy a FRESH takeover
            // instead of an in-place rewrite.
            if (
              session.humanControlMode === 'timed' &&
              session.humanControlUntil &&
              (await timedDeadlinePassed(manager, session.id))
            ) {
              await applyRelease(manager, session, EXPIRY_EVENT_TEXT);
              const handoffId = await applyClaim(manager, session, agentId, policy);
              logger.info(
                `Conversation ${session.id} re-claimed fresh by agent ${agentId} after timed expiry`,
                { policy: policy.mode },
              );
              return { outcome: 'claimed' as const, conversation: summarize(session, handoffId) };
            }

            const columns = humanControlColumns(policy);
            await manager.update(
              ChatSession,
              session.id,
              columns as QueryDeepPartialEntity<ChatSession>,
            );
            // Plain values sync directly; the DB-computed timestamps re-read.
            session.humanControlMode = policy.mode;
            session.humanControlDurationHours = policy.mode === 'timed' ? policy.hours : undefined;
            await syncHumanControlTimestamps(manager, session);
            logger.info(`Conversation ${session.id} human-control policy updated by agent ${agentId}`, {
              policy: policy.mode,
            });
            return {
              outcome: 'already_owned' as const,
              policyUpdated: true,
              conversation: summarize(session, null),
            };
          }
          // Same operator re-claiming: idempotent by state — no re-apply.
          return { outcome: 'already_owned' as const, conversation: summarize(session, null) };
        }
        throw new ConversationAlreadyClaimedError(session.assignedAgentId);
      }

      const handoffId = await applyClaim(manager, session, agentId, policy);
      logger.info(`Conversation ${session.id} claimed by agent ${agentId}`, { policy: policy.mode });
      return { outcome: 'claimed' as const, conversation: summarize(session, handoffId) };
    });
  },

  /**
   * Operator reply (B2): insert the human message; dedupe on
   * (session_id, clientMessageId) under the session row lock; auto-claim an
   * unclaimed conversation IN THE SAME transaction (auto-claim policy =
   * indefinite; a timed policy is chosen explicitly via /takeover); 409
   * keep-draft when another operator owns it. A committed reply on a TIMED
   * session slides the deadline forward by the full duration (B-PR5a item 4) -
   * but ONLY while the deadline is still in the future on the DB clock; a
   * post-deadline reply materializes the expiry and re-establishes control as
   * a FRESH auto-claim (codex review fix 2: no resurrection).
   */
  async sendHumanMessage(
    sessionId: string,
    agentId: string,
    clientMessageId: string,
    content: string,
    opts: CommandOpts = {},
  ): Promise<SendHumanMessageResult> {
    if (!clientMessageId || clientMessageId.length > 128) {
      throw new BadRequestError('clientMessageId is required (max 128 chars)');
    }
    return withConversation(sessionId, 'send_message', undefined, opts, async (manager, session) => {
      const agent = await requireTenantAgent(manager, session.tenantId, agentId, opts);
      if (session.ownership === 'closed') throw new ConversationClosedError();

      // Dedupe FIRST: a retry of an already-delivered reply must return the
      // original message untouched, whatever the ownership is by now.
      const dup = (await manager.query(
        `SELECT id, created_at FROM messages
          WHERE session_id = $1 AND metadata->>'clientMessageId' = $2
          LIMIT 1`,
        [session.id, clientMessageId],
      )) as Array<{ id: string; created_at: string | Date }>;
      if (dup.length) {
        return {
          outcome: 'duplicate' as const,
          autoClaimed: false,
          message: { id: dup[0].id, createdAt: new Date(dup[0].created_at).toISOString() },
          conversation: summarize(session, null),
        };
      }

      let autoClaimed = false;
      if (session.ownership === 'human_owned') {
        if (session.assignedAgentId !== agentId) {
          throw new ConversationAlreadyClaimedError(session.assignedAgentId);
        }
        // Committed human reply slides a TIMED deadline; indefinite stays put.
        // Codex review fixes 1+2: the slide condition AND the new deadline are
        // evaluated in SQL on the locked row, so the DB clock governs, and the
        // slide only applies while the deadline is still in the future - a
        // reply that lands after the deadline must not resurrect the expired
        // control (the hard-deadline invariant).
        if (session.humanControlMode === 'timed' && session.humanControlDurationHours) {
          const slid = returningRows<{ human_control_until: Date | string }>(
            await manager.query(
              `UPDATE chat_sessions
                  SET human_control_until = now() + make_interval(hours => $2::int)
                WHERE id = $1
                  AND human_control_mode = 'timed'
                  AND human_control_until > now()
                RETURNING human_control_until`,
              [session.id, session.humanControlDurationHours],
            ),
          );
          if (slid.length) {
            session.humanControlUntil = new Date(slid[0].human_control_until);
          } else {
            // The deadline passed before this reply committed: the old control
            // is OVER. Materialize the expiry, then re-establish control FRESH
            // through the same auto-claim path a reply on a bot-owned session
            // takes (indefinite). A post-deadline reply re-establishes control
            // anew - it never silently renews the expired one.
            await applyRelease(manager, session, EXPIRY_EVENT_TEXT);
            await applyClaim(manager, session, agentId, { mode: 'indefinite' });
            autoClaimed = true;
          }
        }
      } else {
        // bot_owned or handoff_requested → typing a reply takes over (B2).
        await applyClaim(manager, session, agentId, { mode: 'indefinite' });
        autoClaimed = true;
      }

      // The operator's Participant row (real FK — the socket path's raw agent id
      // violates the participants FK and only works where the row pre-exists).
      let participant = await manager.findOne(Participant, {
        where: { sessionId: session.id, type: 'agent', userId: agent.userId, isDeleted: false },
      });
      if (!participant) {
        const user = await manager.findOne(User, { where: { id: agent.userId } });
        participant = await manager.save(
          Participant,
          manager.create(Participant, {
            sessionId: session.id,
            type: 'agent',
            userId: agent.userId,
            name: user?.name || 'Agent',
            isAnonymous: false,
            joinedAt: new Date(),
          }),
        );
      }

      const saved = await manager.save(
        Message,
        manager.create(Message, {
          sessionId: session.id,
          tenantId: session.tenantId,
          participantId: participant.id,
          type: 'text' as Message['type'],
          content: encrypt(content),
          contentEncrypted: true,
          status: 'sent' as Message['status'],
          sentAt: new Date(),
          metadata: { clientMessageId } as unknown as Message['metadata'],
        }),
      );
      await manager.query(
        `UPDATE chat_sessions
            SET message_count = message_count + 1, last_activity_at = now()
          WHERE id = $1`,
        [session.id],
      );

      return {
        outcome: 'sent' as const,
        autoClaimed,
        message: { id: saved.id, createdAt: saved.createdAt.toISOString() },
        conversation: summarize(session, null),
      };
    });
  },

  /** HUMAN_OWNED -> BOT_OWNED: clear assignment + human-control, complete the
   *  accepted handoff, one event. Only the assigned operator may release. */
  async releaseConversation(
    sessionId: string,
    agentId: string,
    idempotencyKey?: string,
    opts: CommandOpts & { reason?: string } = {},
  ): Promise<ReleaseResult> {
    return withConversation(sessionId, 'release', idempotencyKey, opts, async (manager, session) => {
      await requireTenantAgent(manager, session.tenantId, agentId, opts);

      if (session.ownership === 'closed') throw new ConversationClosedError();
      if (session.ownership === 'bot_owned') {
        // Idempotent by state (a lost response, a double-click).
        return { outcome: 'already_bot_owned' as const, conversation: summarize(session, null) };
      }
      if (session.ownership !== 'human_owned') {
        throw new InvalidOwnershipTransitionError(session.ownership, 'release');
      }
      if (session.assignedAgentId !== agentId) throw new NotConversationOwnerError();

      await applyRelease(
        manager,
        session,
        `Agent has left the conversation.${opts.reason ? ` ${opts.reason}` : ''}`,
      );

      logger.info(`Conversation ${session.id} released to bot by agent ${agentId}`);
      return { outcome: 'released' as const, conversation: summarize(session, null) };
    });
  },

  /**
   * Timed-control expiry (B-PR5a): HUMAN_OWNED + mode 'timed' + deadline passed
   * -> BOT_OWNED, by a SYSTEM actor (the server.ts sweep, or the inbound-message
   * check in message-forwarding). The expiry predicate is re-checked HERE, on
   * the row locked FOR UPDATE, and that is the fence: a caller acting on a stale
   * read (the sweep's SELECT, an ingress-loaded entity) can never release a
   * conversation whose deadline an operator re-claim or a committed human reply
   * (the slide) has since pushed into the future. The no-op outcomes make it
   * re-entrant: releasing an already-released / re-claimed / closed session
   * changes nothing.
   */
  async releaseExpiredHumanControl(
    sessionId: string,
    opts: CommandOpts & { source?: string } = {},
  ): Promise<ExpireHumanControlResult> {
    return withConversation(sessionId, 'release', undefined, opts, async (manager, session) => {
      if (
        session.ownership !== 'human_owned' ||
        session.humanControlMode !== 'timed' ||
        !session.humanControlUntil
      ) {
        return { outcome: 'not_applicable' as const, conversation: summarize(session, null) };
      }
      // Codex review fix 1: the expiry comparison runs in SQL on the locked
      // row, never on the JS clock. A node running behind the DB would
      // otherwise answer 'not_expired' for rows the worker keeps re-selecting
      // (starving later batches); a node running ahead would release early.
      if (!(await timedDeadlinePassed(manager, session.id))) {
        return { outcome: 'not_expired' as const, conversation: summarize(session, null) };
      }

      await applyRelease(manager, session, EXPIRY_EVENT_TEXT);

      logger.info(`Timed human control expired for session ${session.id} - released to bot`, {
        source: opts.source ?? 'unknown',
      });
      return { outcome: 'released' as const, conversation: summarize(session, null) };
    });
  },

  /**
   * HANDOFF_REQUESTED -> BOT_OWNED: customer cancel, operator decline, or the
   * stale-request sweep. An ATOMIC ownership transition (the legacy decline only
   * broadcast, so the state never moved back).
   */
  async cancelHandoff(
    sessionId: string,
    actor: ConversationActor,
    idempotencyKey?: string,
    opts: CommandOpts & { reason?: string } = {},
  ): Promise<CancelResult> {
    return withConversation(sessionId, 'cancel_handoff', idempotencyKey, opts, async (manager, session) => {
      if (actor.kind === 'agent') await requireTenantAgent(manager, session.tenantId, actor.agentId, opts);

      if (session.ownership === 'closed') throw new ConversationClosedError();
      if (session.ownership === 'bot_owned') {
        // Already back with the bot — re-entrant for the sweep and for retries.
        // Still close out a dangling open row (legacy writers could strand one).
        const dangling = await lockHandoff(manager, session.id, ['requested']);
        if (dangling) {
          await manager.update(HandoffRequest, dangling.id, {
            status: 'rejected',
            rejectionReason: opts.reason || 'cancelled',
          });
        }
        return { outcome: 'already_bot_owned' as const, conversation: summarize(session, null) };
      }
      if (session.ownership !== 'handoff_requested') {
        throw new InvalidOwnershipTransitionError(session.ownership, 'cancel');
      }

      const open = await lockHandoff(manager, session.id, ['requested']);
      if (open) {
        if (actor.kind === 'system') {
          await manager.update(HandoffRequest, open.id, { status: 'timeout', timeoutAt: new Date() });
        } else {
          await manager.update(HandoffRequest, open.id, {
            status: 'rejected',
            rejectionReason:
              opts.reason || (actor.kind === 'agent' ? 'Declined by agent' : 'Cancelled by customer'),
          });
        }
      }
      await applyOwnershipTransition(manager, session, 'bot_owned', {
        assignedAgentId: null,
        ...CLEAR_HUMAN_CONTROL,
      });
      const eventText =
        actor.kind === 'agent'
          ? 'Handoff declined by agent'
          : actor.kind === 'customer'
            ? 'Handoff cancelled by customer'
            : 'Handoff request expired and was returned to the assistant';
      await persistSystemEvent(manager, session, eventText);

      logger.info(`Handoff cancelled for session ${session.id}`, { actor: actor.kind, handoffId: open?.id });
      return { outcome: 'cancelled' as const, conversation: summarize(session, null) };
    });
  },

  /** any -> CLOSED. Requested handoffs are rejected (conversation_closed);
   *  accepted ones completed. Assignment is kept for the record (legacy parity);
   *  live human-control is cleared. */
  async closeConversation(
    sessionId: string,
    actor: ConversationActor,
    idempotencyKey?: string,
    opts: CommandOpts & { reason?: string } = {},
  ): Promise<CloseResult> {
    return withConversation(sessionId, 'close', idempotencyKey, opts, async (manager, session) => {
      if (actor.kind === 'agent') await requireTenantAgent(manager, session.tenantId, actor.agentId, opts);

      if (session.ownership === 'closed') {
        return { outcome: 'already_closed' as const, conversation: summarize(session, null) };
      }

      const open = await lockHandoff(manager, session.id, ['requested', 'accepted']);
      if (open) {
        if (open.status === 'requested') {
          await manager.update(HandoffRequest, open.id, {
            status: 'rejected',
            rejectionReason: 'conversation_closed',
          });
        } else {
          await manager.update(HandoffRequest, open.id, { status: 'completed', completedAt: new Date() });
        }
      }

      const endedAt = new Date();
      const durationSeconds = session.startedAt
        ? Math.max(0, Math.floor((endedAt.getTime() - new Date(session.startedAt).getTime()) / 1000))
        : null;
      await applyOwnershipTransition(manager, session, 'closed', {
        endedAt,
        ...(durationSeconds !== null ? { durationSeconds } : {}),
        ...CLEAR_HUMAN_CONTROL,
      });
      await persistSystemEvent(
        manager,
        session,
        `Session closed: ${opts.reason || (actor.kind === 'agent' ? 'Closed by agent' : 'User closed the chat')}`,
      );

      logger.info(`Conversation ${session.id} closed`, { actor: actor.kind });
      return { outcome: 'closed' as const, conversation: summarize(session, null) };
    });
  },

  /**
   * Reassign to another operator (legacy /chat/:id/transfer). Not part of the
   * B1 REST surface; kept as a service command so the legacy route no longer
   * writes ownership state directly. Accepts from any non-closed state; an open
   * requested handoff is accepted by the target.
   */
  async transferConversation(
    sessionId: string,
    targetAgentId: string,
    idempotencyKey?: string,
    opts: CommandOpts = {},
  ): Promise<TransferResult> {
    return withConversation(sessionId, 'transfer', idempotencyKey, opts, async (manager, session) => {
      await requireTenantAgent(manager, session.tenantId, targetAgentId);
      if (session.ownership === 'closed') throw new ConversationClosedError();

      const now = new Date();
      const open = await lockHandoff(manager, session.id, ['requested']);
      if (open) {
        await manager.update(HandoffRequest, open.id, {
          status: 'accepted',
          assignedAgentId: targetAgentId,
          acceptedAt: now,
          waitTimeSeconds: Math.max(0, Math.floor((now.getTime() - new Date(open.requestedAt).getTime()) / 1000)),
        });
      }
      // Preserve an existing human-control policy across a transfer; start an
      // indefinite one when the conversation wasn't human-owned yet. (An
      // expired timed policy that survives a transfer is not resurrected: its
      // deadline is untouched, so the sweep or the next inbound message
      // releases it on the same DB-clock predicate.)
      const control =
        session.ownership === 'human_owned' && session.humanControlMode
          ? {}
          : humanControlColumns({ mode: 'indefinite' });
      await applyOwnershipTransition(manager, session, 'human_owned', {
        assignedAgentId: targetAgentId,
        ...control,
      });
      await syncHumanControlTimestamps(manager, session);
      await persistSystemEvent(manager, session, 'Conversation transferred to another agent');

      logger.info(`Conversation ${session.id} transferred to agent ${targetAgentId}`);
      return { outcome: 'transferred' as const, conversation: summarize(session, open?.id ?? null) };
    });
  },
};

export type ConversationCommands = typeof conversationCommands;
