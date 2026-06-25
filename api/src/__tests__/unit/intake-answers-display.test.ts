import { describe, it, expect } from 'vitest';
import { buildIntakeAnswers } from '../../booking/booking.service';
import type { IntakeQuestion } from '../../database/entities/ServiceType';

const Q: IntakeQuestion[] = [
  { id: 'q1', label: 'Occasion?', type: 'text', required: true },
  { id: 'q2', label: 'Size?', type: 'choice', required: false, options: ['S', 'L'] },
];

describe('buildIntakeAnswers (P3c)', () => {
  it('orders by the service question array, using current labels', () => {
    // stored map intentionally out of question order
    const out = buildIntakeAnswers(Q, { q2: 'L', q1: 'Birthday' });
    expect(out).toEqual([
      { label: 'Occasion?', answer: 'Birthday' },
      { label: 'Size?', answer: 'L' },
    ]);
  });

  it('coerces numbers, trims, and drops blank/non-scalar answers', () => {
    const out = buildIntakeAnswers(Q, { q1: '  Birthday  ', q2: 7 });
    expect(out).toEqual([
      { label: 'Occasion?', answer: 'Birthday' },
      { label: 'Size?', answer: '7' },
    ]);
    expect(buildIntakeAnswers(Q, { q1: '   ', q2: { nested: 1 } })).toBeNull();
  });

  it('appends deleted-question answers after ordered ones, sorted by key, raw id as label', () => {
    const out = buildIntakeAnswers(Q, { q1: 'Birthday', zzz: 'last', aaa: 'first' });
    expect(out).toEqual([
      { label: 'Occasion?', answer: 'Birthday' },
      { label: 'aaa', answer: 'first' },
      { label: 'zzz', answer: 'last' },
    ]);
  });

  it('treats a non-object / non-array stored value as no answers', () => {
    expect(buildIntakeAnswers(Q, null)).toBeNull();
    expect(buildIntakeAnswers(Q, ['a', 'b'])).toBeNull();
    expect(buildIntakeAnswers(Q, 'oops')).toBeNull();
  });

  it('degrades a malformed/absent questions list to deleted-branch (answers kept, sorted by key)', () => {
    const out = buildIntakeAnswers(null, { q1: 'Birthday', a: 'x' });
    expect(out).toEqual([
      { label: 'a', answer: 'x' },
      { label: 'q1', answer: 'Birthday' },
    ]);
  });

  it('skips a question with a non-string label (answer preserved via raw-id branch, no object reaches React)', () => {
    // legacy/hand-edited: valid id, broken label
    const bad = [{ id: 'q1', label: { x: 1 }, type: 'text', required: false }] as unknown as IntakeQuestion[];
    const out = buildIntakeAnswers(bad, { q1: 'Birthday' });
    expect(out).toEqual([{ label: 'q1', answer: 'Birthday' }]); // raw id label, string only
  });
});
