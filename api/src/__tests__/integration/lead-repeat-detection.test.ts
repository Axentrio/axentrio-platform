/**
 * Repeat-customer detection against the real DB.
 *
 * Integration rather than unit because everything that can go wrong here is SQL: the
 * grouping is a GROUP BY inside a tenant predicate, the idempotence comes from an
 * `IS DISTINCT FROM` guard, and the GDPR property is two independent WHERE clauses.
 * A mocked query builder would assert the shape of the strings, not the behaviour.
 *
 * Weighted, like the erasure suite, towards what the pass must REFUSE to do: merging
 * two customers is unrecoverable, missing a repeat is a badge that does not appear.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/notification.service', () => ({
  notificationService: { createForTenant: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../webhooks/webhook.emitter', async () => {
  const actual = await vi.importActual<typeof import('../../webhooks/webhook.emitter')>(
    '../../webhooks/webhook.emitter',
  );
  return { ...actual, emitWebhookEvent: vi.fn() };
});

import { AppDataSource } from '../../database/data-source';
import { Lead } from '../../database/entities/Lead';
import { LeadConversation } from '../../database/entities/LeadConversation';
import { sweepRepeatCustomers, sweepTenant } from '../../leads/repeat-detection.service';
import { eraseLead } from '../../leads/lead-erasure.service';
import { createTestTenant, createTestSession } from '../helpers/factories';

const uniq = () => Math.random().toString(36).slice(2, 10);

/** A lead row plus, optionally, the conversations that lead had. */
async function seedLead(
  tenantId: string,
  over: Partial<Lead>,
  conversations = 1,
): Promise<Lead> {
  const repo = AppDataSource.getRepository(Lead);
  const lead = await repo.save(
    repo.create({
      tenantId,
      name: 'Achraf Peeters',
      dedupeKey: `seed:${uniq()}`,
      source: 'channel',
      ...over,
    }),
  );
  const convRepo = AppDataSource.getRepository(LeadConversation);
  for (let i = 0; i < conversations; i += 1) {
    const session = await createTestSession(tenantId);
    await convRepo.save(
      convRepo.create({
        tenantId,
        leadId: lead.id,
        sessionId: session.id,
        channel: (over.channel as string | undefined) ?? 'widget',
        source: 'link',
      }),
    );
  }
  return lead;
}

async function readPerson(leadId: string) {
  const [row] = await AppDataSource.query(
    `SELECT person_key, person_lead_count, person_conversation_count,
            person_first_seen_at, person_last_seen_at, updated_at
       FROM chatbot_leads WHERE id = $1`,
    [leadId],
  );
  return row as {
    person_key: string | null;
    person_lead_count: number | null;
    person_conversation_count: number | null;
    person_first_seen_at: Date | null;
    person_last_seen_at: Date | null;
    updated_at: Date;
  };
}

