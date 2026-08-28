import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAuthMocks, configureMockAuth } from '../helpers/auth';

const { auth } = createAuthMocks();

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
}));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { createTestTenant, createTestUser } from '../helpers/factories';
import { recordLlmUsage } from '../../llm/usage-recorder';
import { costUsd } from '../../llm/pricing';

const BASE = '/api/v1/admin/observability/llm-cost';

describe('admin observability — llm cost', () => {
  let tenantId: string;

  beforeEach(async () => {
    await AppDataSource.query('DELETE FROM llm_usage_daily');
    const tenant = await createTestTenant({ name: 'Cost Co', tier: 'pro' });
    tenantId = tenant.id;
    const admin = await createTestUser(tenantId, { role: 'super_admin' });
    configureMockAuth(auth, { userId: admin.id, tenantId, role: 'super_admin' });
  });

  it('rolls up two same-day records and returns JSON numbers', async () => {
    const usage = { promptTokens: 1000, completionTokens: 500 };
    await recordLlmUsage({
      tenantId,
      path: 'agent_reply',
      model: 'gpt-5.6-luna',
      usage,
    });
    await recordLlmUsage({
      tenantId,
      path: 'agent_reply',
      model: 'gpt-5.6-luna',
      usage,
    });

    const res = await request(app).get(`${BASE}?days=7`);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.days).toBe(7);
    expect(data.byPath[0].path).toBe('agent_reply');
    expect(data.byPath[0].calls).toBe(2);
    expect(data.byPath[0].promptTokens).toBe(2000);
    expect(data.byPath[0].completionTokens).toBe(1000);
    expect(data.byPath[0].costUsd).toBe(
      costUsd('gpt-5.6-luna', { promptTokens: 2000, completionTokens: 1000 }),
    );
    expect(typeof data.byPath[0].calls).toBe('number');
    expect(typeof data.byPath[0].promptTokens).toBe('number');
    expect(typeof data.byPath[0].completionTokens).toBe('number');
    expect(typeof data.byPath[0].costUsd).toBe('number');
    expect(typeof data.totalCostUsd).toBe('number');
    expect(data.byTenant[0].tenantId).toBe(tenantId);
    expect(data.byTenant[0].name).toBe('Cost Co');
  });

  it('surfaces platform-sentinel spend as platform', async () => {
    await recordLlmUsage({
      path: 'health_probe',
      model: 'gpt-5.6-luna',
      usage: { promptTokens: 10, completionTokens: 4 },
    });

    const res = await request(app).get(`${BASE}?days=7`);
    expect(res.status).toBe(200);
    const platform = res.body.data.byTenant.find(
      (row: { name: string }) => row.name === 'platform',
    );
    expect(platform).toBeTruthy();
    expect(platform.tenantId).toBeNull();
    expect(platform.calls).toBe(1);
    expect(typeof platform.costUsd).toBe('number');
  });
});
