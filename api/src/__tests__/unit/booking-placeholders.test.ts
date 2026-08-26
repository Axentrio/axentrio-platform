import { describe, it, expect } from 'vitest';
import { formatServicesForPlaceholder, formatHoursForPlaceholder, buildHoursSection } from '../../modules/booking.module';
import { formatBusinessHoursForPlaceholder } from '../../utils/format-business-hours';
import { composeSystemPrompt } from '../../llm/compose-system-prompt';

const svc = (o: Partial<Record<string, unknown>>) =>
  ({ name: 'Service', durationMin: 30, durationMode: 'fixed', priceDisplayType: 'hidden', ...o } as any);
const tool = (name: string) => ({ name } as any);

describe('formatServicesForPlaceholder', () => {
  it('renders name + duration (+ price), comma-separated, no internal ids', () => {
    const out = formatServicesForPlaceholder([
      svc({ name: 'Check-up', durationMin: 20 }),
      svc({ name: 'Cleaning', durationMin: 45 }),
    ]);
    expect(out).toBe('Check-up (20 min), Cleaning (45 min)');
    expect(out).not.toMatch(/auto-book|request-only/); // no internal booking modes
  });

  it('renders a duration RANGE for range/ai services', () => {
    const out = formatServicesForPlaceholder([
      svc({ name: 'Repair', durationMode: 'range', minDurationMin: 30, maxDurationMin: 90 }),
    ]);
    expect(out).toBe('Repair (30-90 min)');
  });

  it('empty catalog → empty string (never a literal placeholder)', () => {
    expect(formatServicesForPlaceholder([])).toBe('');
  });
});

describe('formatHoursForPlaceholder', () => {
  it('no rule → empty string', () => {
    expect(formatHoursForPlaceholder(null)).toBe('');
  });

  it('always_open → 24/7 phrasing', () => {
    expect(formatHoursForPlaceholder({ availabilityMode: 'always_open' } as any)).toBe('open 24/7');
  });

  it('renders every weekday, naming closed days so yesterday can bind', () => {
    const rule = {
      availabilityMode: 'weekly',
      timezone: 'Europe/Brussels',
      weeklyHours: {
        mon: [{ start: '09:00', end: '17:00' }],
        wed: [{ start: '10:00', end: '14:00' }],
      },
    } as any;
    expect(formatHoursForPlaceholder(rule)).toBe(
      'Mon 09:00–17:00, Tue closed, Wed 10:00–14:00, Thu closed, Fri closed, Sat closed, Sun closed',
    );
  });

  it('states one-off hours that open a normally-closed Sunday', () => {
    const rule = {
      availabilityMode: 'weekly',
      timezone: 'Europe/Brussels',
      weeklyHours: { mon: [{ start: '09:00', end: '17:00' }] },
      dateOverrides: [{ date: '2026-10-04', closed: false, windows: [{ start: '09:00', end: '16:00' }] }],
    } as any;
    const out = formatHoursForPlaceholder(rule, new Date('2026-08-20T10:00:00Z'));
    expect(out).toContain('Sun closed');
    expect(out).toContain('2026-10-04 open 09:00–16:00');
  });
});

describe('formatBusinessHoursForPlaceholder (non-booking bots)', () => {
  it('names every weekday, including closed days', () => {
    const bh = {
      enabled: true,
      schedule: [
        { day: 'monday', open: '09:00', close: '17:00', closed: false },
        { day: 'tuesday', open: '', close: '', closed: true },
        { day: 'wednesday', open: '10:00', close: '14:00', closed: false },
      ],
    } as any;
    expect(formatBusinessHoursForPlaceholder(bh)).toBe(
      'Mon 09:00–17:00, Tue closed, Wed 10:00–14:00, Thu closed, Fri closed, Sat closed, Sun closed',
    );
    expect(formatBusinessHoursForPlaceholder({ ...bh, enabled: false })).toBe('');
    expect(formatBusinessHoursForPlaceholder(null)).toBe('');
  });

  it('appends upcoming closed dates so a holiday is not silently omitted', () => {
    const bh = {
      enabled: true,
      schedule: [{ day: 'monday', open: '09:00', close: '17:00', closed: false }],
      dateOverrides: [{ date: '2026-12-25', closed: true }],
    } as any;
    expect(formatBusinessHoursForPlaceholder(bh, new Date('2026-12-01T10:00:00Z'))).toContain(
      'closed 2026-12-25',
    );
    expect(formatBusinessHoursForPlaceholder(bh, new Date('2026-12-01T10:00:00Z'))).toContain('Mon 09:00–17:00');
  });

  it('states one-off hours that open a normally-closed Sunday', () => {
    const bh = {
      enabled: true,
      schedule: [
        { day: 'monday', open: '09:00', close: '17:00', closed: false },
        { day: 'sunday', open: '', close: '', closed: true },
      ],
      dateOverrides: [{ date: '2026-10-04', closed: false, windows: [{ start: '09:00', end: '16:00' }] }],
    } as any;
    const out = formatBusinessHoursForPlaceholder(bh, new Date('2026-08-20T10:00:00Z'), 'Europe/Brussels');
    expect(out).toContain('Sun closed');
    expect(out).toContain('2026-10-04 open 09:00–16:00');
  });
});

