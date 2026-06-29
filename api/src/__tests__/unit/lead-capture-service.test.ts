/**
 * Contract tests for the lead-capture service (.scratch/plan-leads-all-channels.md).
 *
 * The `upsertLead` SQL itself (the ON CONFLICT partial-index upsert) is covered
 * by a DB-backed integration test — unit mocks can't exercise the real conflict
 * behavior (the exact lesson from the silent email upsert). Here we pin the
 * pure logic around it: dedupe-key precedence, normalization, gating, the
 * SQL params handed to the driver, and the new/updated fan-out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const emitWebhookEvent = vi.fn();
const createForTenant = vi.fn().mockResolvedValue(undefined);
vi.mock('../../webhooks/webhook.emitter', () => ({
  emitWebhookEvent: (...a: unknown[]) => emitWebhookEvent(...a),
  buildEventBase: () => ({ id: 'e', tenantId: 't', sessionId: 's', timestamp: 'now', session: {} }),
}));
vi.mock('../../services/notification.service', () => ({
  notificationService: { createForTenant: (...a: unknown[]) => createForTenant(...a) },
}));

// leadCapture entitlement — flipped per test.
const ent = vi.hoisted(() => ({ leadCapture: true, fail: false }));
vi.mock('../../billing/entitlements', () => ({
  getEntitlements: vi.fn(async () => {
    if (ent.fail) throw new Error('redis down');
    return { features: { leadCapture: ent.leadCapture } };
  }),
}));

import { upsertLead } from '../../leads/lead-capture.service';

const TENANT = 'aaaa0000-bbbb-cccc-dddd-eeeeeeee0001';

/** A fake DataSource whose query() records calls and returns a scripted row. */
function fakeDs(row: { id: string; inserted: boolean } | null = { id: 'lead-1', inserted: true }) {
  const query = vi.fn().mockResolvedValue(row ? [row] : []);
  return {
    query,
    getRepository: () => ({ findOne: vi.fn().mockResolvedValue(null) }),
  } as never;
}
// Pull the dedupe_key (param $9) out of the recorded INSERT call.
function keyOf(ds: { query: ReturnType<typeof vi.fn> }): string {
  return ds.query.mock.calls[0][1][8];
}
function paramOf(ds: { query: ReturnType<typeof vi.fn> }, idx: number): unknown {
  return ds.query.mock.calls[0][1][idx];
}

describe('upsertLead — dedupe key precedence (D2)', () => {
  beforeEach(() => { ent.leadCapture = true; ent.fail = false; vi.clearAllMocks(); });

  it('channel session keys on <channel>:<externalUserId>', async () => {
    const ds = fakeDs();
    await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'channel', channel: 'whatsapp', externalUserId: '32475464421', name: 'Achraf' });
    expect(keyOf(ds as never)).toBe('whatsapp:32475464421');
  });

  it('messenger keys on the PSID even with no name', async () => {
    const ds = fakeDs();
    await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'channel', channel: 'messenger', externalUserId: '27319018641120491' });
    expect(keyOf(ds as never)).toBe('messenger:27319018641120491');
  });

  it('widget anchors on email when both email and phone are given', async () => {
    const ds = fakeDs();
    await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'tool', channel: 'widget', email: 'A@B.com', phone: '+32 475 11 22 33' });
    expect(keyOf(ds as never)).toBe('email:a@b.com');
  });

  it('widget falls back to phone:<digits> when only a phone is given', async () => {
    const ds = fakeDs();
    await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'tool', channel: 'widget', phone: '+32 475 11 22 33' });
    expect(keyOf(ds as never)).toBe('phone:32475112233');
  });

  it('no identifier → no-op (null), no query', async () => {
    const ds = fakeDs();
    const res = await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'tool', channel: 'widget', name: 'Anonymous' });
    expect(res).toBeNull();
    expect((ds as never as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });
});

describe('upsertLead — normalization (D11)', () => {
  beforeEach(() => { ent.leadCapture = true; ent.fail = false; vi.clearAllMocks(); });

  it('a widget +32 475… and a WhatsApp wa_id 32475… collapse to the same key', async () => {
    const widget = fakeDs();
    await upsertLead({ dataSource: widget, tenantId: TENANT, source: 'tool', channel: 'widget', phone: '+32 475-11-22-33' });
    const wa = fakeDs();
    await upsertLead({ dataSource: wa, tenantId: TENANT, source: 'channel', channel: 'whatsapp', externalUserId: '32475112233' });
    // widget → phone:32475112233 ; whatsapp → whatsapp:32475112233 (different
    // prefixes by design — but the normalized DIGITS match, which is the unit under test)
    expect(keyOf(widget as never).replace('phone:', '')).toBe('32475112233');
    expect(keyOf(wa as never).replace('whatsapp:', '')).toBe('32475112233');
  });

  it('WhatsApp externalUserId is also stored as the phone column', async () => {
    const ds = fakeDs();
    await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'channel', channel: 'whatsapp', externalUserId: '32475464421', name: 'Achraf' });
    expect(paramOf(ds as never, 5)).toBe('32475464421'); // $6 = phone
  });

  it('email is lowercased+trimmed for both key and stored value', async () => {
    const ds = fakeDs();
    await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'tool', channel: 'widget', email: '  Foo@Bar.COM ' });
    expect(keyOf(ds as never)).toBe('email:foo@bar.com');
    expect(paramOf(ds as never, 4)).toBe('foo@bar.com'); // $5 = email
  });
});

