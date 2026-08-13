/** Keep this in one place: Vitest, global setup, and each worker must agree. */
export const TEST_WORKER_COUNT = 4;

/**
 * Resolve the only databases the test harness is allowed to create or replace.
 *
 * Validation is deliberately narrow because global setup drops these databases at the start of a
 * run. A malformed URL or suffix must fail before it can widen that destructive target.
 */
export function workerDatabaseName(baseUrl: string, workerId: number | string): string {
  const baseName = new URL(baseUrl).pathname.replace(/^\//, '') || 'chatbot_test';
  const id = String(workerId);
  if (!/^[a-zA-Z0-9_]+$/.test(baseName) || !/^\d+$/.test(id)) {
    throw new Error('Unsafe test worker database name');
  }
  return `${baseName}_${id}`;
}
