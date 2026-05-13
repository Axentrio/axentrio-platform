import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks (must come before imports) ────────────────────────────────────────

const mockFindOne = vi.fn();
const mockSave = vi.fn();

vi.mock('../../database/data-source', () => ({
  getRepository: vi.fn(() => ({
    findOne: mockFindOne,
    save: mockSave,
  })),
}));

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../channels/credential-utils', () => ({
  getTelegramBotToken: vi.fn((creds: Record<string, unknown>) => (creds.botToken as string) ?? null),
  getMetaPageAccessToken: vi.fn((creds: Record<string, unknown>) => (creds.pageAccessToken as string) ?? null),
}));

import axios from 'axios';
import { runHealthCheck } from '../../channels/health-check.service';

const axiosGet = vi.mocked(axios.get);

const baseConn = {
  id: 'conn-1',
  tenantId: 'tenant-1',
  channel: 'telegram' as const,
  status: 'active' as const,
  label: 'Support Bot',
  platformAccountId: '12345',
  credentials: { botToken: 'secret-token' },
  webhookSecret: 'wh-secret',
  webhookVerifyToken: null,
  config: {},
  scopes: null,
  lastHealthCheckAt: null,
  lastError: null,
  createdAt: new Date('2026-05-12T00:00:00Z'),
  updatedAt: new Date('2026-05-12T00:00:00Z'),
};

beforeEach(() => {
  mockFindOne.mockReset();
  mockSave.mockReset();
  axiosGet.mockReset();
  mockSave.mockImplementation((entity) => Promise.resolve(entity));
});

describe('runHealthCheck (Telegram)', () => {
  it('marks the connection healthy when getMe returns ok', async () => {
    mockFindOne.mockResolvedValue({ ...baseConn });
    axiosGet.mockResolvedValue({ data: { ok: true, result: { id: 1, username: 'b' } } });

    const result = await runHealthCheck('conn-1');

    expect(axiosGet).toHaveBeenCalledWith(
      'https://api.telegram.org/botsecret-token/getMe',
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(result.status).toBe('active');
    expect(result.lastError).toBeNull();
    expect(result.lastHealthCheckAt).toBeInstanceOf(Date);
  });

  it('marks the connection errored when getMe rejects', async () => {
    mockFindOne.mockResolvedValue({ ...baseConn });
    axiosGet.mockRejectedValue(new Error('Unauthorized'));

    const result = await runHealthCheck('conn-1');

    expect(result.status).toBe('error');
    expect(result.lastError).toBe('Unauthorized');
    expect(result.lastHealthCheckAt).toBeInstanceOf(Date);
  });

  it('records the error when bot token is missing', async () => {
    mockFindOne.mockResolvedValue({ ...baseConn, credentials: {} });

    const result = await runHealthCheck('conn-1');

    expect(axiosGet).not.toHaveBeenCalled();
    expect(result.status).toBe('error');
    expect(result.lastError).toMatch(/Missing botToken/);
  });
});

describe('runHealthCheck (Meta)', () => {
  it('marks Messenger healthy when /me returns an id', async () => {
    mockFindOne.mockResolvedValue({
      ...baseConn,
      channel: 'messenger',
      credentials: { pageAccessToken: 'page-token' },
    });
    axiosGet.mockResolvedValue({ data: { id: '99', name: 'Acme Page' } });

    const result = await runHealthCheck('conn-1');

    expect(axiosGet).toHaveBeenCalledWith(
      'https://graph.facebook.com/v21.0/me',
      expect.objectContaining({
        params: expect.objectContaining({ access_token: 'page-token' }),
      }),
    );
    expect(result.status).toBe('active');
  });

  it('marks Instagram errored when /me has no id', async () => {
    mockFindOne.mockResolvedValue({
      ...baseConn,
      channel: 'instagram',
      credentials: { pageAccessToken: 'page-token' },
    });
    axiosGet.mockResolvedValue({ data: {} });

    const result = await runHealthCheck('conn-1');

    expect(result.status).toBe('error');
    expect(result.lastError).toMatch(/no id/i);
  });
});

describe('runHealthCheck (preserves non-active status)', () => {
  it('does not flip status when the connection is pending_setup', async () => {
    mockFindOne.mockResolvedValue({ ...baseConn, status: 'pending_setup' });
    axiosGet.mockResolvedValue({ data: { ok: true, result: { id: 1 } } });

    const result = await runHealthCheck('conn-1');

    expect(result.status).toBe('pending_setup');
    expect(result.lastHealthCheckAt).toBeInstanceOf(Date);
  });

  it('does not flip status when the connection is disconnected', async () => {
    mockFindOne.mockResolvedValue({ ...baseConn, status: 'disconnected' });
    axiosGet.mockRejectedValue(new Error('fail'));

    const result = await runHealthCheck('conn-1');

    expect(result.status).toBe('disconnected');
    expect(result.lastError).toBe('fail');
  });
});

describe('runHealthCheck (lookup)', () => {
  it('throws when the connection is not found', async () => {
    mockFindOne.mockResolvedValue(null);

    await expect(runHealthCheck('missing')).rejects.toThrow(/not found/);
  });
});
