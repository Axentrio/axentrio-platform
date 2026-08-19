/** Queue card the Inbox Handoff tab inserts on `handoff:requested`. */
export function pendingHandoffSocketPayload(input: {
  sessionId: string;
  visitorId?: string | null;
  reason?: string;
  priority?: string;
  handoffId?: string | null;
  requestedAt?: Date;
}): Record<string, unknown> {
  const visitorId = input.visitorId ?? '';
  return {
    id: input.sessionId,
    chatId: input.sessionId,
    sessionId: input.sessionId,
    status: 'pending',
    reason: input.reason ?? 'user_request',
    priority: input.priority ?? 'medium',
    waitTime: 0,
    requestedAt: (input.requestedAt ?? new Date()).toISOString(),
    userName: visitorId ? `Visitor ${visitorId.slice(0, 8)}` : undefined,
    handoffId: input.handoffId ?? undefined,
  };
}
