import { describe, it, expect } from 'vitest';
import { returningRows } from '../../utils/raw-sql';

describe('returningRows — TypeORM UPDATE/DELETE…RETURNING normalization', () => {
  it('unwraps the [rows, affectedCount] UPDATE/DELETE shape', () => {
    expect(returningRows([[{ id: 'a' }, { id: 'b' }], 2])).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(returningRows([[], 0])).toEqual([]);
  });

  it('passes through plain row arrays (SELECT/INSERT shape)', () => {
    expect(returningRows([{ id: 'a' }])).toEqual([{ id: 'a' }]);
    expect(returningRows([])).toEqual([]);
  });

  it('does NOT mistake two plain rows for the wrapper shape', () => {
    // [rowA, rowB] — second element is an object, not a number.
    expect(returningRows([{ id: 'a' }, { id: 'b' }])).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('null/undefined → empty list', () => {
    expect(returningRows(undefined)).toEqual([]);
    expect(returningRows(null)).toEqual([]);
  });
});
