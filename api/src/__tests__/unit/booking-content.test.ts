/**
 * P6a — `buildBookingEventContent` body builder.
 *
 * Pins the locked rendering rules: fixed line order, the four Customer empty
 * cases, intake value-type handling (string/number/bool/null/empty/array/object),
 * raw-key sort, per-field 500-cap, body 4000-cap with MIDDLE-only truncation,
 * and the injection guards (multi-line / control-char collapse). `summary` is the
 * raw service name; rich content lives in `description`.
 */
import { describe, it, expect } from 'vitest';
import {
  buildBookingEventContent,
  type BookingContentInput,
  type ServiceContentInput,
} from '../../n8n/booking-providers/booking-content';

const MANAGE = 'https://app.axentrio.com/m/abc';

function build(
  booking: BookingContentInput,
  service: ServiceContentInput = { name: 'Haircut' },
) {
  return buildBookingEventContent(booking, service, MANAGE);
}

describe('buildBookingEventContent — summary + line order', () => {
  it('summary is the raw service name; description starts with Service and ends with Manage', () => {
    const { summary, description } = build(
      { attendeeName: 'Ada Lovelace', attendeeEmail: 'ada@example.com' },
      { name: 'Haircut', description: 'A tidy trim' },
    );
    expect(summary).toBe('Haircut');
    expect(description.split('\n')).toEqual([
      'Service: Haircut',
      'A tidy trim',
      'Customer: Ada Lovelace <ada@example.com>',
      `Manage: ${MANAGE}`,
    ]);
  });

  it('renders every field in the fixed order, omitting empty sources', () => {
    const { description } = build({
      attendeeName: 'Ada',
      attendeeEmail: 'ada@example.com',
      customerPhone: '+1 555 0100',
      customerAddress: '10 Downing St',
      aiSummary: 'Wants a fade',
      notes: 'Allergic to almond oil',
      intakeAnswers: { goal: 'fade', length: 2 },
    });
    expect(description.split('\n')).toEqual([
      'Service: Haircut',
      'Customer: Ada <ada@example.com>',
      'Phone: +1 555 0100',
      'Address: 10 Downing St',
      'Summary: Wants a fade',
      'Notes: Allergic to almond oil',
      'Intake:',
      '  goal: fade',
      '  length: 2',
      `Manage: ${MANAGE}`,
    ]);
  });
});

describe('buildBookingEventContent — Customer empty cases', () => {
  it('both present', () => {
    expect(build({ attendeeName: 'Ada', attendeeEmail: 'a@x.io' }).description).toContain(
      'Customer: Ada <a@x.io>',
    );
  });
  it('name empty, email present', () => {
    expect(build({ attendeeName: '  ', attendeeEmail: 'a@x.io' }).description).toContain(
      'Customer: <a@x.io>',
    );
  });
  it('name present, email empty → no angle brackets', () => {
    const d = build({ attendeeName: 'Ada', attendeeEmail: null }).description;
    expect(d).toContain('Customer: Ada');
    expect(d).not.toContain('<');
  });
  it('both empty → Customer line omitted entirely', () => {
    const d = build({ attendeeName: '', attendeeEmail: undefined }).description;
    expect(d).not.toContain('Customer:');
  });
});