describe('upsertLead — request summary (notes)', () => {
  beforeEach(() => { ent.leadCapture = true; ent.fail = false; vi.clearAllMocks(); });

  it('passes the trimmed notes as SQL param $12', async () => {
    const ds = fakeDs();
    await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'tool', channel: 'widget', email: 'a@b.com', notes: '  Leak under the sink, Kerkstraat 12  ' });
    expect(paramOf(ds as never, 11)).toBe('Leak under the sink, Kerkstraat 12'); // $12 = notes
  });

  it('an empty/whitespace summary normalizes to null (never blanks via the empty string)', async () => {
    const ds = fakeDs();
    await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'tool', channel: 'widget', email: 'a@b.com', notes: '   ' });
    expect(paramOf(ds as never, 11)).toBeNull();
  });

  it('omitted notes → null param (contact-only capture)', async () => {
    const ds = fakeDs();
    await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'tool', channel: 'widget', email: 'a@b.com' });
    expect(paramOf(ds as never, 11)).toBeNull();
  });
});

describe('upsertLead — gating (D6)', () => {
  beforeEach(() => { ent.leadCapture = true; ent.fail = false; vi.clearAllMocks(); });

  it('leadCapture off → no-op, no write', async () => {
    ent.leadCapture = false;
    const ds = fakeDs();
    const res = await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'channel', channel: 'whatsapp', externalUserId: '32475464421' });
    expect(res).toBeNull();
    expect((ds as never as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });

  it('entitlement resolution error → fail closed (no write)', async () => {
    ent.fail = true;
    const ds = fakeDs();
    const res = await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'channel', channel: 'whatsapp', externalUserId: '32475464421' });
    expect(res).toBeNull();
    expect((ds as never as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });
});

describe('upsertLead — source rank passed for the D8 upgrade', () => {
  beforeEach(() => { ent.leadCapture = true; ent.fail = false; vi.clearAllMocks(); });

  it('booking passes the highest rank (param $11)', async () => {
    const ds = fakeDs();
    await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'booking', channel: 'whatsapp', externalUserId: '32475464421', email: 'a@b.com' });
    expect(paramOf(ds as never, 10)).toBe(2); // $11 = source rank, booking=2
  });

  it('channel passes the lowest rank', async () => {
    const ds = fakeDs();
    await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'channel', channel: 'whatsapp', externalUserId: '32475464421' });
    expect(paramOf(ds as never, 10)).toBe(0); // channel=0
  });
});

describe('upsertLead — fan-out (D10)', () => {
  beforeEach(() => { ent.leadCapture = true; ent.fail = false; vi.clearAllMocks(); });

  it('emits lead.created webhook only on a NEW lead', async () => {
    const ds = fakeDs({ id: 'lead-1', inserted: true });
    await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'channel', channel: 'whatsapp', externalUserId: '32475464421', name: 'Achraf' });
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget settle
    expect(emitWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it('threads the request summary (notes) into the lead.created webhook AND the operator notification', async () => {
    const ds = fakeDs({ id: 'lead-1', inserted: true });
    await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'tool', channel: 'widget', email: 'a@b.com', notes: 'Leak under the sink, Kerkstraat 12' });
    await new Promise((r) => setImmediate(r));
    // webhook payload carries the request so n8n/automations can route on it
    const event = emitWebhookEvent.mock.calls[0][0];
    expect(event.lead.notes).toBe('Leak under the sink, Kerkstraat 12');
    // operator notification surfaces the request in the body + data, not just the contact
    const notif = createForTenant.mock.calls[0][0];
    expect(notif.message).toContain('Leak under the sink');
    expect(notif.data.notes).toBe('Leak under the sink, Kerkstraat 12');
  });

  it('does NOT emit on an update (re-touch of an existing lead)', async () => {
    const ds = fakeDs({ id: 'lead-1', inserted: false });
    await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'channel', channel: 'whatsapp', externalUserId: '32475464421' });
    await new Promise((r) => setImmediate(r));
    expect(emitWebhookEvent).not.toHaveBeenCalled();
  });

  it('an upsert DB error returns null (no throw) and logs', async () => {
    const ds = { query: vi.fn().mockRejectedValue(new Error('boom')), getRepository: () => ({ findOne: vi.fn() }) } as never;
    const res = await upsertLead({ dataSource: ds, tenantId: TENANT, source: 'channel', channel: 'whatsapp', externalUserId: '32475464421' });
    expect(res).toBeNull();
  });
});
