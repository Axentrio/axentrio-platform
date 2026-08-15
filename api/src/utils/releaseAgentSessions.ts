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

  // 2. Null out agent + re-queue. ONE atomic UPDATE that also moves ownership
  // and bumps ownership_version (B-PR2b fix B3): the handoff row goes back to
  // 'requested' below, so the session is pending-agent again —
  // ownership='handoff_requested' with the derived status 'handoff'. Without
  // the ownership/version move, an unassigned session kept
  // ownership='human_owned' (split-brain) and an in-flight AI run was not
  // fenced. Human-control ends with the assignment, so those columns clear too.
  let releasedSessions = 0;
  if (affectedSessionIds.length > 0) {
    const result = await manager
      .createQueryBuilder()
      .update(ChatSession)
      .set({
        assignedAgentId: null as unknown as string | undefined,
        status: 'handoff' as const,
        ownership: 'handoff_requested' as const,
        ownershipVersion: () => 'ownership_version + 1',
        humanControlMode: null as unknown as undefined,
        humanControlDurationHours: null as unknown as undefined,
        humanControlUntil: null as unknown as undefined,
        humanControlStartedAt: null as unknown as undefined,
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
