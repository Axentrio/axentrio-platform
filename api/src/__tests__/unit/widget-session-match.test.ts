import { describe, it, expect } from 'vitest';
import { requireWidgetSessionMatch } from '../../routes/chat.routes';
import { ForbiddenError } from '../../middleware/error-handler';

function run(widgetSessionId: string | undefined, paramSessionId: string) {
  const req = {
    widget: widgetSessionId === undefined ? undefined : { sessionId: widgetSessionId },
    params: { sessionId: paramSessionId },
  };
  let nextArg: unknown = 'NOT_CALLED';
  requireWidgetSessionMatch(req as never, {} as never, ((e?: unknown) => { nextArg = e; }) as never);
  return nextArg;
}

describe('requireWidgetSessionMatch — widget chat IDOR guard (#G)', () => {
  it('allows when the token session matches the URL session', () => {
    expect(run('sess-A', 'sess-A')).toBeUndefined();
  });
  it('403s when the URL session differs from the token (cross-visitor IDOR)', () => {
    expect(run('sess-A', 'sess-B')).toBeInstanceOf(ForbiddenError);
  });
  it('403s (fail closed) when the token carries no sessionId', () => {
    expect(run(undefined, 'sess-A')).toBeInstanceOf(ForbiddenError);
  });
});
