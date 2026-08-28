import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../automations', () => ({ getEmailService: () => ({ send }) }));

import { AppDataSource, runInTransaction } from '../../database/data-source';
import { EmailDelivery } from '../../database/entities/EmailDelivery';
import {
  creditTokenTopUp,
  getTokenBudget,
  isTokenBudgetExhausted,
  recordTokenUsage,
} from '../../billing/token-budget.service';
import { handleNormalizedEvent } from '../../billing/events';
import { setStripeClient } from '../../billing/providers/stripe';
import type { NormalizedEvent } from '../../billing/types';
import { createTestTenant, createTestUser } from '../helpers/factories';

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ success: true, messageId: 'token-budget-msg' });
});

afterEach(() => {
  setStripeClient(null);
});

describe('token budget cap', () => {
  it('sends one 80% warning, hard-stops at 110%, credits top-up, and rolls leftover top-up', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    await createTestUser(tenant.id, { role: 'admin' });

    await recordTokenUsage(tenant.id, { promptTokens: 3_999_999, completionTokens: 0 });
    await recordTokenUsage(tenant.id, { promptTokens: 2, completionTokens: 0 });

    const [balance] = (await AppDataSource.query(
      `SELECT id, period_used, period_start FROM tenant_token_balance WHERE tenant_id = $1`,
      [tenant.id],
    )) as Array<{ id: string; period_used: string | number; period_start: Date | string }>;
    expect(Number(balance.period_used)).toBe(4_000_001);
    const periodDate = new Date(balance.period_start).toISOString().slice(0, 10);

    await vi.waitFor(async () => {
      const deliveries = await AppDataSource.getRepository(EmailDelivery).find({
        where: { tenantId: tenant.id, kind: 'token_budget_80' },
      });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].idempotencyKey).toBe(`token_budget_80:${tenant.id}:${periodDate}`);
    });

    await recordTokenUsage(tenant.id, { promptTokens: 1_000, completionTokens: 0 });
    const after = await AppDataSource.getRepository(EmailDelivery).find({
      where: { tenantId: tenant.id, kind: 'token_budget_80' },
    });
    expect(after).toHaveLength(1);

    await AppDataSource.query(
      `UPDATE tenant_token_balance SET period_used = $2 WHERE tenant_id = $1`,
      [tenant.id, 5_500_000],
    );
    expect(await isTokenBudgetExhausted(tenant.id)).toBe(false);

    await AppDataSource.query(
      `UPDATE tenant_token_balance SET period_used = $2 WHERE tenant_id = $1`,
      [tenant.id, 5_500_001],
    );
    expect(await isTokenBudgetExhausted(tenant.id)).toBe(true);

    await AppDataSource.transaction(async (manager) => {
      await creditTokenTopUp(tenant.id, 5_000_000, manager);
    });
    expect(await isTokenBudgetExhausted(tenant.id)).toBe(false);

    await AppDataSource.query(
      `UPDATE tenant_token_balance
          SET period_used = 6000000,
              top_up_balance = 5000000,
              period_end = $2,
              warned80_at = now()
        WHERE tenant_id = $1`,
      [tenant.id, new Date('2020-01-01T00:00:00Z')],
    );
    const snapshot = await getTokenBudget(tenant.id);
    expect(snapshot.usedTokens).toBe(0);
    expect(snapshot.topUpTokens).toBe(4_000_000);

    const [rolled] = (await AppDataSource.query(
      `SELECT period_used, top_up_balance, warned80_at
         FROM tenant_token_balance WHERE tenant_id = $1`,
      [tenant.id],
    )) as Array<{
      period_used: string | number;
      top_up_balance: string | number;
      warned80_at: Date | string | null;
    }>;
    expect(Number(rolled.period_used)).toBe(0);
    expect(Number(rolled.top_up_balance)).toBe(4_000_000);
    expect(rolled.warned80_at).toBeNull();
  });

  it('credits a one-off token pack from checkout.session.completed', async () => {
    const tenant = await createTestTenant({ tier: 'essential' });
    setStripeClient({
      checkout: {
        sessions: {
          retrieve: vi.fn().mockResolvedValue({
            id: 'cs_topup_1',
            mode: 'payment',
            metadata: {
              tenantId: tenant.id,
              kind: 'token_topup',
              packId: 'tokens_5m',
              tokens: '5000000',
            },
          }),
        },
      },
    } as never);

    const event: NormalizedEvent = {
      providerEventId: 'evt_topup_1',
      type: 'checkout.session.completed',
      customerId: 'cus_topup',
      sessionId: 'cs_topup_1',
      subscription: null,
      occurredAt: new Date(),
      raw: { data: { object: { id: 'cs_topup_1' } } },
    };

    const result = await runInTransaction((manager) =>
      handleNormalizedEvent(manager, event, null),
    );
    expect(result.outcome).toBe('token_topup_credited');
    expect(result.meta).toMatchObject({
      tenantId: tenant.id,
      tokens: 5_000_000,
      packId: 'tokens_5m',
    });

    const snapshot = await getTokenBudget(tenant.id);
    expect(snapshot.topUpTokens).toBe(5_000_000);
  });
});
