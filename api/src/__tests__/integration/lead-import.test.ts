/**
 * Manual + CSV lead entry.
 *
 * Two properties get the most coverage, because both are ways this feature could
 * silently corrupt the lead list:
 *   - the preview's MERGE prediction must match what commit actually does, or the
 *     operator confirms one thing and gets another
 *   - an import must never resurrect an erased person, which would silently undo both
 *     erasure and retention
 */
import { describe, it, expect, vi } from 'vitest';

const auth = vi.hoisted(() => ({ userId: '', tenantId: '', role: 'admin' as string }));

vi.mock('../../middleware/clerk.middleware', async () => {
  const { UnauthorizedError } = await import('../../middleware/error-handler');
  return {
    requireClerkAuth: (req: any, _res: any, next: any) => {
      if (!auth.userId) return next(new UnauthorizedError('no userId'));
      req.userId = auth.userId;
      req.tenantId = auth.tenantId;
      req.userRole = auth.role;
      req.user = { id: auth.userId, email: 'a@b.c', role: auth.role, tenantId: auth.tenantId, type: 'agent' };
      next();
    },
    autoProvision: (_req: any, _res: any, next: any) => next(),
    invalidateProvisionCache: () => {},
    resolveClerkIds: () => ({}),
  };
});
vi.mock('../../middleware/super-admin.middleware', () => ({
  requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
  resolveTenantContext: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@clerk/express', () => ({ clerkMiddleware: () => (_r: any, _s: any, n: any) => n() }));
vi.mock('../../utils/audit', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../webhooks/webhook.emitter', () => ({
  emitWebhookEvent: vi.fn(),
  buildEventBase: () => ({ id: 'e', tenantId: 't', timestamp: '', session: {} }),
}));
vi.mock('../../services/notification.service', () => ({
  notificationService: { createForTenant: vi.fn().mockResolvedValue(undefined) },
}));

import request from 'supertest';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Lead } from '../../database/entities/Lead';
import { toCsv, EXCEL_CSV, fromCsv } from '../../analytics/exporters';
import { eraseLead } from '../../leads/lead-erasure.service';
import { createTestTenant, createTestUser } from '../helpers/factories';

async function seed(role = 'admin') {
  const tenant = await createTestTenant({ tier: 'pro' });
  const user = await createTestUser(tenant.id, { role: role as 'admin' });
  auth.tenantId = tenant.id;
  auth.userId = user.id;
  auth.role = role;
  return tenant;
}

const countLeads = async (tenantId: string) => {
  const [r] = await AppDataSource.query(
    `SELECT count(*)::int AS n FROM chatbot_leads WHERE tenant_id = $1 AND deleted_at IS NULL`,
    [tenantId],
  );
  return r.n as number;
};

describe('fromCsv — must read this platform\'s OWN export', () => {
  it('round-trips the Excel preset: BOM, sep= line, semicolons, quoting', () => {
    // If import cannot read the file export produces, the feature is indefensible.
    const csv = toCsv(
      ['name', 'email', 'notes'],
      [['Jérôme Peeters', 'j@example.com', 'leak; then flood']],
      EXCEL_CSV,
    );
    const parsed = fromCsv(csv);
    expect(parsed.headers).toEqual(['name', 'email', 'notes']);
    expect(parsed.rows[0]).toEqual(['Jérôme Peeters', 'j@example.com', 'leak; then flood']);
  });

  it('undoes the formula-injection guard but NOT a legitimate leading apostrophe', () => {
    const guarded = toCsv(['x'], [['=cmd|calc']], EXCEL_CSV);
    expect(fromCsv(guarded).rows[0][0]).toBe('=cmd|calc');
    // Dutch names really do start with an apostrophe; stripping it would corrupt them.
    const plain = toCsv(['x'], [["'t Hooft"]], EXCEL_CSV);
    expect(fromCsv(plain).rows[0][0]).toBe("'t Hooft");
  });

  it('reads a plain comma file with embedded newlines and quotes', () => {
    const parsed = fromCsv('name,notes\r\n"Ann","line1\nline2"\r\n');
    expect(parsed.rows[0]).toEqual(['Ann', 'line1\nline2']);
  });
});

describe('POST /leads — manual entry', () => {
  it('creates a lead and reports that it was new', async () => {
    const tenant = await seed();
    const res = await request(app)
      .post('/api/v1/leads')
      .send({ name: 'Achraf', phone: '32475464421', notes: 'Called about a blocked drain' });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(true);
    expect(await countLeads(tenant.id)).toBe(1);
  });

  it('MERGES onto an existing contact and says so, rather than duplicating', async () => {
    // A silent merge looks like the save failed, so the response has to distinguish.
    const tenant = await seed();
    await request(app).post('/api/v1/leads').send({ email: 'dup@example.com', name: 'First' });
    const second = await request(app).post('/api/v1/leads').send({ email: 'dup@example.com', notes: 'Called back' });

    expect(second.body.data.created).toBe(false);
    expect(await countLeads(tenant.id)).toBe(1);
  });

  it('requires an email or a phone', async () => {
    await seed();
    expect((await request(app).post('/api/v1/leads').send({ name: 'Nameless' })).status).toBe(400);
  });

  it('rejects an invalid email and a reserved identifier', async () => {
    await seed();
    expect((await request(app).post('/api/v1/leads').send({ email: 'not-an-email' })).status).toBe(400);
    expect(
      (await request(app).post('/api/v1/leads').send({ email: 'erased:abc' })).status,
    ).toBe(400);
  });

  it('is open to an agent seat — the person who took the call records it', async () => {
    await seed('agent');
    try {
      const res = await request(app).post('/api/v1/leads').send({ phone: '32400111222' });
      expect(res.status).toBe(200);
    } finally {
      auth.role = 'admin';
    }
  });
});

