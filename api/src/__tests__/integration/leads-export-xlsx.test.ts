/**
 * GET /leads/export?format=xlsx — the real spreadsheet alongside the Excel-safe CSV.
 *
 * The CSV path was already hardened for BE/NL/FR Excel (BOM + `sep=;` + `;` + a
 * formula-injection guard) and is covered in portal-contract-wire.test.ts. What is
 * worth pinning HERE is that adding a second serialisation did not quietly weaken the
 * route: `format` may only change bytes, never who may download, how much leaves, or
 * whether it is recorded.
 *
 * Auth-mocking + app-bootstrap pattern mirrors portal-contract-wire.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  userId: '',
  tenantId: '',
  agentId: '',
  role: 'admin' as string,
  email: 'test@example.com',
  clerkUserId: '',
  clerkOrgId: '',
}));

vi.mock('../../middleware/clerk.middleware', async () => {
  const { UnauthorizedError } = await import('../../middleware/error-handler');
  return {
    requireClerkAuth: (req: any, _res: any, next: any) => {
      if (!auth.userId) {
        return next(new UnauthorizedError('Clerk: Unauthorized - no userId in auth'));
      }
      req.userId = auth.userId;
      req.tenantId = auth.tenantId;
      req.agentId = auth.agentId;
      req.userRole = auth.role;
      req.user = {
        id: auth.userId,
        email: auth.email,
        role: auth.role,
        tenantId: auth.tenantId,
        clerkUserId: auth.clerkUserId,
        type: 'agent',
      };
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

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../websocket/socket.handler', () => ({
  emitToSession: vi.fn(),
  emitToTenantAgents: vi.fn(),
  emitToAgent: vi.fn(),
}));

vi.mock('../../utils/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import request from 'supertest';
import ExcelJS from 'exceljs';
import { app } from '../../server';
import { AppDataSource } from '../../database/data-source';
import { Lead } from '../../database/entities/Lead';
import { logAudit } from '../../utils/audit';
import { fromCsv } from '../../analytics/exporters';
import { createTestTenant, createTestUser } from '../helpers/factories';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The row cap the route pushes into SQL (`EXPORT_MAX_ROWS`). */
const EXPORT_MAX_ROWS = 10_000;

function setAuth(opts: { tenantId: string; userId: string }) {
  auth.userId = opts.userId;
  auth.tenantId = opts.tenantId;
}

async function seedProTenant() {
  const tenant = await createTestTenant({ tier: 'pro' });
  const admin = await createTestUser(tenant.id, { role: 'admin' });
  setAuth({ tenantId: tenant.id, userId: admin.id });
  return tenant;
}

async function seedLead(tenantId: string, over: Partial<Lead>) {
  const repo = AppDataSource.getRepository(Lead);
  return repo.save(repo.create({ tenantId, source: 'tool', channel: 'widget', ...over }));
}

/** `.responseType('blob')` is what makes superagent buffer the binary body. */
async function getXlsx(url: string) {
  const res = await request(app).get(url).responseType('blob');
  return res;
}

/** Read the downloaded bytes back the way a spreadsheet app would. */
async function readWorkbook(body: Buffer) {
  const workbook = new ExcelJS.Workbook();
  // exceljs declares load() over its own ArrayBuffer-shaped `Buffer`; it accepts the
  // Node Buffer superagent hands back at runtime.
  await workbook.xlsx.load(body as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  const table: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    table.push((row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(v))));
  });
  return { sheet, sheetName: sheet.name, headers: table[0] ?? [], rows: table.slice(1) };
}

