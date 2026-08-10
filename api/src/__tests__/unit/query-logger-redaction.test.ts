/**
 * A failed query must not put the customer in the logs.
 *
 * TypeORM's `advanced-console` logger prints the whole statement AND its bound parameters on
 * error. Every value a customer ever typed is a bound parameter: a failed booking insert writes
 * their name, email, phone and home address to production logs, where they are retained, shipped
 * to a log drain, and readable by anyone with access.
 *
 * Found by sending a booking id of `../../etc/passwd` and watching production echo it back inside
 * a 2,000-character SELECT. The injection went nowhere — Postgres rejected the uuid cast — but
 * the log line was the finding.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RedactingQueryLogger } from '../../database/query-logger';
import { logger } from '../../utils/logger';

const REAL_CUSTOMER = ['Jane Doe', 'jane@example.com', '+32470000000', 'Grote Markt 1, Antwerpen'];
const INSERT =
  'INSERT INTO "chatbot_bookings" ("attendee_name", "attendee_email", "customer_phone", "customer_address") VALUES ($1, $2, $3, $4)';

describe('a failed query in the logs', () => {
  const captured: Array<{ level: string; meta: Record<string, unknown> }> = [];

  beforeEach(() => {
    captured.length = 0;
    for (const level of ['error', 'warn', 'info'] as const) {
      vi.spyOn(logger, level).mockImplementation(((_msg: string, meta: Record<string, unknown>) => {
        captured.push({ level, meta: meta ?? {} });
        return logger;
      }) as never);
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('never writes a bound parameter', () => {
    new RedactingQueryLogger().logQueryError(new Error('duplicate key'), INSERT, REAL_CUSTOMER);

    const line = JSON.stringify(captured);
    for (const value of REAL_CUSTOMER) expect(line).not.toContain(value);
  });

  it('still says what failed and what it was doing', () => {
    // Redaction that leaves nothing to debug with just moves the problem.
    new RedactingQueryLogger().logQueryError(new Error('duplicate key'), INSERT, REAL_CUSTOMER);

    const [entry] = captured;
    expect(entry.level).toBe('error');
    expect(entry.meta.error).toContain('duplicate key');
    expect(entry.meta.query).toContain('INSERT INTO "chatbot_bookings"');
    // The count reveals nothing and is occasionally the clue.
    expect(entry.meta.parameterCount).toBe(4);
  });

  it('collapses a pretty-printed query to one line and truncates it', () => {
    const huge = 'SELECT\n  ' + Array.from({ length: 200 }, (_, i) => `"col_${i}"`).join(',\n  ') + '\nFROM "t"';
    new RedactingQueryLogger().logQueryError('boom', huge, []);

    const q = captured[0].meta.query as string;
    expect(q).not.toContain('\n');
    expect(q.length).toBeLessThanOrEqual(301);
    expect(q).toContain('SELECT');
  });

  it('takes a plain string error, which TypeORM also hands in', () => {
    new RedactingQueryLogger().logQueryError('invalid input syntax for type uuid', INSERT, REAL_CUSTOMER);
    expect(captured[0].meta.error).toContain('invalid input syntax');
  });

  it('says NOTHING at all for a successful query', () => {
    // `logQuery` fires for every statement. Logging there would put every parameter of every
    // successful query in the log — the same disclosure, with far more volume.
    new RedactingQueryLogger().logQuery();
    expect(captured).toHaveLength(0);
  });

  it('redacts a slow query too, which is the other path that carries parameters', () => {
    new RedactingQueryLogger().logQuerySlow(5000, INSERT, REAL_CUSTOMER);

    const line = JSON.stringify(captured);
    for (const value of REAL_CUSTOMER) expect(line).not.toContain(value);
    expect(captured[0].level).toBe('warn');
    expect(captured[0].meta.ms).toBe(5000);
  });
});