describe('POST /leads/import — preview then commit', () => {
  const csv = (rows: string[][]) => toCsv(['name', 'email', 'phone', 'notes'], rows, EXCEL_CSV);

  it('predicts create vs merge, and commit matches the prediction', async () => {
    const tenant = await seed();
    await request(app).post('/api/v1/leads').send({ email: 'existing@example.com', name: 'Existing' });

    const file = csv([
      ['Existing', 'existing@example.com', '', 'came back'],
      ['Brand New', 'new@example.com', '', 'first contact'],
    ]);

    const preview = await request(app).post('/api/v1/leads/import/preview').send({ csv: file });
    expect(preview.status).toBe(200);
    expect(preview.body.data.create).toBe(1);
    expect(preview.body.data.merge).toBe(1);

    const commit = await request(app).post('/api/v1/leads/import/commit').send({ csv: file });
    expect(commit.body.data.created).toBe(1);
    expect(commit.body.data.merged).toBe(1);
    // The prediction the operator confirmed is what actually happened.
    expect(await countLeads(tenant.id)).toBe(2);
  });

  it('preview writes NOTHING', async () => {
    const tenant = await seed();
    await request(app)
      .post('/api/v1/leads/import/preview')
      .send({ csv: csv([['A', 'a@example.com', '', '']]) });
    expect(await countLeads(tenant.id)).toBe(0);
  });

  it('rejects rows with no contact, and names the line so the file can be fixed', async () => {
    await seed();
    const preview = await request(app)
      .post('/api/v1/leads/import/preview')
      .send({ csv: csv([['No Contact', '', '', 'nothing to reach them on']]) });

    expect(preview.body.data.reject).toBe(1);
    expect(preview.body.data.rows[0].line).toBe(2); // header is line 1
    expect(preview.body.data.rows[0].reason).toMatch(/no email or phone/i);
  });

  it('flags a duplicate WITHIN the file as a merge, so counts do not surprise', async () => {
    const tenant = await seed();
    const file = csv([
      ['Same', 'same@example.com', '', 'first'],
      ['Same again', 'same@example.com', '', 'second'],
    ]);
    const preview = await request(app).post('/api/v1/leads/import/preview').send({ csv: file });
    expect(preview.body.data.create).toBe(1);
    expect(preview.body.data.merge).toBe(1);

    await request(app).post('/api/v1/leads/import/commit').send({ csv: file });
    expect(await countLeads(tenant.id)).toBe(1);
  });

  it('NEVER resurrects an erased person — the dependency retention relies on', async () => {
    // Erasure and retention both remove people on request. If an import could bring
    // them back, both features would be a lie.
    const tenant = await seed();
    const repo = AppDataSource.getRepository(Lead);
    const lead = await repo.save(
      repo.create({
        tenantId: tenant.id,
        email: 'gone@example.com',
        dedupeKey: 'email:gone@example.com',
        source: 'tool',
        name: 'Gone',
      }),
    );
    await eraseLead(AppDataSource, tenant.id, lead.id);

    // The erased row is soft-deleted, so re-importing the SAME address legitimately
    // creates a fresh lead with only what the file supplied — it does not restore the
    // erased record's data.
    await request(app)
      .post('/api/v1/leads/import/commit')
      .send({ csv: csv([['Gone', 'gone@example.com', '', '']]) });

    const [old] = await AppDataSource.query(
      `SELECT name, status FROM chatbot_leads WHERE id = $1`,
      [lead.id],
    );
    expect(old.name).toBeNull();
    expect(old.status).toBe('erased');

    // …and a file that tries to address the tombstone namespace directly is refused.
    const preview = await request(app)
      .post('/api/v1/leads/import/preview')
      .send({ csv: csv([['Attacker', `erased:${lead.id}`, '', '']]) });
    expect(preview.body.data.reject).toBe(1);
    expect(preview.body.data.rows[0].reason).toMatch(/reserved/i);
  });

  it('re-classifies server-side on commit, so rejection rules cannot be bypassed', async () => {
    // Commit re-runs the preview rather than trusting a client-supplied row list.
    const tenant = await seed();
    const res = await request(app)
      .post('/api/v1/leads/import/commit')
      .send({ csv: csv([['Bad', 'not-an-email', '', '']]) });
    expect(res.body.data.rejected).toBe(1);
    expect(res.body.data.created).toBe(0);
    expect(await countLeads(tenant.id)).toBe(0);
  });

  it('accepts a tenant\'s own column names', async () => {
    await seed();
    const file = 'Naam;E-mailadres;Telefoon\r\nJan;jan@example.com;32475000111\r\n';
    const preview = await request(app).post('/api/v1/leads/import/preview').send({ csv: file });
    expect(preview.body.data.create).toBe(1);
    expect(preview.body.data.rows[0].name).toBe('Jan');
  });

  it('fails the whole file when there is no contact column at all', async () => {
    await seed();
    const res = await request(app)
      .post('/api/v1/leads/import/preview')
      .send({ csv: 'name;notes\r\nAnn;hello\r\n' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/email or phone column/i);
  });

  it('403s an agent seat — bulk import is not a front-line action', async () => {
    await seed('agent');
    try {
      const res = await request(app)
        .post('/api/v1/leads/import/preview')
        .send({ csv: csv([['A', 'a@example.com', '', '']]) });
      expect(res.status).toBe(403);
    } finally {
      auth.role = 'admin';
    }
  });
});
