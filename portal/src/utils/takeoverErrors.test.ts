import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { takeoverFailureOf, takeoverToastKey } from './takeoverErrors';

function axiosError(code: string, details?: Record<string, unknown>): AxiosError {
  const err = new AxiosError(code, 'ERR_BAD_REQUEST');
  err.response = {
    status: 409,
    statusText: 'Conflict',
    headers: {},
    config: { headers: new AxiosHeaders() } as never,
    data: { success: false, error: { code, message: code, details } },
  };
  return err;
}

describe('takeoverToastKey', () => {
  it('maps conversation_closed to its own toast', () => {
    const failure = takeoverFailureOf(axiosError('conversation_closed'));
    expect(failure?.code).toBe('conversation_closed');
    expect(takeoverToastKey(failure!)).toBe('inbox.toasts.takeoverClosed');
  });

  it('maps already-claimed with an assignee name', () => {
    const failure = takeoverFailureOf(
      axiosError('conversation_already_claimed', { assignedAgentId: 'op-2' }),
    );
    expect(takeoverToastKey(failure!)).toBe('inbox.toasts.takeoverAlreadyClaimedBy');
  });
});
