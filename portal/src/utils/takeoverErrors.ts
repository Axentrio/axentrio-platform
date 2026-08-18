import axios from 'axios';

export type TakeoverFailureCode =
  | 'operator_not_in_tenant'
  | 'conversation_already_claimed'
  | 'invalid_ownership_transition'
  | 'invalid_takeover_hours'
  | 'not_conversation_owner'
  | 'conversation_closed';

export interface TakeoverFailure {
  code: TakeoverFailureCode | string;
  assignedAgentId?: string;
}

export function takeoverFailureOf(error: unknown): TakeoverFailure | null {
  if (!axios.isAxiosError(error) || !error.response) return null;
  const data = error.response.data as
    | { error?: { code?: string; details?: { assignedAgentId?: string } } }
    | undefined;
  const code = data?.error?.code;
  if (!code) return null;
  const assignedAgentId = data?.error?.details?.assignedAgentId;
  return assignedAgentId ? { code, assignedAgentId } : { code };
}

export function takeoverToastKey(failure: TakeoverFailure): string {
  switch (failure.code) {
    case 'operator_not_in_tenant':
      return 'inbox.toasts.takeoverNotInTenant';
    case 'conversation_already_claimed':
      return failure.assignedAgentId
        ? 'inbox.toasts.takeoverAlreadyClaimedBy'
        : 'inbox.toasts.takeoverAlreadyClaimed';
    case 'invalid_ownership_transition':
      return 'inbox.toasts.takeoverInvalidTransition';
    case 'invalid_takeover_hours':
      return 'inbox.toasts.takeoverInvalidHours';
    case 'conversation_closed':
      return 'inbox.toasts.takeoverClosed';
    default:
      return 'inbox.toasts.takeoverFailed';
  }
}
