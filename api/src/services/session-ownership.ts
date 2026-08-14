export type SessionOwnership = 'bot_owned' | 'handoff_requested' | 'human_owned' | 'closed';

export function ownershipFromStatus(
  status: 'active' | 'closed' | 'waiting' | 'handoff' | 'bot',
  hasAssignedAgent: boolean,
): SessionOwnership {
  if (status === 'closed') return 'closed';
  // A human is assigned and the conversation is live (handoff accepted, or an `active`
  // human-served session): they own it. Erring towards human_owned is deliberate — a false
  // human_owned only keeps the AI out of a session a human touched, whereas a false bot_owned
  // would let the AI barge into a human conversation.
  if (hasAssignedAgent && (status === 'handoff' || status === 'active')) return 'human_owned';
  if (status === 'handoff') return 'handoff_requested';
  return 'bot_owned';
}

export function deriveStatusFromOwnership(
  ownership: SessionOwnership,
  prevStatus: 'active' | 'closed' | 'waiting' | 'handoff' | 'bot',
): 'active' | 'closed' | 'waiting' | 'handoff' | 'bot' {
  if (ownership === 'human_owned' || ownership === 'handoff_requested') return 'handoff';
  if (ownership === 'closed') return 'closed';
  if (prevStatus === 'active' || prevStatus === 'waiting' || prevStatus === 'bot') return prevStatus;
  return 'bot';
}
