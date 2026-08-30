/**
 * The ONE definition of "which sessions belong to this customer's thread".
 *
 * Extracted from chat.routes.ts so GET /chats/:id/thread (what the Inbox
 * renders as "Earlier conversation" blocks) and the Superadmin Reset wipe
 * (what those blocks lose) resolve the identity through the SAME code. When
 * these drifted, Reset deleted closed chats the pane never showed: a second
 * channel connection for the same number, or the same user's group thread as
 * well as their DM.
 *
 * Callers may pass an EntityManager to run inside their transaction.
 */
import { Brackets, type EntityManager } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { ConversationBinding } from '../database/entities/ConversationBinding';
import type { CustomerThreadBinding } from '../realtime/conversation-serializer';

/**
 * The customer identity a thread groups on. Mirrors computeCustomerThreadId
 * (B-PR4a): widget identity lives on the session row; external identity is the
 * conversation_bindings triple. `session` = unresolvable (an external session
 * with no binding row and no identity facts on the row) - the thread is then
 * just the one session, per spec.
 */
export type ThreadIdentity =
  | { kind: 'widget'; botId: string; visitorId: string }
  | { kind: 'external'; binding: CustomerThreadBinding }
  | { kind: 'session' };

/**
 * Resolve the selected session's customer identity.
 *
 * External note: the inbound pipeline REASSIGNS the binding row to the new
 * session when a closed conversation reopens (findOrCreateConversation), so
 * only the newest session of an external customer still holds a binding. When
 * the selected session lost its binding that way, fall back to the identity
 * facts the pipeline stamps on every session row it creates:
 * channelConnectionId + visitorId(=externalUserId) +
 * metadata.customData.externalThreadId.
 */
export async function resolveThreadIdentity(
  session: ChatSession,
  manager?: EntityManager,
): Promise<ThreadIdentity> {
  if (session.source === 'widget') {
    if (!session.visitorId) return { kind: 'session' };
    return { kind: 'widget', botId: session.botId, visitorId: session.visitorId };
  }
  const bindingRepo = manager
    ? manager.getRepository(ConversationBinding)
    : AppDataSource.getRepository(ConversationBinding);
  const binding = await bindingRepo.findOne({
    where: { sessionId: session.id },
    order: { createdAt: 'DESC' },
  });
  const metaThreadId = session.metadata?.customData?.externalThreadId;
  const candidate: CustomerThreadBinding | null = binding
    ? {
        channelConnectionId: binding.channelConnectionId,
        externalUserId: binding.externalUserId,
        externalThreadId: binding.externalThreadId,
      }
    : session.channelConnectionId && session.visitorId && typeof metaThreadId === 'string'
      ? {
          channelConnectionId: session.channelConnectionId,
          externalUserId: session.visitorId,
          externalThreadId: metaThreadId,
        }
      : null;
  // An INCOMPLETE identity must degrade to the one-session fallback, never to
  // a `= ''`/`= NULL` match that silently drops related sessions and
  // mis-classifies them as possibleDuplicates.
  if (
    !candidate ||
    !candidate.channelConnectionId ||
    !candidate.externalUserId ||
    !candidate.externalThreadId
  ) {
    return { kind: 'session' };
  }
  return { kind: 'external', binding: candidate };
}

/** The `(started_at, id)` SQL of the conversation_bindings identity-triple
 *  subquery, shared by the thread query and the duplicates exclusion. Params:
 *  :bcc / :beu / :bet. */
export function bindingTripleSubQuery(manager?: EntityManager): string {
  const repo = manager
    ? manager.getRepository(ConversationBinding)
    : AppDataSource.getRepository(ConversationBinding);
  return repo
    .createQueryBuilder('b')
    .select('b.sessionId')
    .where('b.channelConnectionId = :bcc')
    .andWhere('b.externalUserId = :beu')
    .andWhere('b.externalThreadId = :bet')
    .getQuery();
}

/**
 * The sessions sharing the identity that are STRICTLY OLDER than the selected
 * one - TENANT-SCOPED on every branch. The strict `(started_at, id)` cut means
 * a NEWER (possibly still ACTIVE) session of the same identity can never
 * render as read-only "earlier history" above an old selected session; the
 * timeline always ends at the selected session's live thread.
 *
 * widget:   same (tenant_id, bot_id, visitor_id) AND source='widget' - the
 *           exact predicate of the B-PR4a partial unique index.
 * external: the binding triple (matches the CURRENTLY-bound session) OR the
 *           identity facts stamped on the row (matches PRIOR sessions whose
 *           binding was reassigned on reopen). The strict externalThreadId
 *           equality keeps e.g. a Telegram group chat out of the same user's
 *           DM thread. Legacy rows missing the metadata fall out of the strict
 *           thread and surface via possibleDuplicates instead.
 */
export function threadSessionsQuery(
  tenantId: string,
  identity: Exclude<ThreadIdentity, { kind: 'session' }>,
  selected: ChatSession,
  manager?: EntityManager,
) {
  const repo = manager
    ? manager.getRepository(ChatSession)
    : AppDataSource.getRepository(ChatSession);
  const qb = repo
    .createQueryBuilder('s')
    .leftJoinAndSelect('s.assignedAgent', 'agent')
    .where('s.tenantId = :tenantId', { tenantId })
    // Strictly older than the selected session (row-value comparison, id
    // tie-break) - never the selected row itself, never a newer sibling.
    .andWhere('(s.startedAt, s.id) < (:selStartedAt, :selId)', {
      selStartedAt: selected.startedAt ?? selected.createdAt,
      selId: selected.id,
    });

  if (identity.kind === 'widget') {
    return qb
      .andWhere("s.source = 'widget'")
      .andWhere('s.botId = :botId', { botId: identity.botId })
      .andWhere('s.visitorId = :visitorId', { visitorId: identity.visitorId });
  }

  return qb
    .andWhere("s.source <> 'widget'")
    .andWhere(
      new Brackets((w) => {
        w.where(`s.id IN (${bindingTripleSubQuery(manager)})`).orWhere(
          `(s.channelConnectionId = :bcc AND s.visitorId = :beu AND s.metadata -> 'customData' ->> 'externalThreadId' = :bet)`,
        );
      }),
    )
    .setParameters({
      bcc: identity.binding.channelConnectionId,
      beu: identity.binding.externalUserId,
      bet: identity.binding.externalThreadId,
    });
}

/**
 * The ids Superadmin Reset may wipe: the selected session plus the CLOSED
 * sessions the pane shows above it as earlier history.
 *
 * Same predicate as the thread route, so what Reset deletes is exactly what
 * the operator saw. Two extra bounds beyond the route's:
 *  - `status = 'closed'` on siblings: never touch a chat the bot or an
 *    operator is working right now.
 *  - the selected row is always included; Reset closes it first.
 * An unresolvable identity degrades to the selected session alone.
 */
export async function resetWipeSessionIds(
  manager: EntityManager,
  session: ChatSession,
): Promise<string[]> {
  const ids = new Set<string>([session.id]);
  const identity = await resolveThreadIdentity(session, manager);
  if (identity.kind === 'session') return [...ids];

  const rows = await threadSessionsQuery(session.tenantId, identity, session, manager)
    .andWhere("s.status = 'closed'")
    .select(['s.id'])
    .getRawMany<{ s_id: string }>();

  for (const row of rows) {
    const id = row.s_id;
    if (id) ids.add(id);
  }
  return [...ids];
}
