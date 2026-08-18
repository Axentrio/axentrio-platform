import { describe, expect, it } from 'vitest';
import { experimentOccurrences, priorityScore } from '../../insights/priority-score';

describe('insights priority score', () => {
  it('ranks severe rising demand above severe flat demand above low demand', () => {
    const rising = priorityScore({
      severity: 'red',
      occurrences: 10,
      currentVolume: 8,
      baselineVolume: 4,
    });
    const flat = priorityScore({
      severity: 'red',
      occurrences: 10,
      currentVolume: 4,
      baselineVolume: 4,
    });
    const low = priorityScore({
      severity: 'green',
      occurrences: 10,
      currentVolume: 4,
      baselineVolume: 4,
    });

    expect(rising).toBeGreaterThan(flat);
    expect(flat).toBeGreaterThan(low);
  });

  it('uses session or contingency counts for experiment occurrences', () => {
    expect(experimentOccurrences({ sessions: 7 })).toBe(7);
    expect(experimentOccurrences({ a: 2, b: 3, c: 4, d: 5 })).toBe(14);
  });
});
