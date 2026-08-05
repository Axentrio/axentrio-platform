/**
 * The per-bot upload switch, enforced server-side.
 *
 * `features.fileUploadEnabled` was read in exactly ONE place: the init response that tells
 * the browser whether to draw the attach button. The upload endpoints checked only the plan
 * entitlement — so an owner who turned uploads off hid a button and nothing else, and any
 * holder of a valid widget token on a paid tenant could still presign and upload. A status
 * doc described the feature as "shipped OFF" on the strength of that button.
 *
 * These tests exist because the difference between "hidden" and "denied" is the entire
 * security posture, and nothing asserted it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessionFindOne = vi.fn();
const botFindOne = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: any) => {
      const name = entity?.name ?? entity;
      if (name === 'ChatSession') return { findOne: sessionFindOne };
      if (name === 'Bot') return { findOne: botFindOne };
      return {};
    },
  },
}));

import { assertUploadEnabledForSession } from '../../file-handling/widget-upload-gate';

const reason = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return 'allowed';
  } catch (e: any) {
    return `${e.statusCode ?? '?'}:${e.code ?? e.constructor?.name}`;
  }
};

describe('widget upload gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionFindOne.mockResolvedValue({ id: 'cs-1', tenantId: 'ten-1', botId: 'bot-1' });
  });

  it('allows an upload when the owner has switched it on', async () => {
    botFindOne.mockResolvedValue({ id: 'bot-1', settings: { features: { fileUploadEnabled: true } } });
    expect(await reason(() => assertUploadEnabledForSession('ten-1', 'cs-1'))).toBe('allowed');
  });

  it('DENIES when the flag is off — not merely hides the button', async () => {
    botFindOne.mockResolvedValue({ id: 'bot-1', settings: { features: { fileUploadEnabled: false } } });
    expect(await reason(() => assertUploadEnabledForSession('ten-1', 'cs-1'))).toBe('403:FILE_UPLOAD_DISABLED');
  });

  it('defaults to DENY when the bot has no features block at all', async () => {
    // Absent is not consent. An upload endpoint is the wrong place to be generous.
    botFindOne.mockResolvedValue({ id: 'bot-1', settings: {} });
    expect(await reason(() => assertUploadEnabledForSession('ten-1', 'cs-1'))).toBe('403:FILE_UPLOAD_DISABLED');
  });

  it('defaults to DENY for a legacy session with no bot bound', async () => {
    sessionFindOne.mockResolvedValue({ id: 'cs-1', tenantId: 'ten-1', botId: null });
    expect(await reason(() => assertUploadEnabledForSession('ten-1', 'cs-1'))).toBe('403:FILE_UPLOAD_DISABLED');
    expect(botFindOne).not.toHaveBeenCalled();
  });

  it('scopes the session lookup to the caller’s tenant', async () => {
    await reason(() => assertUploadEnabledForSession('ten-1', 'cs-1'));
    expect(sessionFindOne).toHaveBeenCalledWith({ where: { id: 'cs-1', tenantId: 'ten-1' } });
  });

  it('scopes the bot lookup to the tenant too', async () => {
    botFindOne.mockResolvedValue({ id: 'bot-1', settings: { features: { fileUploadEnabled: true } } });
    await assertUploadEnabledForSession('ten-1', 'cs-1');
    expect(botFindOne).toHaveBeenCalledWith({ where: { id: 'bot-1', tenantId: 'ten-1' } });
  });

  it('gives a foreign session the same 404 as a missing one', async () => {
    // Not 403: distinguishing them would turn this endpoint into a cross-tenant existence
    // oracle for chat-session ids.
    sessionFindOne.mockResolvedValue(null);
    expect(await reason(() => assertUploadEnabledForSession('ten-1', 'cs-other'))).toBe('404:NOT_FOUND');
  });

  it('requires a real boolean true, not merely something truthy', async () => {
    // The string 'false' is truthy in JS. A hand-edited or legacy settings blob must not be
    // able to switch uploads on by accident, so the check is `=== true`.
    botFindOne.mockResolvedValue({ id: 'bot-1', settings: { features: { fileUploadEnabled: 'false' as never } } });
    expect(await reason(() => assertUploadEnabledForSession('ten-1', 'cs-1'))).toBe('403:FILE_UPLOAD_DISABLED');
  });
});

describe('widget upload gate — wiring', () => {
  it('is applied to BOTH the presign and the completion route', async () => {
    // Completing an upload begun before the owner switched uploads off must not slip a file
    // through the back half of the flow. Read from the route source: importing the router
    // pulls in the whole express app, and what matters here is only that both call it.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(process.cwd(), 'src/routes/widget.ts'), 'utf8');
    const presign = src.slice(
      src.indexOf("'/files/upload'"),
      src.indexOf("'/files/:sessionId/upload-complete'"),
    );
    const complete = src.slice(src.indexOf("'/files/:sessionId/upload-complete'"));
    expect(presign).toContain('assertUploadEnabledForSession(');
    expect(complete).toContain('assertUploadEnabledForSession(');
  });
});
