/**
 * Analytics export registry (P3 / ADR-0014, D7) — CSV-first, Enterprise-gated.
 *
 * Each dataset is one registry entry: { filename(range), headers, rows() }.
 * Adding a dataset (or later an XLSX `format` branch) is a registry edit, not a
 * route change. Synchronous + in-memory — data is small at SMB scale.
 */
import { AppDataSource } from '../database/data-source';
import type { ExportDataset } from '../contracts/insights';

interface DateRange {
  from: Date;
  to: Date;
}

export interface Exporter {
  filename: (range: DateRange) => string;
  headers: string[];
  rows: (tenantId: string, range: DateRange) => Promise<string[][]>;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const str = (v: unknown): string => (v == null ? '' : String(v));

const exporters: Record<ExportDataset, Exporter> = {
  'outcomes-timeseries': {
    filename: (r) => `outcomes-timeseries_${day(r.from)}_${day(r.to)}.csv`,
    headers: ['date', 'conversations', 'bookings', 'leads'],
    rows: async (tenantId, { from, to }) => {
      const [conv, book, lead] = await Promise.all([
        AppDataSource.query(
          `SELECT DATE(created_at) AS d, COUNT(*)::int AS c FROM chat_sessions
           WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
           GROUP BY DATE(created_at)`, [tenantId, from, to]),
        AppDataSource.query(
          `SELECT DATE(created_at) AS d, COUNT(*)::int AS c FROM chatbot_bookings
           WHERE tenant_id = $1 AND status NOT IN ('cancelled','failed')
             AND created_at >= $2 AND created_at < $3
           GROUP BY DATE(created_at)`, [tenantId, from, to]),
        AppDataSource.query(
          `SELECT DATE(created_at) AS d, COUNT(*)::int AS c FROM chatbot_leads
           WHERE tenant_id = $1 AND deleted_at IS NULL
             AND created_at >= $2 AND created_at < $3
           GROUP BY DATE(created_at)`, [tenantId, from, to]),
      ]);
      const byDate = new Map<string, { conversations: number; bookings: number; leads: number }>();
      const ensure = (d: string) => {
        let row = byDate.get(d);
        if (!row) { row = { conversations: 0, bookings: 0, leads: 0 }; byDate.set(d, row); }
        return row;
      };
      for (const r of conv) ensure(day(new Date(r.d))).conversations = r.c;
      for (const r of book) ensure(day(new Date(r.d))).bookings = r.c;
      for (const r of lead) ensure(day(new Date(r.d))).leads = r.c;
      return [...byDate.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([d, v]) => [d, str(v.conversations), str(v.bookings), str(v.leads)]);
    },
  },

  gaps: {
    filename: (r) => `gaps_${day(r.from)}_${day(r.to)}.csv`,
    headers: ['topic', 'status', 'severity', 'occurrences', 'distinct_visitors', 'first_detected_at', 'last_seen_at', 'resolved_at'],
    rows: async (tenantId, { from, to }) => {
      const rows = await AppDataSource.query(
        `SELECT ct.topic, g.status, g.severity, g.occurrences, g.distinct_visitors AS dv,
                g.first_detected_at AS fda, g.last_seen_at AS lsa, g.resolved_at AS ra
         FROM chatbot_gaps g
         LEFT JOIN chatbot_canonical_topics ct ON ct.id = g.canonical_topic_id
         WHERE g.tenant_id = $1 AND g.last_seen_at >= $2 AND g.last_seen_at < $3
         ORDER BY g.last_seen_at DESC`, [tenantId, from, to]);
      return rows.map((r: Record<string, unknown>) => [
        str(r.topic), str(r.status), str(r.severity), str(r.occurrences), str(r.dv),
        str(r.fda), str(r.lsa), str(r.ra),
      ]);
    },
  },

  leads: {
    filename: (r) => `leads_${day(r.from)}_${day(r.to)}.csv`,
    headers: ['created_at', 'name', 'email', 'phone', 'channel', 'source', 'status', 'notes'],
    rows: async (tenantId, { from, to }) => {
      const rows = await AppDataSource.query(
        `SELECT created_at AS ca, name, email, phone, channel, source, status, notes
         FROM chatbot_leads
         WHERE tenant_id = $1 AND deleted_at IS NULL
           AND created_at >= $2 AND created_at < $3
         ORDER BY created_at DESC`, [tenantId, from, to]);
      return rows.map((r: Record<string, unknown>) => [
        str(r.ca), str(r.name), str(r.email), str(r.phone), str(r.channel), str(r.source), str(r.status), str(r.notes),
      ]);
    },
  },
};

export function getExporter(dataset: string): Exporter | null {
  return (exporters as Record<string, Exporter>)[dataset] ?? null;
}

export const EXPORT_DATASETS = Object.keys(exporters) as ExportDataset[];

/** RFC 4180 CSV: quote fields containing comma/quote/newline; double quotes.
 *  Also neutralize spreadsheet formula injection — a field whose first char is
 *  =, +, -, @, tab, or CR is executed as a formula by Excel/Sheets, and lead
 *  fields (notes, name) carry visitor/model-authored free text. Prefix such a
 *  value with a single quote so it imports as inert text. */
export function toCsv(headers: string[], rows: string[][]): string {
  const esc = (raw: string) => {
    const f = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\r\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f;
  };
  const lines = [headers, ...rows].map((row) => row.map(esc).join(','));
  return lines.join('\r\n');
}