describe('sweepRepeatCustomers — one human, two identity rows', () => {
  it('groups the same phone in two channel forms as one person', async () => {
    // The exact failure the feature exists for: a WhatsApp contact (`whatsapp:32475…`)
    // who later types their number into the widget (`phone:32475…`) is TWO rows, and
    // no per-row counter can ever see the repeat.
    const tenant = await createTestTenant({ tier: 'pro' });
    const whatsapp = await seedLead(tenant.id, {
      channel: 'whatsapp',
      externalUserId: '32475464421',
      phone: '32475464421',
      dedupeKey: 'whatsapp:32475464421',
    });
    const widget = await seedLead(tenant.id, {
      channel: 'widget',
      phone: '+32 475 46 44 21',
      dedupeKey: 'phone:32475464421',
      source: 'tool',
    });

    await sweepRepeatCustomers();

    const a = await readPerson(whatsapp.id);
    const b = await readPerson(widget.id);
    expect(a.person_key).toBe('phone:+32475464421');
    expect(b.person_key).toBe(a.person_key);
    // Both rows carry the PERSON's answer, so the list needs no join to render it.
    expect(a.person_lead_count).toBe(2);
    expect(b.person_lead_count).toBe(2);
    expect(a.person_conversation_count).toBe(2);
    expect(b.person_conversation_count).toBe(2);
    expect(a.person_first_seen_at).not.toBeNull();
    expect(a.person_last_seen_at).not.toBeNull();
  });

  it('groups on email when the phone is unusable, and records first/last seen', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const first = await seedLead(tenant.id, {
      email: 'Achraf@Example.com',
      dedupeKey: `email:achraf-${uniq()}@example.com`,
    });
    // Backdate so first_seen and last_seen are provably different values, not the
    // same timestamp passing by accident.
    await AppDataSource.query(
      `UPDATE chatbot_leads SET created_at = now() - interval '90 days' WHERE id = $1`,
      [first.id],
    );
    const second = await seedLead(tenant.id, {
      email: 'achraf@example.com ',
      phone: '0475464421', // national format — unusable, so email decides
      dedupeKey: `phone:0475464421-${uniq()}`,
    });

    await sweepRepeatCustomers();

    const a = await readPerson(first.id);
    const b = await readPerson(second.id);
    expect(a.person_key).toBe('email:achraf@example.com');
    expect(b.person_key).toBe(a.person_key);
    expect(a.person_conversation_count).toBe(2);
    expect(new Date(a.person_first_seen_at!).getTime()).toBeLessThan(
      new Date(a.person_last_seen_at!).getTime(),
    );
  });

  it('leaves a lead with no usable identifier ungrouped rather than guessing', async () => {
    // A Messenger PSID is a durable handle but it is not a phone or an email, so
    // there is nothing to match on. Ungrouped is the honest answer.
    const tenant = await createTestTenant({ tier: 'pro' });
    const lead = await seedLead(tenant.id, {
      channel: 'messenger',
      externalUserId: `psid-${uniq()}`,
      dedupeKey: `messenger:psid-${uniq()}`,
    });

    await sweepRepeatCustomers();

    const row = await readPerson(lead.id);
    expect(row.person_key).toBeNull();
    expect(row.person_conversation_count).toBeNull();
  });
});

describe('sweepRepeatCustomers — what it must never merge', () => {
  it('never merges two different people, including two who share a name', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const one = await seedLead(tenant.id, {
      name: 'Jan Peeters',
      phone: '32475464421',
      email: 'jan@a.com',
      dedupeKey: `phone:32475464421-${uniq()}`,
    });
    const two = await seedLead(tenant.id, {
      name: 'Jan Peeters',
      phone: '32499111222',
      email: 'jan@b.com',
      dedupeKey: `phone:32499111222-${uniq()}`,
    });

    await sweepRepeatCustomers();

    const a = await readPerson(one.id);
    const b = await readPerson(two.id);
    expect(a.person_key).not.toBe(b.person_key);
    expect(a.person_lead_count).toBe(1);
    expect(b.person_lead_count).toBe(1);
    expect(a.person_conversation_count).toBe(1);
  });

  it('does not chain two people together through a shared identifier', async () => {
    // A shares a phone with B; B shares an email with C. Transitive resolution would
    // make A, B and C one person and show A the history of C, who they have never
    // met. Only the direct, precedence-chosen key counts.
    const tenant = await createTestTenant({ tier: 'pro' });
    const a = await seedLead(tenant.id, { phone: '32475464421', dedupeKey: `a-${uniq()}` });
    const b = await seedLead(tenant.id, {
      phone: '32475464421',
      email: 'household@example.com',
      dedupeKey: `b-${uniq()}`,
    });
    const c = await seedLead(tenant.id, {
      email: 'household@example.com',
      dedupeKey: `c-${uniq()}`,
    });

    await sweepRepeatCustomers();

    const ra = await readPerson(a.id);
    const rb = await readPerson(b.id);
    const rc = await readPerson(c.id);
    // A and B group on the shared phone (B prefers phone over email)…
    expect(ra.person_key).toBe('phone:+32475464421');
    expect(rb.person_key).toBe('phone:+32475464421');
    // …and C stays on their own, even though B also holds C's email.
    expect(rc.person_key).toBe('email:household@example.com');
    expect(rc.person_lead_count).toBe(1);
  });

  it('never crosses a tenant boundary', async () => {
    // Two tenants can legitimately both serve the same person; showing one tenant the
    // other's conversation history would be a cross-workspace data leak.
    const alpha = await createTestTenant({ tier: 'pro' });
    const beta = await createTestTenant({ tier: 'pro' });
    const inAlpha = await seedLead(alpha.id, { phone: '32475464421', dedupeKey: `a-${uniq()}` });
    const inBeta = await seedLead(beta.id, { phone: '32475464421', dedupeKey: `b-${uniq()}` });

    await sweepRepeatCustomers();

    const a = await readPerson(inAlpha.id);
    const b = await readPerson(inBeta.id);
    // Same key value — it is a pure function of the phone — but the COUNTS are what
    // the portal renders, and they are computed per tenant.
    expect(a.person_key).toBe(b.person_key);
    expect(a.person_lead_count).toBe(1);
    expect(b.person_lead_count).toBe(1);
    expect(a.person_conversation_count).toBe(1);
    expect(b.person_conversation_count).toBe(1);
  });
});

