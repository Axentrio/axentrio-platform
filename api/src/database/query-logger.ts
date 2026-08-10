import type { Logger as TypeOrmLogger, QueryRunner } from 'typeorm';
import { logger } from '../utils/logger';

/**
 * What a failed query is allowed to say in the logs.
 *
 * TypeORM's `advanced-console` logger prints the whole statement AND its bound parameters on
 * error, straight to the console. Every value a customer ever typed is a bound parameter: on a
 * failed booking insert that is their name, email, phone and home address, written to production
 * logs where they are retained, shipped to a log drain and readable by anyone with access.
 *
 * Found by sending a booking id of `../../etc/passwd` and watching prod echo it back inside a
 * 2,000-character SELECT. The injection went nowhere - Postgres rejected the uuid cast, and the
 * model got a sanitised error - but the log line was the real finding.
 *
 * So: the error and enough of the statement to identify it, never the values. A parameter COUNT
 * is kept because "this query had 12 parameters" is occasionally the clue and reveals nothing.
 */

/** Enough to recognise the statement. A failing query is identified by its shape, not its tail. */
const QUERY_EXCERPT_CHARS = 300;

/** Collapse the whitespace TypeORM pretty-prints into, so one query is one log line. */
function excerpt(query: string): string {
  const flat = query.replace(/\s+/g, ' ').trim();
  return flat.length > QUERY_EXCERPT_CHARS ? `${flat.slice(0, QUERY_EXCERPT_CHARS)}…` : flat;
}

/**
 * A TypeORM logger that routes through winston and never prints a bound value.
 *
 * Only the levels `data-source.ts` actually enables do anything; the rest satisfy the interface.
 * `logQuery` in particular stays silent on purpose - it fires for EVERY statement, and turning it
 * on would put every parameter of every successful query in the log, which is the same disclosure
 * with more volume.
 */
export class RedactingQueryLogger implements TypeOrmLogger {
  logQuery(): void {
    // Deliberately nothing. See the class comment.
  }

  logQueryError(error: string | Error, query: string, parameters?: unknown[]): void {
    logger.error('Database query failed', {
      // A string here rather than the Error, because TypeORM hands both shapes in and the
      // difference is not worth making a caller think about.
      error: error instanceof Error ? error.message : String(error),
      query: excerpt(query),
      parameterCount: parameters?.length ?? 0,
    });
  }

  logQuerySlow(time: number, query: string, parameters?: unknown[]): void {
    logger.warn('Slow database query', {
      ms: time,
      query: excerpt(query),
      parameterCount: parameters?.length ?? 0,
    });
  }

  logSchemaBuild(message: string): void {
    logger.info('[typeorm] schema', { message });
  }

  logMigration(message: string): void {
    logger.info('[typeorm] migration', { message });
  }

  log(level: 'log' | 'info' | 'warn', message: unknown, _queryRunner?: QueryRunner): void {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    if (level === 'warn') logger.warn('[typeorm]', { message: text });
    else logger.info('[typeorm]', { message: text });
  }
}
