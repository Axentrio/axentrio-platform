/**
 * The calendar-reconnect alert.
 *
 * It runs on the token-refresh path a booking depends on, so the two properties worth pinning are
 * that it names the right Agent and that it can never turn a dead calendar into a failed booking.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { createForTenant } = vi.hoisted(() => ({ createForTenant: vi.fn() }));
vi.mock('../../services/notification.service', () => ({ notificationService: { createForTenant } }));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { alertCalendarReconnect } from '../../notifications/calendar-reauth-alert';
import { logger } from '../../utils/logger';

const DAY = new Date().toISOString().slice(0, 10);

describe('alertCalendarReconnect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('notifies the tenant once per Agent, provider and day', async () => {
    await alertCalendarReconnect({
      tenantId: 't1',
      botId: 'b1',
      provider: 'google',
      accountEmail: 'owner@axentrio.com',
    });

    expect(createForTenant).toHaveBeenCalledOnce();
    const input = createForTenant.mock.calls[0][0];
    expect(input).toMatchObject({
      tenantId: 't1',
      type: 'calendar_reconnect_required',
      data: { botId: 'b1', provider: 'google' },
      dedupeBase: `calendar_reauth:b1:google:${DAY}`,
    });
    // The message has to say what actually changed for the customer, not just that a token died.
    expect(input.message).toContain('captured as requests');
    expect(input.message).toContain('owner@axentrio.com');
  });

  it('names the provider when the account has no email on file', async () => {
    await alertCalendarReconnect({ tenantId: 't1', botId: 'b1', provider: 'outlook', accountEmail: null });
    const input = createForTenant.mock.calls[0][0];
    expect(input.title).toBe('Reconnect your Outlook Calendar');
    expect(input.message).not.toContain('(');
  });

  it('never throws when the notification cannot be written', async () => {
    // A booking must not fail because a notification could not be created.
    createForTenant.mockRejectedValue(new Error('db down'));
    await expect(
      alertCalendarReconnect({ tenantId: 't1', botId: 'b1', provider: 'google', accountEmail: null }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
