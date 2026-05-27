// api/src/utils/releaseAgentSessions.ts
import { EntityManager } from 'typeorm';
import { ChatSession } from '../database/entities/ChatSession';
import { HandoffRequest } from '../database/entities/HandoffRequest';
import { Agent } from '../database/entities/Agent';

interface ReleaseResult {
  releasedSessions: number;
  returnedHandoffs: number;
  affectedSessionIds: string[];
}

/**
 * Release all sessions and handoff requests assigned to an agent.
 * Must be called inside an active transaction (pass the EntityManager).
 * Socket events should be emitted by the caller AFTER the transaction commits.
 */
export async function releaseAgentSessions(
  userId: string,
  tenantId: string,
  manager: EntityManager,
): Promise<ReleaseResult> {
  // Resolve Agent from userId — user may be admin-only with no agent record
  const agent = await manager.findOne(Agent, { where: { userId, tenantId } });
  if (!agent) {
    return { releasedSessions: 0, returnedHandoffs: 0, affectedSessionIds: [] };
  }

  // 1. Find affected sessions
  const sessions = await manager
    .createQueryBuilder(ChatSession, 'cs')
    .select(['cs.id'])
    .where('cs.assigned_agent_id = :agentId', { agentId: agent.id })
    .andWhere('cs.status IN (:...statuses)', { statuses: ['active', 'handoff'] })
    .getMany();

  const affectedSessionIds = sessions.map(s => s.id);

  // 2. Null out agent + set status to waiting
  let releasedSessions = 0;
  if (affectedSessionIds.length > 0) {
    const result = await manager
      .createQueryBuilder()
      .update(ChatSession)
      .set({
        assignedAgentId: null as unknown as string | undefined,
        status: 'waiting' as const,
      })
      .where('assigned_agent_id = :agentId', { agentId: agent.id })
      .andWhere('status IN (:...statuses)', { statuses: ['active', 'handoff'] })
      .execute();
    releasedSessions = result.affected ?? 0;
  }

  // 3. Return accepted handoff requests to queue
  const handoffResult = await manager
    .createQueryBuilder()
    .update(HandoffRequest)
    .set({
      assignedAgentId: null as unknown as string | undefined,
      status: 'requested' as const,
    })
    .where('assigned_agent_id = :agentId', { agentId: agent.id })
    .andWhere('status = :status', { status: 'accepted' })
    .execute();

  return {
    releasedSessions,
    returnedHandoffs: handoffResult.affected ?? 0,
    affectedSessionIds,
  };
}
