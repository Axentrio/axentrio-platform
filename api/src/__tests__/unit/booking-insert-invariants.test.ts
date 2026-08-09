/**
 * `chatbot_bookings.blocked_range` is NOT NULL in production, and nothing in TypeScript says so.
 *
 * The column is written as a `tstzrange` through raw SQL at every write, and the `Booking` entity
 * deliberately does not map it - so the compiler cannot help, and an insert that omits it fails
 * only when it reaches production, on the booking hot path, with a not-null violation.
 *
 * THE TEST SCHEMA CANNOT CATCH THIS, and the attempt is worth recording rather than repeating.
 * Making the column `NOT NULL` in `booking-blocked-range.sql.ts` fails 37 tests across 8 files,
 * every one of which seeds bookings through `repo.save(repo.create(...))` - which cannot supply a
 * range, because the entity does not map one. Parity would mean rewriting eight fixtures in files
 * about leads and retention that have no interest in ranges, and it would still only catch an
 * omission that some test happened to exercise.
 *
 * So the rule is asserted where it is actually broken: at the source. Both checks below describe
 * production code, not tests, and both fail the moment someone writes the insert that production
 * would reject.
 *
 * Found by smoke-testing production while verifying #72 - a fixture that seeded a Request with a
 * null range, which prod could not have created.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

/** Every production `.ts` under `src/`, excluding tests and migrations. */
function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Migrations legitimately create the table and backfill it; they are not inserts of a
      // booking in the ordinary sense and are reviewed as schema changes.
      if (entry !== '__tests__' && entry !== 'migrations') out.push(...productionFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const SRC = join(__dirname, '..', '..');

describe('every production insert of a booking supplies its blocked range', () => {
  it('finds the inserts at all - otherwise this file asserts nothing', () => {
    const found = productionFiles(SRC).flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/INSERT\s+INTO\s+chatbot_bookings/gi)].map(() => f)
    );
    // Two today: `createBooking` and `requestAppointment`. Pinned as a floor, not an equality,
    // so an ordinary addition does not fail here - the real assertion is the next one.
    expect(found.length).toBeGreaterThanOrEqual(2);
  });

  it('names blocked_range in the column list', () => {
    const offenders: string[] = [];
    for (const file of productionFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/INSERT\s+INTO\s+chatbot_bookings([\s\S]*?)VALUES/gi)) {
        if (!/blocked_range/i.test(m[1])) offenders.push(file.replace(SRC, 'src'));
      }
    }
    // Read this failure as: the column is NOT NULL in production. An insert without it does not
    // fail here for tidiness - it fails in production, when a customer tries to book.
    expect(offenders).toEqual([]);
  });
});

describe('bookings are never inserted through the entity', () => {
  it('because the entity cannot supply the range, so such an insert can only fail in production', () => {
    // `getRepository(Booking)` is used for reads and for `.query()`, both fine. What must never
    // appear is a `.save(` or `.insert(` on it: TypeORM would omit `blocked_range`, every test
    // would pass against the laxer test schema, and production would reject the row.
    const offenders: string[] = [];
    for (const file of productionFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/getRepository\(Booking\)([\s\S]{0,200})/g)) {
        if (/\.\s*(save|insert)\s*\(/.test(m[1])) offenders.push(file.replace(SRC, 'src'));
      }
    }
    expect(offenders).toEqual([]);
  });
});
