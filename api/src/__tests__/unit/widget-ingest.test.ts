/**
 * One ingestion path, so a chosen address behaves exactly like a typed one.
 *
 * This exists because of a specific near-miss. The obvious way to make `/places/select` speak into
 * the conversation is to write a `Message` row and call `scheduleTurn` - which looks complete,
 * reads well, and is wrong: `scheduleTurn` schedules a message that is ALREADY persisted, and
 * everything that makes a message real happens above it in the route handler.
 *
 * Skipping those would produce a conversation where the customer's address is in the transcript,
 * the bot answers it, and the operator's inbox never lights up - because the socket event, the
 * participant the message is attributed to, and the session's own counters all live in the part
 * that got skipped. Every assertion here is one of those four things.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const saved: Record<string, unknown[]> = { message: [], participant: [], session: [] };
const emit = vi.fn();
const schedule = vi.fn();
const participantFindOne = vi.fn();

const repo = (name: string) => ({
  findOne: name === 'participant' ? participantFindOne : vi.fn(async () => null),
  create: (v: Record<string, unknown>) => ({ id: `${name}-1`, createdAt: new Date(), ...v }),
  save: vi.fn(async (v: unknown) => {
    saved[name].push(v);
    return v;
  }),
});

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name: string }) => {
      if (entity.name === 'Message') return repo('message');
      if (entity.name === 'Participant') return repo('participant');
      return repo('session');
    },
  },
}));
vi.mock('../../utils/encryption', () => ({ encrypt: (v: string) => `enc(${v})` }));
vi.mock('../../websocket/socket.handler', () => ({ emitToSession: (...a: unknown[]) => emit(...(a as [])) }));
vi.mock('../../services/turn-coalescer', () => ({ scheduleTurn: (...a: unknown[]) => schedule(...(a as [])) }));
vi.mock('../../utils/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { ingestWidgetCustomerMessage } from '../../services/widget-ingest';

const session = () => ({
  id: 'sess-1',
  tenantId: 'ten-1',
  incrementMessageCount: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(saved)) saved[k] = [];
  participantFindOne.mockResolvedValue({ id: 'part-1' });
  // Detached with `.catch`, so it must be a promise even in the happy path.
  schedule.mockResolvedValue(undefined);
});

describe('ingestWidgetCustomerMessage', () => {
  it('attributes the message to the session’s visitor participant', async () => {
    await ingestWidgetCustomerMessage(session() as never, 'My address is Grote Markt 1');
    expect((saved.message[0] as { participantId: string }).participantId).toBe('part-1');
  });

  it('creates the visitor participant when the selection is the FIRST thing that happens', async () => {
    // A customer can pick an address before typing anything, so this path cannot assume a
    // participant already exists.
    participantFindOne.mockResolvedValue(null);
    await ingestWidgetCustomerMessage(session() as never, 'My address is Grote Markt 1');
    expect(saved.participant).toHaveLength(1);
    expect((saved.participant[0] as { type: string }).type).toBe('user');
  });

  it('encrypts at rest but emits in the clear', async () => {
    // The split the route already made: the column is at rest, the socket is an authenticated
    // live channel to the operator reading this conversation. A dashboard showing ciphertext is
    // a dashboard nobody can use.
    await ingestWidgetCustomerMessage(session() as never, 'My address is Grote Markt 1');

    expect((saved.message[0] as { content: string }).content).toBe('enc(My address is Grote Markt 1)');
    expect((saved.message[0] as { contentEncrypted: boolean }).contentEncrypted).toBe(true);
    const [, , event, payload] = emit.mock.calls[0] as [string, string, string, { content: string }];
    expect(event).toBe('message:receive');
    expect(payload.content).toBe('My address is Grote Markt 1');
  });

  it('counts the message on the session', async () => {
    const s = session();
    await ingestWidgetCustomerMessage(s as never, 'hello');
    expect(s.incrementMessageCount).toHaveBeenCalledTimes(1);
    expect(saved.session).toHaveLength(1);
  });

  it('schedules the turn, so the bot actually answers', async () => {
    await ingestWidgetCustomerMessage(session() as never, 'hello');
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('does all four, not merely the turn', async () => {
    // The near-miss, stated as one assertion: a second producer that only scheduled would pass
    // every test above except this one.
    await ingestWidgetCustomerMessage(session() as never, 'hello');
    expect(saved.message).toHaveLength(1);
    expect(saved.session).toHaveLength(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('still returns the message when scheduling fails', async () => {
    // Detached deliberately: the customer's message is saved and acknowledged whatever the bot
    // does next, and a scheduling failure must not read to them as a lost message.
    schedule.mockRejectedValue(new Error('queue down'));
    await expect(ingestWidgetCustomerMessage(session() as never, 'hello')).resolves.toMatchObject({
      content: 'hello',
    });
  });
});
