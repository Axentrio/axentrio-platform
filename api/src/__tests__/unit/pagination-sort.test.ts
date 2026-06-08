import { describe, it, expect, vi } from 'vitest';
import { applyPagination, parsePaginationParams } from '../../utils/pagination';

// Mock just enough of a TypeORM SelectQueryBuilder to exercise the sort guard.
function mockQb(columnNames: string[], existingOrders: Record<string, unknown> = {}) {
  const orderByCalls: Array<[string, string]> = [];
  const qb: any = {
    alias: 'agent',
    expressionMap: {
      mainAlias: { metadata: { columns: columnNames.map((n) => ({ propertyName: n, databaseName: n })) } },
      orderBys: { ...existingOrders },
    },
    orderBy: vi.fn((col: string, dir: string) => {
      orderByCalls.push([col, dir]);
      qb.expressionMap.orderBys = { [col]: dir };
      return qb;
    }),
    skip: vi.fn(() => qb),
    take: vi.fn(() => qb),
    getManyAndCount: vi.fn(async () => [[], 0]),
  };
  return { qb, orderByCalls };
}

describe('applyPagination ORDER BY allow-list (#B)', () => {
  it('applies a valid column sort as alias.property', async () => {
    const { qb, orderByCalls } = mockQb(['id', 'name', 'createdAt']);
    await applyPagination(qb, parsePaginationParams({ sortBy: 'name', sortOrder: 'asc' }));
    expect(orderByCalls).toEqual([['agent.name', 'ASC']]);
  });

  it('ignores a malicious sortBy and falls back to a safe default (no injection)', async () => {
    const { qb, orderByCalls } = mockQb(['id', 'createdAt']);
    await applyPagination(qb, parsePaginationParams({ sortBy: '(SELECT pg_sleep(5))', sortOrder: 'desc' }));
    // never the raw input; falls back to createdAt
    expect(orderByCalls).toEqual([['agent.createdAt', 'DESC']]);
    expect(JSON.stringify(orderByCalls)).not.toContain('pg_sleep');
  });

  it('does NOT clobber a caller-defined order when sortBy is invalid', async () => {
    const { qb, orderByCalls } = mockQb(['id', 'createdAt'], { 'agent.priority': 'ASC' });
    await applyPagination(qb, parsePaginationParams({ sortBy: 'evil; DROP TABLE x' }));
    expect(orderByCalls).toEqual([]); // existing order preserved, no new orderBy
  });

  it('applies createdAt default when no sortBy and no existing order', async () => {
    const { qb, orderByCalls } = mockQb(['id', 'createdAt']);
    await applyPagination(qb, parsePaginationParams({}));
    expect(orderByCalls).toEqual([['agent.createdAt', 'DESC']]);
  });

  it('normalizes sortOrder (anything but asc → DESC)', () => {
    expect(parsePaginationParams({ sortOrder: 'asc' }).sortOrder).toBe('asc');
    expect(parsePaginationParams({ sortOrder: 'sideways' }).sortOrder).toBe('desc');
  });
});