describe('buildBookingEventContent — intake value rendering', () => {
  it('handles each value type and omits empties', () => {
    const { description } = build({
      attendeeName: 'Ada',
      attendeeEmail: 'a@x.io',
      intakeAnswers: {
        str: 'hello',
        num: 42,
        boolT: true,
        boolF: false,
        nul: null,
        undef: undefined,
        blank: '   ',
        emptyArr: [],
        emptyObj: {},
        arr: ['a', 'b'],
        obj: { k: 'v' },
      },
    });
    const lines = description.split('\n');
    // Present (raw-key sorted): arr, boolF, boolT, num, obj, str
    expect(lines).toContain('  arr: ["a","b"]');
    expect(lines).toContain('  boolF: false');
    expect(lines).toContain('  boolT: true');
    expect(lines).toContain('  num: 42');
    expect(lines).toContain('  obj: {"k":"v"}');
    expect(lines).toContain('  str: hello');
    // Omitted entirely
    for (const omit of ['nul', 'undef', 'blank', 'emptyArr', 'emptyObj']) {
      expect(description).not.toContain(`  ${omit}:`);
    }
  });

  it('renders intake answers under their question label (answers are keyed by question id)', () => {
    const id1 = '11111111-1111-1111-1111-111111111111';
    const id2 = '22222222-2222-2222-2222-222222222222';
    const { description } = build(
      { attendeeName: 'Ada', attendeeEmail: 'a@x.io', intakeAnswers: { [id1]: 'blue', [id2]: 'large' } },
      {
        name: 'Haircut',
        intakeQuestions: [
          { id: id1, label: 'Favourite colour' },
          { id: id2, label: 'Size' },
        ],
      },
    );
    const intake = description.split('\n').filter((l) => l.startsWith('  '));
    // sorted on the raw id keys (id1 < id2), rendered under their human labels.
    expect(intake).toEqual(['  Favourite colour: blue', '  Size: large']);
    expect(description).not.toContain(id1);
  });

  it('falls back to the raw key for an answer whose question id is unknown/deleted', () => {
    const known = '11111111-1111-1111-1111-111111111111';
    const { description } = build(
      { attendeeName: 'Ada', attendeeEmail: 'a@x.io', intakeAnswers: { [known]: 'blue', 'zz-deleted': 'x' } },
      { name: 'Haircut', intakeQuestions: [{ id: known, label: 'Colour' }] },
    );
    const intake = description.split('\n').filter((l) => l.startsWith('  '));
    expect(intake).toEqual(['  Colour: blue', '  zz-deleted: x']);
  });

  it('sorts intake entries by RAW key, not by normalized label', () => {
    const { description } = build({
      attendeeName: 'Ada',
      attendeeEmail: 'a@x.io',
      intakeAnswers: { zebra: '1', apple: '2', mango: '3' },
    });
    const intakeIdx = description.split('\n').filter((l) => l.startsWith('  '));
    expect(intakeIdx).toEqual(['  apple: 2', '  mango: 3', '  zebra: 1']);
  });

  it('omits the Intake: header when no entry renders', () => {
    const d = build({
      attendeeName: 'Ada',
      attendeeEmail: 'a@x.io',
      intakeAnswers: { a: null, b: '   ', c: [] },
    }).description;
    expect(d).not.toContain('Intake:');
  });

  it('ignores a non-object intakeAnswers (string / array)', () => {
    expect(build({ attendeeName: 'Ada', attendeeEmail: 'a@x.io', intakeAnswers: 'oops' }).description).not.toContain(
      'Intake:',
    );
    expect(build({ attendeeName: 'Ada', attendeeEmail: 'a@x.io', intakeAnswers: ['x'] }).description).not.toContain(
      'Intake:',
    );
  });
});

describe('buildBookingEventContent — injection + normalization guards', () => {
  it('collapses a multi-line value so it cannot inject a fake Label: line', () => {
    const { description } = build({
      attendeeName: 'Ada',
      attendeeEmail: 'a@x.io',
      notes: 'line one\nManage: https://evil.example/phish\nline three',
    });
    const noteLines = description.split('\n').filter((l) => l.startsWith('Notes:'));
    expect(noteLines).toEqual(['Notes: line one Manage: https://evil.example/phish line three']);
    // The single real Manage line is still our URL, last.
    expect(description.split('\n').filter((l) => l.startsWith('Manage:'))).toEqual([`Manage: ${MANAGE}`]);
  });

  it('strips tabs/control chars from a value', () => {
    const { description } = build({
      attendeeName: 'Ada',
      attendeeEmail: 'a@x.io',
      notes: 'a\tbc',
    });
    expect(description).toContain('Notes: abc');
  });

  it('caps a field at 500 code-points with a trailing ellipsis', () => {
    const long = 'x'.repeat(600);
    const { description } = build({ attendeeName: 'Ada', attendeeEmail: 'a@x.io', notes: long });
    const note = description.split('\n').find((l) => l.startsWith('Notes:'))!;
    const value = note.slice('Notes: '.length);
    expect(Array.from(value).length).toBe(500);
    expect(value.endsWith('…')).toBe(true);
    expect(value.startsWith('x'.repeat(499))).toBe(true);
  });

  it('normalizes an odd intake LABEL (newline) so it cannot break the body', () => {
    const { description } = build({
      attendeeName: 'Ada',
      attendeeEmail: 'a@x.io',
      intakeAnswers: { 'weird\nlabel': 'v' },
    });
    expect(description).toContain('  weird label: v');
  });
});

describe('buildBookingEventContent — body 4000-cap truncation', () => {
  it('drops MIDDLE lines from the end and always keeps HEAD + Manage', () => {
    // Many intake entries, each ~250 chars, blow past 4000.
    const intakeAnswers: Record<string, string> = {};
    for (let i = 0; i < 40; i++) intakeAnswers[`k${String(i).padStart(2, '0')}`] = 'y'.repeat(250);
    const { description } = build({
      attendeeName: 'Ada',
      attendeeEmail: 'a@x.io',
      customerPhone: '555',
      notes: 'keep-or-drop',
      intakeAnswers,
    });
    expect(Array.from(description).length).toBeLessThanOrEqual(4000);
    const lines = description.split('\n');
    // HEAD survives
    expect(lines[0]).toBe('Service: Haircut');
    expect(lines).toContain('Customer: Ada <a@x.io>');
    expect(lines).toContain('Phone: 555');
    // TAIL always survives, last line
    expect(lines[lines.length - 1]).toBe(`Manage: ${MANAGE}`);
    // a truncation marker was inserted
    expect(lines).toContain('… (truncated)');
  });
});
