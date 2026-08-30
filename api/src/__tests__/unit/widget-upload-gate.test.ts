/**
 * Widget upload gate: session exists on this tenant, then the plan
 * includes file upload. The dead bot flag `fileUploadEnabled` is not read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessionFindOne = vi.fn();
const requireFeature = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: any) => {
      const name = entity?.name ?? entity;
      if (name === 'ChatSession') return { findOne: sessionFindOne };
      return {};
    },
  },
}));

vi.mock('../../billing/enforce', () => ({
  requireFeature: (...args: unknown[]) => requireFeature(...args),
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
    requireFeature.mockResolvedValue(undefined);
  });

  it('allows an upload when the plan includes file upload', async () => {
    expect(await reason(() => assertUploadEnabledForSession('ten-1', 'cs-1'))).toBe('allowed');
    expect(requireFeature).toHaveBeenCalledWith('ten-1', 'fileUpload', 'plan_limit_file_upload');
  });

  it('DENIES with the plan error when the tenant is not entitled', async () => {
    requireFeature.mockRejectedValue(Object.assign(new Error('plan'), { statusCode: 402, code: 'plan_limit_file_upload' }));
    expect(await reason(() => assertUploadEnabledForSession('ten-1', 'cs-1'))).toBe('402:plan_limit_file_upload');
  });

  it('scopes the session lookup to the caller’s tenant', async () => {
    await reason(() => assertUploadEnabledForSession('ten-1', 'cs-1'));
    expect(sessionFindOne).toHaveBeenCalledWith({ where: { id: 'cs-1', tenantId: 'ten-1' } });
  });

  it('gives a foreign session the same 404 as a missing one', async () => {
    sessionFindOne.mockResolvedValue(null);
    expect(await reason(() => assertUploadEnabledForSession('ten-1', 'cs-other'))).toBe('404:NOT_FOUND');
    expect(requireFeature).not.toHaveBeenCalled();
  });
});

describe('widget upload gate — wiring', () => {
  it('is applied to BOTH the presign and the completion route', async () => {
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
