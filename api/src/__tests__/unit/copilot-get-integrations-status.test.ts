/**
 * Unit: getIntegrationsStatus copilot tool.
 *
 * Guards the wrong-information bug this change fixed:
 *   - Cal.com is shelved (booking.service books internally for every bot), so
 *     the tool must NOT report it.
 *   - Booking syncs to a Google OR Microsoft (Outlook) calendar — the tool must
 *     report whichever is active, not assume Google.
 */
import { describe, it, expect } from 'vitest';
import { getIntegrationsStatus } from '../../copilot/tools/getIntegrationsStatus';
import type { CopilotToolContext } from '../../copilot/tools/types';
import { Bot } from '../../database/entities/Bot';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { CalendarCredential } from '../../database/entities/CalendarCredential';

function ctxWith(opts: {
  bot?: unknown;
  connections?: unknown[];
  cred?: unknown;
}): CopilotToolContext {
  return {
    tenantId: 't1',
    userId: 'u1',
    manager: {
      findOne: async (entity: unknown) => {
        if (entity === Bot) return opts.bot ?? null;
        if (entity === CalendarCredential) return opts.cred ?? null;
        return null;
      },
      find: async (entity: unknown) =>
        entity === ChannelConnection ? (opts.connections ?? []) : [],
    },
  } as unknown as CopilotToolContext;
}

const BOT = { id: 'bot1' };

describe('getIntegrationsStatus', () => {
  it('never reports Cal.com (shelved) — no calcom key exists', async () => {
    const res = await getIntegrationsStatus.execute({}, ctxWith({ bot: BOT }));
    expect(res).not.toHaveProperty('calcom');
    expect(res).not.toHaveProperty('googleCalendar');
  });

  it('reports an unconfigured tenant as no calendar + all channels off', async () => {
    const res = await getIntegrationsStatus.execute({}, ctxWith({ bot: BOT }));
    expect(res.calendar).toEqual({ provider: null, status: 'not_connected' });
    expect(res.channels).toEqual({
      facebook: 'not_connected',
      instagram: 'not_connected',
      telegram: 'not_connected',
      whatsapp: 'not_connected',
    });
  });

  it('reports a connected Google calendar', async () => {
    const res = await getIntegrationsStatus.execute(
      {},
      ctxWith({ bot: BOT, cred: { provider: 'google', reauthRequired: false } }),
    );
    expect(res.calendar).toEqual({ provider: 'google', status: 'connected' });
  });

  it('reports a connected Microsoft (Outlook) calendar — not assumed Google', async () => {
    const res = await getIntegrationsStatus.execute(
      {},
      ctxWith({ bot: BOT, cred: { provider: 'microsoft', reauthRequired: false } }),
    );
    expect(res.calendar).toEqual({ provider: 'microsoft', status: 'connected' });
  });

  it('surfaces a dead token as needs_reconnect, keeping the provider', async () => {
    const res = await getIntegrationsStatus.execute(
      {},
      ctxWith({ bot: BOT, cred: { provider: 'microsoft', reauthRequired: true } }),
    );
    expect(res.calendar).toEqual({ provider: 'microsoft', status: 'needs_reconnect' });
  });

  it('maps messenger→facebook and only counts active channel connections', async () => {
    const res = await getIntegrationsStatus.execute(
      {},
      ctxWith({
        bot: BOT,
        connections: [
          { channel: 'messenger', status: 'active' },
          { channel: 'whatsapp', status: 'active' },
          { channel: 'instagram', status: 'disconnected' },
        ],
      }),
    );
    expect(res.channels).toEqual({
      facebook: 'connected',
      whatsapp: 'connected',
      instagram: 'not_connected',
      telegram: 'not_connected',
    });
  });
});