describe('leads export — xlsx serialisation', () => {
  it('serves a real .xlsx: OOXML type, .xlsx filename, ZIP magic bytes', async () => {
    const tenant = await seedProTenant();
    await seedLead(tenant.id, { name: 'Ada', email: 'ada@x.io', dedupeKey: 'email:ada@x.io' });

    const res = await getXlsx('/api/v1/leads/export?format=xlsx');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(XLSX_MIME);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="leads_.*\.xlsx"/);
    // An .xlsx is a ZIP container. Asserting the magic bytes catches the failure mode
    // that a MIME-type assertion alone cannot: CSV text served under an xlsx label.
    expect(res.body.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('holds the SAME logical rows as the CSV export of the same data', async () => {
    const tenant = await seedProTenant();
    await seedLead(tenant.id, {
      name: 'Jérôme Peeters',
      email: 'jerome@x.io',
      phone: '+32 475 46 44 21',
      dedupeKey: 'email:jerome@x.io',
      notes: 'Leak; then flood',
    });
    await seedLead(tenant.id, {
      name: 'Anaïs Vandenbërghe',
      phone: '0475464421',
      dedupeKey: 'phone:0475464421',
      notes: 'Says "urgent"',
    });

    const csv = fromCsv((await request(app).get('/api/v1/leads/export')).text);
    const xlsx = await readWorkbook((await getXlsx('/api/v1/leads/export?format=xlsx')).body);

    // Clicking a different button must never hand the operator a different dataset.
    expect(xlsx.headers.map((h) => h.toLowerCase())).toEqual(csv.headers);
    expect(xlsx.rows).toEqual(csv.rows);
    expect(xlsx.rows).toHaveLength(2);
  });

  it('keeps é / ë / ï intact, with no BOM or import guesswork involved', async () => {
    const tenant = await seedProTenant();
    await seedLead(tenant.id, {
      name: 'Jérôme Vandenbërghe',
      email: 'j@x.io',
      dedupeKey: 'email:j@x.io',
      notes: 'naïef — riolering geblokkeerd',
    });

    const { rows } = await readWorkbook((await getXlsx('/api/v1/leads/export?format=xlsx')).body);
    expect(rows[0]).toContain('Jérôme Vandenbërghe');
    expect(rows[0]).toContain('naïef — riolering geblokkeerd');
  });

  it('writes a visitor-authored `=…` note as an inert text cell, not a formula', async () => {
    // `notes` is model-authored from visitor input, so it is the field an attacker
    // actually controls. In xlsx the guard is the cell TYPE — and unlike the CSV path
    // no apostrophe may be added, because nothing strips it back off on open.
    const tenant = await seedProTenant();
    const payload = '=HYPERLINK("http://evil","click me")';
    await seedLead(tenant.id, {
      name: 'Mallory',
      email: 'm@x.io',
      dedupeKey: 'email:m@x.io',
      notes: payload,
    });

    const { sheet, headers, rows } = await readWorkbook(
      (await getXlsx('/api/v1/leads/export?format=xlsx')).body,
    );
    const col = headers.indexOf('notes');
    expect(rows[0][col]).toBe(payload); // verbatim: no leading `'`
    const cell = sheet.getRow(2).getCell(col + 1);
    expect(cell.type).toBe(ExcelJS.ValueType.String);
    expect(cell.formula).toBeUndefined();
  });
});

describe('leads export — xlsx inherits every guarantee the CSV route makes', () => {
  it('applies the row cap and says so via X-Export-Truncated', async () => {
    const tenant = await seedProTenant();
    // Seeded in one statement: the point is the SQL LIMIT, and 10k round-trips through
    // the ORM would dominate the runtime of this file for no extra coverage.
    await AppDataSource.query(
      `INSERT INTO chatbot_leads (tenant_id, name, email, dedupe_key, source, channel)
       SELECT $1, 'Lead ' || g, 'l' || g || '@x.io', 'email:l' || g || '@x.io', 'tool', 'widget'
         FROM generate_series(1, $2) g`,
      [tenant.id, EXPORT_MAX_ROWS + 5],
    );

    const res = await getXlsx('/api/v1/leads/export?format=xlsx');
    expect(res.status).toBe(200);
    expect(res.headers['x-export-truncated']).toBe('true');
    expect(res.headers['x-export-row-limit']).toBe(String(EXPORT_MAX_ROWS));

    // The cap must bite in the FILE, not just in the header — a header that says
    // "truncated" over a complete dump would be as wrong as the reverse.
    const { rows } = await readWorkbook(res.body);
    expect(rows).toHaveLength(EXPORT_MAX_ROWS);
  });

  it('audits the xlsx download with the format that actually left', async () => {
    const tenant = await seedProTenant();
    await seedLead(tenant.id, { email: 'a@x.io', dedupeKey: 'email:a@x.io' });
    vi.mocked(logAudit).mockClear();

    expect((await getXlsx('/api/v1/leads/export?format=xlsx')).status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(
      expect.any(String),
      'leads.exported',
      'lead',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ format: 'xlsx', truncated: false, rowCount: 1 }),
    );
  });

  it('403s an `agent` seat — a second format is not a second door', async () => {
    const tenant = await seedProTenant(); // leaves auth.role = 'admin'
    try {
      const agent = await createTestUser(tenant.id, { role: 'agent' });
      setAuth({ tenantId: tenant.id, userId: agent.id });
      auth.role = 'agent'; // the DEFAULT auto-provision role
      expect((await request(app).get('/api/v1/leads/export?format=xlsx')).status).toBe(403);
    } finally {
      auth.role = 'admin'; // hoisted + shared across tests — must not leak
    }
  });

  it('402s a tenant without leadCapture', async () => {
    const tenant = await createTestTenant({ tier: 'free' });
    const admin = await createTestUser(tenant.id, { role: 'admin' });
    setAuth({ tenantId: tenant.id, userId: admin.id });
    expect((await request(app).get('/api/v1/leads/export?format=xlsx')).status).toBe(402);
  });
});

describe('leads export — format selection', () => {
  it('defaults to CSV, and an explicit format=csv is byte-identical to no format at all', async () => {
    const tenant = await seedProTenant();
    await seedLead(tenant.id, { name: 'Ada', email: 'ada@x.io', dedupeKey: 'email:ada@x.io' });

    const implicit = await request(app).get('/api/v1/leads/export');
    const explicit = await request(app).get('/api/v1/leads/export?format=csv');
    expect(implicit.headers['content-type']).toMatch(/text\/csv/);
    expect(explicit.headers['content-type']).toBe(implicit.headers['content-type']);
    expect(explicit.headers['content-disposition']).toBe(implicit.headers['content-disposition']);
    expect(explicit.text).toBe(implicit.text);
  });

  it('400s an unrecognised format instead of quietly handing back a CSV', async () => {
    await seedProTenant();
    expect((await request(app).get('/api/v1/leads/export?format=xls')).status).toBe(400);
    expect((await request(app).get('/api/v1/leads/export?format=pdf')).status).toBe(400);
  });
});