describe('{bookingHours} substitution in the composed prompt', () => {
  const ai = { enabled: true } as any;
  const base = { mode: 'agent' as const, ai, tenantName: 'Acme' };
  const body = 'Book during {bookingHours}.';

  it('substitutes live booking hours when the bot CAN book', () => {
    const { prompt } = composeSystemPrompt({
      ...base,
      tools: [tool('create_booking')],
      bookingConfigured: true,
      templateBody: body,
      bookingHours: 'Mon 09:00–17:00',
    } as any);
    expect(prompt).toContain('Book during Mon 09:00–17:00.');
    expect(prompt).not.toContain('{bookingHours}');
  });

  it('a bot with no booking tools resolves {bookingHours} to empty and never leaks a literal placeholder', () => {
    const { prompt } = composeSystemPrompt({
      ...base,
      tools: [],
      templateBody: body,
      bookingHours: 'Mon 09:00–17:00',
    } as any);
    expect(prompt).not.toContain('Mon 09:00–17:00');
    expect(prompt).not.toContain('{bookingHours}');
    expect(prompt).toContain('Book during .');
  });
});

describe('{language} substitution in the composed prompt', () => {
  it('substitutes the bot default language', () => {
    const { prompt } = composeSystemPrompt({
      mode: 'agent',
      ai: { enabled: true, language: 'nl' },
      tenantName: 'Acme',
      tools: [],
      templateBody: 'Default language: {language}.',
    } as any);
    expect(prompt).toContain('Default language: nl.');
    expect(prompt).not.toContain('{language}');
  });

  it('fails closed to en when language is missing', () => {
    const { prompt } = composeSystemPrompt({
      mode: 'agent',
      ai: { enabled: true },
      tenantName: 'Acme',
      tools: [],
      templateBody: 'Default language: {language}.',
    } as any);
    expect(prompt).toContain('Default language: en.');
  });
});

describe('{services} / {openingHours} substitution in the composed prompt', () => {
  const ai = { enabled: true } as any;
  const base = { mode: 'agent' as const, ai, tenantName: 'Acme' };
  const body = 'We offer {services}. We are open {openingHours}.';

  it('substitutes live booking config when the bot CAN book', () => {
    const { prompt } = composeSystemPrompt({
      ...base,
      tools: [tool('create_booking')],
      bookingConfigured: true,
      templateBody: body,
      bookingServices: 'Check-up (20 min)',
      openingHours: 'Mon 09:00–17:00',
    } as any);
    expect(prompt).toContain('We offer Check-up (20 min).');
    expect(prompt).toContain('We are open Mon 09:00–17:00.');
  });

  it('SERVICES are a capability: a bot with no booking tools resolves {services} to empty and never leaks a literal placeholder', () => {
    const { prompt } = composeSystemPrompt({
      ...base,
      tools: [], // gated / no booking skill
      templateBody: body,
      bookingServices: 'Check-up (20 min)',
      openingHours: 'Mon 09:00–17:00',
    } as any);
    expect(prompt).not.toContain('Check-up');
    expect(prompt).not.toContain('{services}');
    expect(prompt).not.toContain('{openingHours}');
  });

  it('HOURS are a business fact: a NON-booking bot still states its opening hours (the businessHours gap)', () => {
    const { prompt } = composeSystemPrompt({
      ...base,
      tools: [], // no booking skill at all
      templateBody: body,
      openingHours: 'Mon 09:00–17:00', // came from Bot.settings.businessHours
    } as any);
    expect(prompt).toContain('We are open Mon 09:00–17:00.');
    expect(prompt).toContain('We offer .'); // services still empty
    expect(prompt).toContain('## OPENING HOURS');
    expect(prompt).toContain('Mon 09:00–17:00');
  });

  it('generic core (no template body) still gets an OPENING HOURS section when hours are configured', () => {
    const { prompt } = composeSystemPrompt({
      ...base,
      tools: [tool('kb_search')],
      openingHours: 'Mon 09:00–17:00 · closed 2026-08-23',
    } as any);
    expect(prompt).toContain('## OPENING HOURS');
    expect(prompt).toContain('closed 2026-08-23');
    expect(prompt).toContain('configured hours override');
    expect(prompt).not.toMatch(/factual about the business — services, opening hours/);
  });

  it('booking tools present but NOT configured → {services} still empty', () => {
    const { prompt } = composeSystemPrompt({
      ...base,
      tools: [tool('create_booking')],
      bookingConfigured: false,
      templateBody: body,
      bookingServices: 'Check-up (20 min)',
      openingHours: 'Mon 09:00–17:00',
    } as any);
    expect(prompt).not.toContain('Check-up');
    expect(prompt).not.toContain('{services}');
  });
});

