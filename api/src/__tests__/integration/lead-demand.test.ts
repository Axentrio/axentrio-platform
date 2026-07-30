/**
 * Lead demand aggregation (Story 3 Enterprise "AI Lead Intelligence").
 *
 * The dangerous failure here is not a wrong number — it is a CONFIDENT one. An SMB with
 * four leads must be told "not enough data", never shown "75% of your customers want X".
 * So the suppression floor and the published denominator get as much coverage as the
 * counting itself.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { Lead } from '../../database/entities/Lead';
import { Booking } from '../../database/entities/Booking';
import { ServiceType } from '../../database/entities/ServiceType';
import { LeadConversation } from '../../database/entities/LeadConversation';
import {
  aggregateLeadDemand,
  MIN_LEADS_FOR_DEMAND,
  MIN_DISTINCT_PER_LABEL,
} from '../../insights/lead-demand.service';
import { createTestTenant, createTestAnchorBot } from '../helpers/factories';
import type { Tenant } from '../../database/entities/Tenant';

const uniq = () => Math.random().toString(36).slice(2, 10);

async function seedLead(tenantId: string) {
  const repo = AppDataSource.getRepository(Lead);
  const s = uniq();
  return repo.save(
    repo.create({
      tenantId,
      email: `d${s}@example.com`,
      dedupeKey: `email:d${s}@example.com`,
      source: 'tool',
    }),
  );
}

async function seedService(tenantId: string, botId: string, name: string) {
  const repo = AppDataSource.getRepository(ServiceType);
  return repo.save(repo.create({ tenantId, botId, name, slug: `${name}-${uniq()}`.toLowerCase() }));
}

async function seedBooking(
  tenantId: string,
  botId: string,
  leadId: string,
  serviceId: string,
  status: Booking['status'] = 'confirmed',
) {
  const repo = AppDataSource.getRepository(Booking);
  return repo.save(
    repo.create({
      tenantId,
      botId,
      leadId,
      eventTypeId: serviceId,
      status,
      startUtc: new Date(),
      endUtc: new Date(Date.now() + 3600_000),
      calendarKey: 'cal',
      icsUid: `ics-${uniq()}`,
    }),
  );
}

async function setup(leadCount: number) {
  const tenant = await createTestTenant({ tier: 'enterprise' });
  const bot = await createTestAnchorBot(tenant as Tenant);
  const leads = [];
  for (let i = 0; i < leadCount; i++) leads.push(await seedLead(tenant.id));
  return { tenant, bot, leads };
}

describe('aggregateLeadDemand — refuses to speak without enough data', () => {
  it('suppresses below the floor and says why, rather than reporting shares', async () => {
    const { tenant } = await setup(MIN_LEADS_FOR_DEMAND - 1);
    const out = await aggregateLeadDemand(tenant.id, 30);

    expect(out.suppressed).toBe(true);
    expect(out.suppressionReason).toMatch(/not enough leads/i);
    expect(out.topServices).toEqual([]);
    // Crucially: no shares are computed at all, so nothing can be misread as a finding.
    expect(out.classifiedLeads).toBe(0);
  });

  it('does not name a service backed by fewer than the per-label floor', async () => {
    const { tenant, bot, leads } = await setup(6);
    const popular = await seedService(tenant.id, bot.id, 'Drain unblocking');
    const rare = await seedService(tenant.id, bot.id, 'Boiler replacement');
    for (let i = 0; i < MIN_DISTINCT_PER_LABEL; i++) {
      await seedBooking(tenant.id, bot.id, leads[i].id, popular.id);
    }
    // One customer wanting something is not demand.
    await seedBooking(tenant.id, bot.id, leads[5].id, rare.id);

    const out = await aggregateLeadDemand(tenant.id, 30);
    const labels = out.topServices.map((s) => s.label);
    expect(labels).toContain('Drain unblocking');
    expect(labels).not.toContain('Boiler replacement');
  });
});

describe('aggregateLeadDemand — publishes the denominator it is a share of', () => {
  it('reports shares of CLASSIFIED leads, and states both numbers', async () => {
    const { tenant, bot, leads } = await setup(10);
    const drain = await seedService(tenant.id, bot.id, 'Drain unblocking');
    // Only 4 of the 10 leads ever booked anything.
    for (let i = 0; i < 4; i++) await seedBooking(tenant.id, bot.id, leads[i].id, drain.id);

    const out = await aggregateLeadDemand(tenant.id, 30);
    expect(out.totalLeads).toBe(10);
    expect(out.classifiedLeads).toBe(4);
    // 4/4 of what we could classify — NOT 4/10. Both numbers are published so the
    // reader can see the share is of a subset.
    expect(out.topServices[0]).toMatchObject({ label: 'Drain unblocking', leads: 4, share: 1 });
  });

  it('counts a customer with several bookings for one service ONCE', async () => {
    // Otherwise one indecisive customer rebooking three times would dominate the
    // tenant's entire demand picture.
    const { tenant, bot, leads } = await setup(6);
    const drain = await seedService(tenant.id, bot.id, 'Drain unblocking');
    for (let i = 0; i < 3; i++) await seedBooking(tenant.id, bot.id, leads[0].id, drain.id);
    for (let i = 1; i < 3; i++) await seedBooking(tenant.id, bot.id, leads[i].id, drain.id);

    const out = await aggregateLeadDemand(tenant.id, 30);
    expect(out.topServices[0].leads).toBe(3); // 3 distinct leads, not 5 bookings
  });

  it('still counts a cancelled booking as demand — they asked for it', async () => {
    // Whether it converted is a different question; the outcomes timeseries answers that.
    const { tenant, bot, leads } = await setup(6);
    const drain = await seedService(tenant.id, bot.id, 'Drain unblocking');
    for (let i = 0; i < 3; i++) {
      await seedBooking(tenant.id, bot.id, leads[i].id, drain.id, 'cancelled');
    }
    const out = await aggregateLeadDemand(tenant.id, 30);
    expect(out.topServices[0]?.leads).toBe(3);
  });
});

describe('aggregateLeadDemand — inferred tags are kept separate from facts', () => {
  it('reports extracted tags with their OWN denominator', async () => {
    const { tenant, leads } = await setup(8);
    const convRepo = AppDataSource.getRepository(LeadConversation);
    // Only 3 of 8 leads have enrichment — the extractor abstains often and is default-OFF.
    for (let i = 0; i < 3; i++) {
      await convRepo.save(
        convRepo.create({
          tenantId: tenant.id,
          leadId: leads[i].id,
          tags: ['blocked drain'],
          enrichState: 'enriched',
        }),
      );
    }

    const out = await aggregateLeadDemand(tenant.id, 30);
    expect(out.taggedLeads).toBe(3);
    expect(out.topTags[0]).toMatchObject({ label: 'blocked drain', leads: 3, share: 1 });
    // The inferred view must not inflate the factual one.
    expect(out.classifiedLeads).toBe(0);
    expect(out.topServices).toEqual([]);
  });

  it('is empty — not wrong — when enrichment has never run', async () => {
    const { tenant, bot, leads } = await setup(6);
    const drain = await seedService(tenant.id, bot.id, 'Drain unblocking');
    for (let i = 0; i < 3; i++) await seedBooking(tenant.id, bot.id, leads[i].id, drain.id);

    const out = await aggregateLeadDemand(tenant.id, 30);
    // The factual half works with zero LLM involvement — that is the point.
    expect(out.topServices).toHaveLength(1);
    expect(out.topTags).toEqual([]);
    expect(out.taggedLeads).toBe(0);
  });

  it('classifies urgency, attributing everything unknown rather than dropping it', async () => {
    const { tenant, leads } = await setup(6);
    const convRepo = AppDataSource.getRepository(LeadConversation);
    await convRepo.save(
      convRepo.create({ tenantId: tenant.id, leadId: leads[0].id, urgency: 'emergency', enrichState: 'enriched' }),
    );
    const out = await aggregateLeadDemand(tenant.id, 30);
    expect(out.byUrgency.emergency).toBe(1);
    // The other five are unknown, not silently omitted — the counts must reconcile.
    expect(out.byUrgency.unknown).toBe(5);
    const sum = Object.values(out.byUrgency).reduce((a, b) => a + b, 0);
    expect(sum).toBe(out.totalLeads);
  });
});

describe('aggregateLeadDemand — scoping', () => {
  it('excludes erased leads', async () => {
    const { tenant, bot, leads } = await setup(6);
    const drain = await seedService(tenant.id, bot.id, 'Drain unblocking');
    for (let i = 0; i < 4; i++) await seedBooking(tenant.id, bot.id, leads[i].id, drain.id);
    await AppDataSource.query(`UPDATE chatbot_leads SET deleted_at = now() WHERE id = $1`, [leads[0].id]);

    const out = await aggregateLeadDemand(tenant.id, 30);
    expect(out.totalLeads).toBe(5);
    expect(out.topServices[0].leads).toBe(3);
  });

  it('is tenant-scoped', async () => {
    const a = await setup(6);
    const b = await setup(6);
    const svc = await seedService(a.tenant.id, a.bot.id, 'Drain unblocking');
    for (let i = 0; i < 3; i++) await seedBooking(a.tenant.id, a.bot.id, a.leads[i].id, svc.id);

    const out = await aggregateLeadDemand(b.tenant.id, 30);
    expect(out.topServices).toEqual([]);
  });
});

describe('enrichment health endpoint backing data', () => {
  it('reports null (not 0%) when nothing has been analysed', async () => {
    // "0% abstention" reads as a healthy system; the truth is we have no data. The
    // endpoint distinguishes them, because the whole point of this metric is to notice
    // a DROP in abstentions after a model change.
    const { tenant } = await setup(1);
    const { enrichmentAbstainStats } = await import('../../leads/enrichment/enrich-lead.job');
    const stats = await enrichmentAbstainStats(tenant.id, 7);
    expect(Number(stats.total)).toBe(0);
  });

  it('counts abstentions separately from enrichments', async () => {
    const { tenant, leads } = await setup(3);
    const convRepo = AppDataSource.getRepository(LeadConversation);
    await convRepo.save(
      convRepo.create({ tenantId: tenant.id, leadId: leads[0].id, enrichState: 'abstained' }),
    );
    await convRepo.save(
      convRepo.create({ tenantId: tenant.id, leadId: leads[1].id, enrichState: 'enriched', request: 'x' }),
    );
    // A pending row is neither — it has not run yet and must not dilute the rate.
    await convRepo.save(
      convRepo.create({ tenantId: tenant.id, leadId: leads[2].id, enrichState: 'pending' }),
    );

    const { enrichmentAbstainStats } = await import('../../leads/enrichment/enrich-lead.job');
    const stats = await enrichmentAbstainStats(tenant.id, 7);
    expect(Number(stats.total)).toBe(2);
    expect(Number(stats.abstained)).toBe(1);
  });
});
