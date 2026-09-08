import { describe, it, expect, vi, beforeEach } from 'vitest';

const find = vi.fn();
const findOne = vi.fn();
const query = vi.fn();
const cancel = vi.fn();
const sendDurable = vi.fn();
const resolveBillingEmailMock = vi.fn();
const resolveOwnerLanguageMock = vi.fn();
const invalidateMock = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: () => ({ find, findOne }),
    query: (...args: unknown[]) => query(...args),
  },
}));

vi.mock('../../billing/service', () => ({
  resolveBillingEmail: (...args: unknown[]) => resolveBillingEmailMock(...args),
}));

vi.mock('../../services/email-delivery.service', () => ({
  emailDeliveryService: { sendDurable: (...args: unknown[]) => sendDurable(...args) },
}));

vi.mock('../../i18n/audience-language', () => ({
  resolveOwnerLanguage: (...args: unknown[]) => resolveOwnerLanguageMock(...args),
}));

vi.mock('../../modules', () => ({
  invalidateEntitlementsAndModules: (...args: unknown[]) => invalidateMock(...args),
}));

vi.mock('../../billing/providers/stripe', () => ({
  getStripeClient: () => ({ subscriptions: { cancel } }),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config/environment', () => ({
  config: { portal: { url: 'https://portal.test' } },
}));

import Stripe from 'stripe';
import {
  cancelPastDueSubscriptionNow,
  runDunningSweep,
  sendDunningReminder,
} from '../../billing/dunning';
import { renderDunningEmail } from '../../billing/dunning-copy';
import { BillingProviderError } from '../../billing/types';

const STARTED = new Date('2026-04-01T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;

type Row = {
  id: string;
  tenantId: string;
  provider: 'stripe' | 'manual';
  status: string;
  currentPlanId: string;
  isPrimary: boolean;
  subscriptionId: string | null;
  dunningStartedAt: Date | null;
};

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'tba-1',
    tenantId: 'tenant-1',
    provider: 'stripe',
    status: 'past_due',
    currentPlanId: 'pro',
    isPrimary: true,
    subscriptionId: 'sub_1',
    dunningStartedAt: STARTED,
    ...overrides,
  };
}

