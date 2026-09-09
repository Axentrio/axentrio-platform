/**
 * Compliance events — the proof trail with its own, much longer period than the
 * 90-day audit log. Integration, because the interesting part is the sweep's
 * WHERE clause against `created_at`.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import {
  logComplianceEvent,
  sweepComplianceEvents,
  COMPLIANCE_EVENT_RETENTION_DAYS,
} from '../../compliance/compliance-events.service';
import { createTestTenant } from '../helpers/factories';

async function seedEvent(tenantId: string | null, ageDays: number, eventType = 'leads.erased') {
  await logComplianceEvent({
    actorId: 'system',
    eventType,
    tenantId,
    subjectType: 'lead',
    subjectId: 'lead-1',
    details: { scrubbed: 3 },
  });
  if (ageDays > 0) {
    await AppDataSource.query(
      `UPDATE compliance_events SET created_at = now() - ($2 || ' days')::interval
        WHERE event_type = $1`,
      [eventType, String(ageDays)],
    );
  }
}

describe('compliance events', () => {
  it('records the tenant, the actor, the event and the counts', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await logComplianceEvent({
      actorId: 'user-42',
      eventType: 'conversations.retention_updated',
      tenantId: tenant.id,
      subjectType: 'tenant',
      subjectId: tenant.id,
      details: { retentionDays: 365 },
    });

    const [row] = await AppDataSource.query(
      `SELECT tenant_id, actor_id, event_type, subject_type, details
         FROM compliance_events WHERE tenant_id = $1`,
      [tenant.id],
    );
    expect(row.actor_id).toBe('user-42');
    expect(row.event_type).toBe('conversations.retention_updated');
    expect(row.subject_type).toBe('tenant');
    expect(row.details).toEqual({ retentionDays: 365 });
  });

  it('outlives the audit window — proof older than 90 days is still there', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await seedEvent(tenant.id, 200, 'old-proof');

    const rows = await AppDataSource.query(
      `SELECT id FROM compliance_events WHERE tenant_id = $1 AND event_type = 'old-proof'`,
      [tenant.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('sweeps only what is past ITS period, not the audit log period', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await seedEvent(tenant.id, COMPLIANCE_EVENT_RETENTION_DAYS + 10, 'expired-proof');
    await seedEvent(tenant.id, 200, 'live-proof');

    const result = await sweepComplianceEvents();

    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const kept = await AppDataSource.query(
      `SELECT event_type FROM compliance_events WHERE tenant_id = $1`,
      [tenant.id],
    );
    expect(kept.map((r: { event_type: string }) => r.event_type)).toEqual(['live-proof']);
  });

  it('never throws into the caller when the write fails', async () => {
    // The proof write sits next to an erasure: losing the row must not fail the
    // thing it is recording. A circular `details` value cannot be serialised to
    // jsonb, so it exercises the real failure path rather than a mocked one.
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      logComplianceEvent({ actorId: 'system', eventType: 'x', details: circular }),
    ).resolves.toBeUndefined();
  });
});