describe('sweepRepeatCustomers — erasure', () => {
  it('makes an erased lead invisible and drops it out of the survivor’s counts', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const older = await seedLead(tenant.id, {
      phone: '32475464421',
      email: 'achraf@example.com',
      dedupeKey: `whatsapp:32475464421-${uniq()}`,
    });
    const newer = await seedLead(tenant.id, {
      phone: '32475464421',
      dedupeKey: `phone:32475464421-${uniq()}`,
    });

    await sweepRepeatCustomers();
    expect((await readPerson(newer.id)).person_conversation_count).toBe(2);

    await eraseLead(AppDataSource, tenant.id, older.id);

    // Erasure itself must clear the husk's derived identifier — `person_key` is a
    // normalised copy of the phone that was just nulled.
    const erased = await readPerson(older.id);
    expect(erased.person_key).toBeNull();
    expect(erased.person_lead_count).toBeNull();
    expect(erased.person_conversation_count).toBeNull();

    // And the next pass must not resurrect it: the tombstone is excluded, so the
    // survivor's counts fall back to their own conversation only.
    await sweepRepeatCustomers();
    const survivor = await readPerson(newer.id);
    expect(survivor.person_lead_count).toBe(1);
    expect(survivor.person_conversation_count).toBe(1);
    expect((await readPerson(older.id)).person_key).toBeNull();
  });

  it('ignores a tombstoned row even if its deleted_at were somehow cleared', async () => {
    // Two independent conditions guard erasure. This asserts the second one on its
    // own, so a future edit cannot quietly reduce them to one.
    const tenant = await createTestTenant({ tier: 'pro' });
    const lead = await seedLead(tenant.id, {
      phone: '32475464421',
      dedupeKey: `whatsapp:32475464421-${uniq()}`,
    });
    await eraseLead(AppDataSource, tenant.id, lead.id);
    await AppDataSource.query(
      `UPDATE chatbot_leads SET deleted_at = NULL, phone = '32475464421' WHERE id = $1`,
      [lead.id],
    );

    await sweepRepeatCustomers();

    expect((await readPerson(lead.id)).person_key).toBeNull();
  });
});

describe('sweepRepeatCustomers — cost and repeatability', () => {
  it('is idempotent: a second run writes nothing', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const lead = await seedLead(tenant.id, {
      phone: '32475464421',
      dedupeKey: `phone:32475464421-${uniq()}`,
    });

    const first = await sweepTenant(tenant.id);
    expect(first.keysWritten).toBe(1);
    expect(first.aggregatesWritten).toBe(1);
    const after = await readPerson(lead.id);

    const second = await sweepTenant(tenant.id);
    // Zero writes, not "the same values written again" — the guard is what keeps a
    // nightly pass off the WAL of a table read on every page of the leads inbox.
    expect(second.keysWritten).toBe(0);
    expect(second.aggregatesWritten).toBe(0);

    const again = await readPerson(lead.id);
    expect(again.person_conversation_count).toBe(after.person_conversation_count);
    expect(again.person_lead_count).toBe(after.person_lead_count);
    // `updated_at` is the operator-visible "last touched"; a background recompute is
    // not a touch, and bumping it would make every lead look edited.
    expect(again.updated_at.getTime()).toBe(after.updated_at.getTime());
  });

  it('skips a tenant that is not entitled', async () => {
    // Essential has leadCapture but not leadEnrichment — the flag that gates every
    // derived lead field on the read path. Computing a value nobody can read is waste.
    const tenant = await createTestTenant({ tier: 'essential' });
    const lead = await seedLead(tenant.id, {
      phone: '32475464421',
      dedupeKey: `phone:32475464421-${uniq()}`,
    });

    await sweepRepeatCustomers();

    expect((await readPerson(lead.id)).person_key).toBeNull();
  });

  it('clears cached counts from a row that lost its key', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const lead = await seedLead(tenant.id, {
      phone: '32475464421',
      dedupeKey: `phone:32475464421-${uniq()}`,
    });
    await sweepTenant(tenant.id);
    expect((await readPerson(lead.id)).person_lead_count).toBe(1);

    // The number turns out to be unusable (corrected to a national-format value).
    await AppDataSource.query(`UPDATE chatbot_leads SET phone = '0475464421' WHERE id = $1`, [
      lead.id,
    ]);
    await sweepTenant(tenant.id);

    const row = await readPerson(lead.id);
    expect(row.person_key).toBeNull();
    // Stale counts must not survive: they would keep describing a group this row is
    // no longer in.
    expect(row.person_lead_count).toBeNull();
    expect(row.person_conversation_count).toBeNull();
    expect(row.person_first_seen_at).toBeNull();
  });
});

