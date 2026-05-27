import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import {
  getWidgetAppearance,
  updateWidgetAppearance,
} from '../../widget/widget-appearance.controller';

const mockFind = vi.fn();
const mockSave = vi.fn();

// Multi-bot Phase 4 (#16d): widget appearance reads/writes go through the
// Bot repo (anchor bot resolver). `findOne` is the call shape used by
// `getAnchorBotConfig`/`updateAnchorBotSettings`.
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: () => ({
      findOne: mockFind,
      findOneOrFail: mockFind,
      save: mockSave,
    }),
  },
}));

const makeReq = (body: Record<string, unknown> = {}) =>
  ({ body, tenantId: 'tenant-123' } as unknown as Request & { tenantId: string });

const makeRes = () => {
  const res = {} as Response;
  res.json = vi.fn().mockReturnValue(res);
  res.status = vi.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  mockFind.mockReset();
  mockSave.mockReset();
});

describe('getWidgetAppearance', () => {
  it('returns the saved widget+theme subset with defaults applied', async () => {
    mockFind.mockResolvedValueOnce({
      id: 'bot-anchor',
      tenantId: 'tenant-123',
      isDefault: true,
      settings: {
        theme: { primaryColor: '#abcdef' },
        widget: {
          avatarUrl: 'https://example.com/a.png',
          launcherPosition: 'bottom-left',
          launcherLabel: 'Hi',
        },
      },
    });
    const req = makeReq();
    const res = makeRes();
    await getWidgetAppearance(req, res);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        primaryColor: '#abcdef',
        avatarUrl: 'https://example.com/a.png',
        launcherPosition: 'bottom-left',
        launcherLabel: 'Hi',
      },
    });
  });

  it('returns null primaryColor/avatarUrl/launcherLabel and default position when nothing is saved', async () => {
    mockFind.mockResolvedValueOnce({ id: 'bot-anchor', tenantId: 'tenant-123', isDefault: true, settings: {} });
    const req = makeReq();
    const res = makeRes();
    await getWidgetAppearance(req, res);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        primaryColor: null,
        avatarUrl: null,
        launcherPosition: 'bottom-right',
        launcherLabel: null,
      },
    });
  });
});

describe('updateWidgetAppearance', () => {
  it('merges primaryColor into theme and other fields into widget; normalizes empty strings to null', async () => {
    // Multi-bot Phase 4 (#16d): writes target the anchor bot. The controller
    // calls findOne twice (once via getAnchorBotConfig to read, once inside
    // updateAnchorBotSettings to load + save), so use a default (not -Once).
    const bot = {
      id: 'bot-anchor',
      tenantId: 'tenant-123',
      isDefault: true,
      settings: { theme: { primaryColor: '#000000' }, widget: {} },
    };
    mockFind.mockResolvedValue(bot);
    mockSave.mockImplementation(async (b: any) => b);

    const req = makeReq({
      primaryColor: '#6366f1',
      avatarUrl: '',
      launcherPosition: 'bottom-left',
      launcherLabel: 'Chat',
    });
    const res = makeRes();
    await updateWidgetAppearance(req, res);

    expect(mockSave).toHaveBeenCalled();
    const saved = mockSave.mock.calls[0][0];
    expect(saved.settings.theme.primaryColor).toBe('#6366f1');
    expect(saved.settings.widget.avatarUrl).toBeNull();
    expect(saved.settings.widget.launcherPosition).toBe('bottom-left');
    expect(saved.settings.widget.launcherLabel).toBe('Chat');

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        primaryColor: '#6366f1',
        avatarUrl: null,
        launcherPosition: 'bottom-left',
        launcherLabel: 'Chat',
      },
    });
  });

  it('only writes fields present in the body (partial PATCH)', async () => {
    const bot = {
      id: 'bot-anchor',
      tenantId: 'tenant-123',
      isDefault: true,
      settings: {
        theme: { primaryColor: '#111111' },
        widget: { launcherPosition: 'bottom-left', launcherLabel: 'old' },
      },
    };
    mockFind.mockResolvedValue(bot);
    mockSave.mockImplementation(async (b: any) => b);

    const req = makeReq({ primaryColor: '#222222' });
    const res = makeRes();
    await updateWidgetAppearance(req, res);

    const saved = mockSave.mock.calls[0][0];
    expect(saved.settings.theme.primaryColor).toBe('#222222');
    expect(saved.settings.widget.launcherPosition).toBe('bottom-left');
    expect(saved.settings.widget.launcherLabel).toBe('old');
  });

  it('rejects invalid bodies via Zod', async () => {
    const req = makeReq({ primaryColor: 'not-a-hex' });
    const res = makeRes();
    await expect(updateWidgetAppearance(req, res)).rejects.toThrow();
    expect(mockSave).not.toHaveBeenCalled();
  });
});