describe('buildHoursSection — date overrides reach the prompt', () => {
  const NOW = new Date('2026-12-01T12:00:00Z');
  const rule = (over: Record<string, unknown> = {}) =>
    ({
      timezone: 'Europe/Brussels',
      availabilityMode: 'business_hours',
      weeklyHours: { mon: [{ start: '09:00', end: '17:00' }] },
      dateOverrides: [],
      slotGranularityMin: 30,
      ...over,
    }) as never;

  it('states an upcoming closure the engine will enforce', () => {
    // The gap this closes: the bot answered "are you open on 25 December?" from the weekly
    // grid and contradicted a closure the slot engine was about to apply.
    const out = buildHoursSection(rule({ dateOverrides: [{ date: '2026-12-25', closed: true }] }), NOW)!;
    expect(out).toContain('2026-12-25');
    expect(out).toContain('CLOSED');
    expect(out).not.toContain('Europe/Brussels');
  });

  it('states one-off hours as a restriction, not a closure', () => {
    const out = buildHoursSection(
      rule({ dateOverrides: [{ date: '2026-12-24', windows: [{ start: '09:00', end: '12:00' }] }] }),
      NOW,
    )!;
    expect(out).toContain('open 09:00–12:00 only');
    expect(out).not.toContain('2026-12-24 (Thursday 24 December): CLOSED');
  });

  it('drops overrides that have already passed', () => {
    const out = buildHoursSection(
      rule({ dateOverrides: [{ date: '2026-01-01', closed: true }, { date: '2026-12-25', closed: true }] }),
      NOW,
    )!;
    expect(out).not.toContain('2026-01-01');
    expect(out).toContain('2026-12-25');
  });

  it('shows closures for an ALWAYS-OPEN business too — a closure wins in every mode', () => {
    const out = buildHoursSection(
      rule({ availabilityMode: 'always_open', dateOverrides: [{ date: '2026-12-25', closed: true }] }),
      NOW,
    )!;
    expect(out).toContain('24/7');
    expect(out).toContain('2026-12-25');
  });

  it('caps the list and SAYS it was cut rather than truncating silently', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      date: `2026-12-${String(i + 5).padStart(2, '0')}`,
      closed: true,
    }));
    const out = buildHoursSection(rule({ dateOverrides: many }), NOW)!;
    expect(out).toContain('and 4 more');
  });

  it('still returns null when there is nothing reliable to say at all', () => {
    expect(buildHoursSection(rule({ weeklyHours: {} }), NOW)).toBeNull();
  });

  it('renders hours with no overrides exactly as before', () => {
    const out = buildHoursSection(rule(), NOW)!;
    expect(out).toContain('## OPENING HOURS');
    expect(out).toContain('The business is open at these times.');
    expect(out).toContain('- Mon: 09:00–17:00');
    expect(out).not.toContain('OVERRIDE');
    expect(out).not.toContain('Europe/Brussels');
    expect(out).not.toMatch(/The business is open at these times \(/);
  });

  it('operational hours win when both stores exist, including an upcoming closed date', () => {
    const operational = {
      enabled: true,
      schedule: [{ day: 'monday', open: '08:00', close: '12:00', closed: false }],
      dateOverrides: [{ date: '2026-12-23', closed: true }],
    };
    const out = buildHoursSection(
      rule({ weeklyHours: { mon: [{ start: '09:00', end: '17:00' }] } }),
      NOW,
      { hours: operational, timezone: 'Europe/Brussels' },
    )!;
    expect(out).toContain('- Mon: 08:00–12:00');
    expect(out).not.toContain('09:00');
    expect(out).toContain('2026-12-23');
    expect(out).toContain('CLOSED');
    expect(out).not.toContain('Europe/Brussels');
  });

  it('states a closed Wednesday as closed, not by omitting it', () => {
    const operational = {
      enabled: true,
      schedule: [
        { day: 'monday', open: '09:00', close: '17:00', closed: false },
        { day: 'wednesday', open: '', close: '', closed: true },
      ],
    };
    const out = buildHoursSection(null, NOW, { hours: operational, timezone: 'Europe/Brussels' })!;
    expect(out).toContain('- Wed: closed');
    expect(out).toContain('- Mon: 09:00–17:00');
    expect(out).not.toMatch(/days not listed are closed/i);
  });

  it('states one-off hours that open a normally-closed day', () => {
    const operational = {
      enabled: true,
      schedule: [
        { day: 'monday', open: '09:00', close: '17:00', closed: false },
        { day: 'sunday', open: '', close: '', closed: true },
      ],
      dateOverrides: [{ date: '2026-12-06', closed: false, windows: [{ start: '09:00', end: '16:00' }] }],
    };
    const out = buildHoursSection(null, NOW, { hours: operational, timezone: 'Europe/Brussels' })!;
    expect(out).toContain('- Sun: closed');
    expect(out).toContain('2026-12-06');
    expect(out).toContain('open 09:00–16:00 only');
    expect(out).toMatch(/OVERRIDE the weekly hours/i);
    expect(out).not.toMatch(/Never tell a customer you are open on one of these closed dates/i);
  });
});