/**
 * Erasure residue. Every case here is a defect that shipped and was reachable in
 * production, not a hypothetical: the sweep's writes carried the erasure predicates on
 * the SELECT that chose the rows but not on the UPDATE that wrote them, and erasure
 * cleaned the husk without invalidating the group the husk belonged to.
 */
describe('erasure leaves no person residue', () => {
  it('strips a person_key that reached a tombstone by any route', async () => {
    // The original defect was a race: a lead erased between the sweep's SELECT and its
    // UPDATE had its key written back onto the husk, and nothing ever removed it —
    // person_key is a normalised copy of a phone number, so that is plaintext personal
    // data restored onto a row whose entire purpose is holding none. Simulated here by
    // writing the residue directly, which also covers any other route to that state.
    const tenant = await createTestTenant({ tier: 'pro' });
    const lead = await seedLead(tenant.id, { phone: '32475464421', email: null });
    await eraseLead(AppDataSource, tenant.id, lead.id);
    await AppDataSource.query(
      `UPDATE chatbot_leads SET person_key = 'phone:+32475464421' WHERE id = $1`,
      [lead.id],
    );

    await sweepTenant(tenant.id);

    const after = await readPerson(lead.id);
    expect(after.person_key).toBeNull();
    expect(after.person_lead_count).toBeNull();
  });

  it('never counts a tombstoned row into a living person, even carrying a key', async () => {
    // The aggregate relied on person_key being NULL on a husk, which left its tombstone
    // predicate untested — and untrue the moment a key survived on one.
    const tenant = await createTestTenant({ tier: 'pro' });
    const live = await seedLead(tenant.id, { phone: '32475464421', email: null });
    const doomed = await seedLead(tenant.id, { phone: '32475464421', email: null });
    await eraseLead(AppDataSource, tenant.id, doomed.id);
    await AppDataSource.query(
      `UPDATE chatbot_leads SET person_key = 'phone:+32475464421' WHERE id = $1`,
      [doomed.id],
    );

    await sweepTenant(tenant.id);

    const survivor = await readPerson(live.id);
    expect(survivor.person_lead_count).toBe(1); // the erased row must not be in the group
  });

  it('invalidates the survivor immediately, not at the next nightly sweep', async () => {
    // person_first_seen_at can be a timestamp derived exclusively from the erased
    // record. Leaving the group's cached answer until the next sweep keeps reporting
    // the erased person — on the wire and on screen — for up to a day after they asked
    // to be forgotten. Deliberately asserts BEFORE any second sweep.
    const tenant = await createTestTenant({ tier: 'pro' });
    const first = await seedLead(tenant.id, { phone: '32475464421', email: null });
    const second = await seedLead(tenant.id, { phone: '32475464421', email: null });
    await sweepTenant(tenant.id);
    expect((await readPerson(second.id)).person_lead_count).toBe(2);

    await eraseLead(AppDataSource, tenant.id, first.id);

    const survivor = await readPerson(second.id);
    expect(survivor.person_lead_count).toBeNull();
    expect(survivor.person_conversation_count).toBeNull();
    expect(survivor.person_first_seen_at).toBeNull();
    expect(survivor.person_last_seen_at).toBeNull();
  });
});