describe('runDunningSweep', () => {
  let row: Row;

  beforeEach(() => {
    row = makeRow();
    find.mockReset();
    findOne.mockReset();
    query.mockReset();
    cancel.mockReset();
    sendDurable.mockReset();
    resolveBillingEmailMock.mockReset();
    resolveOwnerLanguageMock.mockReset();
    invalidateMock.mockReset();

    find.mockImplementation(async () =>
      row.status === 'past_due' && row.isPrimary && row.provider === 'stripe' ? [row] : [],
    );
    findOne.mockImplementation(async () => row);
    query.mockImplementation(async () => {
      row.status = 'cancelled';
      row.currentPlanId = 'free';
      row.dunningStartedAt = null;
      row.subscriptionId = null;
      return [[{ id: row.tenantId }], 1];
    });
    cancel.mockResolvedValue({ id: 'sub_1', status: 'canceled' });
    sendDurable.mockResolvedValue({ status: 'sent' });
    resolveBillingEmailMock.mockResolvedValue('billing@example.com');
    resolveOwnerLanguageMock.mockResolvedValue('en');
    invalidateMock.mockResolvedValue(undefined);
  });

  it('elapsed = 0 sends one day-0 email and does not cancel', async () => {
    const result = await runDunningSweep(STARTED);

    expect(result).toEqual({ reminded: 1, dropped: 0 });
    expect(cancel).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(sendDurable).toHaveBeenCalledTimes(1);
    expect(sendDurable).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        recipientEmail: 'billing@example.com',
        kind: 'billing_dunning',
        relatedId: 'tenant-1',
        idempotencyKey: 'billing_dunning:tenant-1:2026-04-01T00:00:00.000Z:day0',
        subject: 'Payment failed — 3 days left to update your card',
      }),
    );
  });

  it('elapsed just under 24h still sends day-0', async () => {
    const result = await runDunningSweep(new Date(STARTED.getTime() + 24 * HOUR - 1));

    expect(result).toEqual({ reminded: 1, dropped: 0 });
    expect(cancel).not.toHaveBeenCalled();
    expect(sendDurable.mock.calls[0][0].idempotencyKey).toBe(
      'billing_dunning:tenant-1:2026-04-01T00:00:00.000Z:day0',
    );
  });

  it('elapsed exactly 24h sends the day-1 key and does not cancel', async () => {
    const result = await runDunningSweep(new Date(STARTED.getTime() + 24 * HOUR));

    expect(result).toEqual({ reminded: 1, dropped: 0 });
    expect(cancel).not.toHaveBeenCalled();
    expect(sendDurable).toHaveBeenCalledTimes(1);
    expect(sendDurable.mock.calls[0][0].idempotencyKey).toBe(
      'billing_dunning:tenant-1:2026-04-01T00:00:00.000Z:day1',
    );
  });

  it('elapsed just under 48h still sends day-1', async () => {
    const result = await runDunningSweep(new Date(STARTED.getTime() + 48 * HOUR - 1));

    expect(result).toEqual({ reminded: 1, dropped: 0 });
    expect(cancel).not.toHaveBeenCalled();
    expect(sendDurable.mock.calls[0][0].idempotencyKey).toBe(
      'billing_dunning:tenant-1:2026-04-01T00:00:00.000Z:day1',
    );
  });

  it('elapsed exactly 48h sends the day-2 key and does not cancel', async () => {
    const result = await runDunningSweep(new Date(STARTED.getTime() + 48 * HOUR));

    expect(result).toEqual({ reminded: 1, dropped: 0 });
    expect(cancel).not.toHaveBeenCalled();
    expect(sendDurable).toHaveBeenCalledTimes(1);
    expect(sendDurable.mock.calls[0][0].idempotencyKey).toBe(
      'billing_dunning:tenant-1:2026-04-01T00:00:00.000Z:day2',
    );
  });

  it('elapsed = 25h sends the day-1 key only', async () => {
    const result = await runDunningSweep(new Date(STARTED.getTime() + 25 * HOUR));

    expect(result).toEqual({ reminded: 1, dropped: 0 });
    expect(cancel).not.toHaveBeenCalled();
    expect(sendDurable).toHaveBeenCalledTimes(1);
    expect(sendDurable.mock.calls[0][0].idempotencyKey).toBe(
      'billing_dunning:tenant-1:2026-04-01T00:00:00.000Z:day1',
    );
    expect(sendDurable.mock.calls[0][0].subject).toBe(
      'Payment failed — 2 days left to update your card',
    );
  });

  it('elapsed = 49h sends the day-2 key', async () => {
    const result = await runDunningSweep(new Date(STARTED.getTime() + 49 * HOUR));

    expect(result).toEqual({ reminded: 1, dropped: 0 });
    expect(cancel).not.toHaveBeenCalled();
    expect(sendDurable).toHaveBeenCalledTimes(1);
    expect(sendDurable.mock.calls[0][0].idempotencyKey).toBe(
      'billing_dunning:tenant-1:2026-04-01T00:00:00.000Z:day2',
    );
    expect(sendDurable.mock.calls[0][0].subject).toBe(
      'Payment failed — 1 day left to update your card',
    );
  });

  it('elapsed = 72h cancels the Stripe subscription and drops to free', async () => {
    const now = new Date(STARTED.getTime() + 72 * HOUR);
    const first = await runDunningSweep(now);

    expect(first).toEqual({ reminded: 0, dropped: 1 });
    expect(sendDurable).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('sub_1');
    expect(query).toHaveBeenCalledTimes(1);
    expect(invalidateMock).toHaveBeenCalledWith('tenant-1');
    expect(row).toMatchObject({
      status: 'cancelled',
      currentPlanId: 'free',
      dunningStartedAt: null,
      subscriptionId: null,
    });

    cancel.mockClear();
    query.mockClear();
    invalidateMock.mockClear();

    const second = await runDunningSweep(now);
    expect(second).toEqual({ reminded: 0, dropped: 0 });
    expect(cancel).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('past_due with a null clock is untouched', async () => {
    row.dunningStartedAt = null;

    const result = await runDunningSweep(new Date(STARTED.getTime() + 80 * HOUR));

    expect(result).toEqual({ reminded: 0, dropped: 0 });
    expect(sendDurable).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('active before 72h is not cancelled and is not emailed', async () => {
    row.status = 'active';

    const result = await runDunningSweep(new Date(STARTED.getTime() + 49 * HOUR));

    expect(result).toEqual({ reminded: 0, dropped: 0 });
    expect(sendDurable).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('elapsed just under 72h sends day-2 and does not cancel', async () => {
    const result = await runDunningSweep(new Date(STARTED.getTime() + 72 * HOUR - 1));

    expect(result).toEqual({ reminded: 1, dropped: 0 });
    expect(cancel).not.toHaveBeenCalled();
    expect(sendDurable.mock.calls[0][0].idempotencyKey).toContain(':day2');
  });

  it('elapsed exactly 72h drops and does not email', async () => {
    const result = await runDunningSweep(new Date(STARTED.getTime() + 72 * HOUR));

    expect(result).toEqual({ reminded: 0, dropped: 1 });
    expect(cancel).toHaveBeenCalledWith('sub_1');
    expect(sendDurable).not.toHaveBeenCalled();
  });

  it('resource_missing from Stripe still drops locally', async () => {
    cancel.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        message: 'No such subscription',
        type: 'invalid_request_error',
        code: 'resource_missing',
      }),
    );

    const result = await runDunningSweep(new Date(STARTED.getTime() + 72 * HOUR));

    expect(result).toEqual({ reminded: 0, dropped: 1 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(invalidateMock).toHaveBeenCalledWith('tenant-1');
    expect(row.status).toBe('cancelled');
  });

  it('other Stripe cancel errors skip without local drop', async () => {
    cancel.mockRejectedValue(new Error('stripe timeout'));

    const result = await runDunningSweep(new Date(STARTED.getTime() + 72 * HOUR));

    expect(result).toEqual({ reminded: 0, dropped: 0 });
    expect(query).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
    expect(row.status).toBe('past_due');
  });

  it('unresolvable billing email skips the send but still drops at 72h', async () => {
    resolveBillingEmailMock.mockRejectedValue(
      new BillingProviderError('billing_email_unresolvable', 'stripe'),
    );

    const reminded = await runDunningSweep(STARTED);
    expect(reminded).toEqual({ reminded: 1, dropped: 0 });
    expect(sendDurable).not.toHaveBeenCalled();

    const dropped = await runDunningSweep(new Date(STARTED.getTime() + 72 * HOUR));
    expect(dropped).toEqual({ reminded: 0, dropped: 1 });
    expect(cancel).toHaveBeenCalledWith('sub_1');
  });

  it('non-primary and manual past_due rows are not swept', async () => {
    row.isPrimary = false;
    expect(await runDunningSweep(new Date(STARTED.getTime() + 80 * HOUR))).toEqual({
      reminded: 0,
      dropped: 0,
    });

    row.isPrimary = true;
    row.provider = 'manual';
    expect(await runDunningSweep(new Date(STARTED.getTime() + 80 * HOUR))).toEqual({
      reminded: 0,
      dropped: 0,
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('empty subscriptionId is not cancelled', async () => {
    row.subscriptionId = '';
    const result = await runDunningSweep(new Date(STARTED.getTime() + 72 * HOUR));
    expect(result).toEqual({ reminded: 0, dropped: 0 });
    expect(cancel).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('a reminder failure does not starve a later overdue drop', async () => {
    const remind = makeRow({
      id: 'tba-remind',
      tenantId: 't-remind',
      subscriptionId: 'sub_r',
    });
    const drop = makeRow({
      id: 'tba-drop',
      tenantId: 't-drop',
      subscriptionId: 'sub_d',
      dunningStartedAt: new Date(STARTED.getTime() - 72 * HOUR),
    });
    find.mockResolvedValue([remind, drop]);
    findOne.mockImplementation(async (args: { where?: { tenantId?: string } }) =>
      args?.where?.tenantId === 't-drop' ? drop : remind,
    );
    sendDurable.mockRejectedValue(new Error('delivery down'));
    query.mockImplementation(async () => {
      drop.status = 'cancelled';
      drop.currentPlanId = 'free';
      drop.dunningStartedAt = null;
      drop.subscriptionId = null;
      return [[{ id: drop.tenantId }], 1];
    });

    const result = await runDunningSweep(STARTED);

    expect(result).toEqual({ reminded: 0, dropped: 1 });
    expect(cancel).toHaveBeenCalledWith('sub_d');
    expect(cancel).not.toHaveBeenCalledWith('sub_r');
  });

  it('overlapping ticks skip while a sweep is in flight', async () => {
    let resolveFind: ((rows: Row[]) => void) | undefined;
    find.mockImplementation(
      () =>
        new Promise<Row[]>((resolve) => {
          resolveFind = resolve;
        }),
    );

    const first = runDunningSweep(STARTED);
    await vi.waitFor(() => {
      expect(resolveFind).toBeDefined();
    });
    const second = await runDunningSweep(STARTED);
    expect(second).toEqual({ reminded: 0, dropped: 0 });
    expect(sendDurable).not.toHaveBeenCalled();

    resolveFind!([row]);
    await first;
  });
});

describe('sendDunningReminder', () => {
  beforeEach(() => {
    findOne.mockReset();
    sendDurable.mockReset();
    resolveBillingEmailMock.mockReset();
    resolveOwnerLanguageMock.mockReset();
    sendDurable.mockResolvedValue({ status: 'sent' });
    resolveBillingEmailMock.mockResolvedValue('billing@example.com');
    resolveOwnerLanguageMock.mockResolvedValue('en');
  });

  it('no-ops when the row is no longer past_due', async () => {
    findOne.mockResolvedValue(makeRow({ status: 'active', dunningStartedAt: STARTED }));
    await sendDunningReminder('tenant-1', 0, STARTED);
    expect(sendDurable).not.toHaveBeenCalled();
  });

  it('no-ops once the grace window has ended', async () => {
    findOne.mockResolvedValue(makeRow());
    await sendDunningReminder('tenant-1', 2, new Date(STARTED.getTime() + 72 * HOUR));
    expect(sendDurable).not.toHaveBeenCalled();
  });

  it('escapes the plan name and uses NL copy', async () => {
    findOne.mockResolvedValue(makeRow({ currentPlanId: 'pro<script>' }));
    resolveOwnerLanguageMock.mockResolvedValue('nl');

    await sendDunningReminder('tenant-1', 0, STARTED);

    expect(sendDurable).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Betaling mislukt — nog 3 dagen om je kaart bij te werken',
        body: expect.stringContaining('pro&lt;script&gt;'),
      }),
    );
    expect(sendDurable.mock.calls[0][0].body).not.toContain('<script>');
  });
});

describe('renderDunningEmail', () => {
  const grace = new Date('2026-04-04T00:00:00.000Z');

  it('uses singular EN subject on the last day', () => {
    const { subject } = renderDunningEmail({
      locale: 'en',
      day: 2,
      plan: 'pro',
      graceEndsAt: grace,
    });
    expect(subject).toBe('Payment failed — 1 day left to update your card');
  });

  it('falls unknown locales back to English', () => {
    const { subject, body } = renderDunningEmail({
      locale: 'de',
      day: 0,
      plan: 'pro',
      graceEndsAt: grace,
    });
    expect(subject).toContain('Payment failed');
    expect(body).toContain('2026-04-04');
  });

  it('renders FR copy', () => {
    const { subject, body } = renderDunningEmail({
      locale: 'fr',
      day: 1,
      plan: 'pro',
      graceEndsAt: grace,
    });
    expect(subject).toBe('Paiement échoué — 2 jours pour mettre à jour votre carte');
    expect(body).toContain('Mettre à jour le moyen de paiement');
  });
});

describe('cancelPastDueSubscriptionNow', () => {
  beforeEach(() => {
    findOne.mockReset();
    query.mockReset();
    cancel.mockReset();
    invalidateMock.mockReset();
  });

  it('returns skipped when Stripe cancel succeeds but the CTE matches nothing', async () => {
    findOne.mockResolvedValue(makeRow());
    cancel.mockResolvedValue({ id: 'sub_1', status: 'canceled' });
    query.mockResolvedValue([[], 0]);

    const result = await cancelPastDueSubscriptionNow(
      'tenant-1',
      new Date(STARTED.getTime() + 72 * HOUR),
    );

    expect(result).toBe('skipped');
    expect(cancel).toHaveBeenCalledWith('sub_1');
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});
