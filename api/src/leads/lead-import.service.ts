/**
 * Manual + CSV lead entry.
 *
 * `LeadSource` has carried `'manual'` and `'import'` since the table was created, with no
 * route behind either — a promise the schema made and the API did not keep. The two most
 * ordinary things an SMB wants to do with a lead list (type one in after a phone call,
 * paste in the list they already have) were the two it could not do.
 *
 * Both paths go through `upsertLead`, so they inherit dedup, the entitlement gate and the
 * notification/webhook fan-out rather than reimplementing them. `manual`/`import` are
 * already the highest source rank, so a later channel touch cannot downgrade them.
 *
 * The import is PREVIEW-THEN-COMMIT, never a blind write. The number people actually
 * care about is how many rows will MERGE onto an existing contact rather than create a
 * new one — a silent merge looks like data loss, and a silent duplicate looks like a bug.
 */
import type { DataSource } from 'typeorm';
import { fromCsv } from '../analytics/exporters';
import { isErasedDedupeKey } from './lead-tombstone';

/** Enough for a pasted SMB list; refuses a file that would tie up the request. */
export const MAX_IMPORT_ROWS = 2000;

export type ImportOutcome = 'create' | 'merge' | 'reject';

export interface ImportRow {
  line: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  outcome: ImportOutcome;
  /** Present when `outcome === 'reject'`, or when merging (which lead). */
  reason?: string;
  mergesIntoLeadId?: string;
}

export interface ImportPreview {
  totalRows: number;
  create: number;
  merge: number;
  reject: number;
  rows: ImportRow[];
  /** True when the file exceeded MAX_IMPORT_ROWS and was cut. */
  truncated: boolean;
}

/** Header aliases, so a tenant's own spreadsheet works without renaming columns. */
const FIELD_ALIASES: Record<string, readonly string[]> = {
  name: ['name', 'full name', 'fullname', 'customer', 'naam', 'nom', 'contact'],
  email: ['email', 'e-mail', 'email address', 'mail', 'e-mailadres', 'courriel'],
  phone: ['phone', 'telephone', 'tel', 'mobile', 'phone number', 'telefoon', 'gsm', 'téléphone'],
  notes: ['notes', 'note', 'request', 'message', 'comment', 'opmerking', 'aanvraag', 'demande'],
};

function resolveColumns(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const idx = headers.findIndex((h) => aliases.includes(h));
    if (idx >= 0) map[field] = idx;
  }
  return map;
}

const clean = (v: string | undefined): string | null => {
  const s = (v ?? '').trim();
  return s || null;
};

/** Mirrors `upsertLead`'s normalization so the preview's merge prediction is accurate. */
function previewDedupeKey(email: string | null, phone: string | null): string | null {
  const e = (email ?? '').trim().toLowerCase();
  if (e) return `email:${e}`;
  const p = (phone ?? '').replace(/[^0-9]/g, '');
  if (p) return `phone:${p}`;
  return null;
}

/**
 * Parse and classify, without writing anything.
 *
 * Rejection reasons are specific because "12 rows rejected" is not actionable — the
 * operator needs to know which line and why in order to fix their file.
 */
export async function previewLeadImport(
  dataSource: DataSource,
  tenantId: string,
  csv: string,
): Promise<ImportPreview> {
  const { headers, rows: raw } = fromCsv(csv);
  const cols = resolveColumns(headers);

  const truncated = raw.length > MAX_IMPORT_ROWS;
  const rows = truncated ? raw.slice(0, MAX_IMPORT_ROWS) : raw;

  // No recognisable contact column at all — fail the whole file rather than reporting
  // every row as an individual rejection.
  if (cols.email === undefined && cols.phone === undefined) {
    throw new Error('The file needs an email or phone column.');
  }

  const parsed: ImportRow[] = rows.map((r, i) => ({
    line: i + 2, // 1-based, +1 for the header row — matches what the operator sees
    name: cols.name !== undefined ? clean(r[cols.name]) : null,
    email: cols.email !== undefined ? clean(r[cols.email]) : null,
    phone: cols.phone !== undefined ? clean(r[cols.phone]) : null,
    notes: cols.notes !== undefined ? clean(r[cols.notes]) : null,
    outcome: 'create',
  }));

  // Resolve every key in ONE query rather than per row.
  const keys = new Map<string, string>(); // dedupeKey → first line using it
  for (const row of parsed) {
    const key = previewDedupeKey(row.email, row.phone);
    if (key && !keys.has(key)) keys.set(key, String(row.line));
  }
  const existing = new Map<string, string>(); // dedupeKey → leadId
  if (keys.size > 0) {
    const found: Array<{ dedupe_key: string; id: string }> = await dataSource.query(
      `SELECT dedupe_key, id FROM chatbot_leads
        WHERE tenant_id = $1 AND deleted_at IS NULL AND dedupe_key = ANY($2::text[])`,
      [tenantId, [...keys.keys()]],
    );
    for (const f of found) existing.set(f.dedupe_key, f.id);
  }

  const seenInFile = new Set<string>();
  for (const row of parsed) {
    const key = previewDedupeKey(row.email, row.phone);

    if (!key) {
      row.outcome = 'reject';
      row.reason = 'No email or phone';
      continue;
    }
    // Retention and erasure erase people on request. An import must never be able to
    // resurrect them — silently undoing an erasure would make both features a lie.
    if (isErasedDedupeKey(key) || isErasedDedupeKey(row.email) || isErasedDedupeKey(row.phone)) {
      row.outcome = 'reject';
      row.reason = 'Reserved identifier';
      continue;
    }
    if (row.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) {
      row.outcome = 'reject';
      row.reason = 'Invalid email';
      continue;
    }
    if (seenInFile.has(key)) {
      // Two rows for the same person inside one file. Not an error — the second would
      // merge onto the first — but the operator should know the count will not match
      // their row count.
      row.outcome = 'merge';
      row.reason = 'Duplicate within this file';
      continue;
    }
    seenInFile.add(key);

    const hit = existing.get(key);
    if (hit) {
      row.outcome = 'merge';
      row.mergesIntoLeadId = hit;
      row.reason = 'Already in your leads';
    }
  }

  return {
    totalRows: parsed.length,
    create: parsed.filter((r) => r.outcome === 'create').length,
    merge: parsed.filter((r) => r.outcome === 'merge').length,
    reject: parsed.filter((r) => r.outcome === 'reject').length,
    rows: parsed,
    truncated,
  };
}
