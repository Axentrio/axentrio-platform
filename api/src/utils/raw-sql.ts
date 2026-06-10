/**
 * TypeORM's `DataSource.query()` / `EntityManager.query()` returns PLAIN ROWS
 * for SELECT and INSERT…RETURNING — but for UPDATE…RETURNING and
 * DELETE…RETURNING it returns `[rows, affectedCount]` (see
 * PostgresQueryRunner: `result.raw = [raw.rows, raw.rowCount]` for the
 * UPDATE/DELETE commands).
 *
 * Every consumer that read `result.length` / `result[0]` off an UPDATE/DELETE
 * was silently wrong (length was ALWAYS 2): dead not-found guards, undefined
 * RETURNING fields, and a phantom-row loop in the sync reconciler. Route all
 * raw UPDATE/DELETE…RETURNING results through this normalizer.
 */
export function returningRows<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }
  // Already plain rows (SELECT/INSERT shape, or a future driver change).
  return (result as T[]) ?? [];
}
