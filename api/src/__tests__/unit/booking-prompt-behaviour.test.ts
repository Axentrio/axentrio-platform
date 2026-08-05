/**
 * Prompt lines that ARE the feature.
 *
 * Two behaviours in the booking module live entirely in prose, by design, and neither was
 * pinned by anything — so an ordinary tidy-up of the wording would delete a shipped feature
 * and leave every test green.
 *
 * 1. `durationMode: 'ai'` vs `'range'`. These are byte-identical in every executable path —
 *    same validation, same duration resolution, same availability maths, same downgrade to
 *    a request when the model omits a length. That is CORRECT: the difference is *who
 *    decides* the length, which is a conversational question, not a computational one. The
 *    catalog line and rule 7 are the whole of the distinction, so they are the whole of the
 *    feature. There is no separate estimator and there should not be one — the model is the
 *    estimator.
 *
 * 2. `aiSummary`. The plumbing is complete end to end, but the model only populates it
 *    because the SERVICES block asks it to. That ask went missing once already, which is
 *    why the field looked broken in prod while its wiring was provably fine.
 */
import { describe, it, expect } from 'vitest';
import { buildServicesSection } from '../../modules/booking.module';
import type { ServiceType } from '../../database/entities/ServiceType';

const svc = (over: Partial<ServiceType> = {}): ServiceType =>
  ({
    id: 'svc-1',
    name: 'Boiler repair',
    isActive: true,
    onlineBookable: true,
    durationMin: 60,
    durationMode: 'fixed',
    bookingMode: 'auto',
    priceDisplayType: 'none',
    locationType: 'in_person',
    customerAddressRequired: false,
    ...over,
  }) as ServiceType;

const RANGE = { durationMode: 'range' as const, minDurationMin: 30, maxDurationMin: 90 };

/**
 * The catalog line for a service, isolated from the rules below it.
 *
 * Rule 7 quotes BOTH cues ("choose length", "AI-estimated") as examples, so asserting
 * their absence against the whole section is meaningless — it can never be true while the
 * rule is present. The label lives on the service's own line, so that is what to read.
 */
const line = (section: string, id = 'svc-1'): string =>
  section.split('\n').find((l) => l.startsWith(`- ${id} `)) ?? '';

describe("durationMode 'ai' vs 'range' — a prompt-only distinction, deliberately", () => {
  it('labels a range service "choose length" and an ai service "AI-estimated"', () => {
    const range = buildServicesSection([svc(RANGE)])!;
    const ai = buildServicesSection([svc({ ...RANGE, durationMode: 'ai' })])!;
    expect(line(range)).toContain('30-90 min (choose length)');
    expect(line(ai)).toContain('30-90 min (AI-estimated)');
    // Each label EXCLUDES the other, which the whole-section view cannot show.
    expect(line(range)).not.toContain('AI-estimated');
    expect(line(ai)).not.toContain('choose length');
  });

  it('renders the two modes DIFFERENTLY — collapsing them silently removes the feature', () => {
    const range = buildServicesSection([svc(RANGE)])!;
    const ai = buildServicesSection([svc({ ...RANGE, durationMode: 'ai' })])!;
    expect(line(range)).not.toBe(line(ai));
  });

  it('instructs the bot to ask OR estimate, and names both cues', () => {
    // Rule 7 is what turns the label into behaviour. Without the "estimate it from what
    // they have described" half, an 'ai' service behaves exactly like a 'range' one.
    const p = buildServicesSection([svc(RANGE)])!;
    expect(p).toMatch(/ask the customer how long they need/i);
    expect(p).toMatch(/estimate it from what they have described/i);
    expect(p).toContain('choose length');
    expect(p).toContain('AI-estimated');
  });

  it('still refuses to guess: an unestablished length is captured, never booked short', () => {
    // The safety property that makes a prompt-only estimator acceptable. If the model
    // cannot establish a length, the server downgrades to a request rather than booking
    // the shortest option — so a bad estimate costs a confirmation, not a wrong slot.
    const p = buildServicesSection([svc(RANGE)])!;
    expect(p).toMatch(/captured as a REQUEST/i);
    expect(p).toMatch(/not confirmed at the shortest option/i);
  });

  it('says nothing about length for a fixed service', () => {
    const p = buildServicesSection([svc()])!;
    expect(line(p)).toContain('60 min');
    expect(line(p)).not.toContain('choose length');
    expect(line(p)).not.toContain('AI-estimated');
  });

  it('treats a malformed range as fixed rather than advertising a broken one', () => {
    for (const bad of [
      { minDurationMin: 0, maxDurationMin: 90 },
      { minDurationMin: 90, maxDurationMin: 30 },
      { minDurationMin: null, maxDurationMin: 90 },
    ]) {
      const p = buildServicesSection([svc({ durationMode: 'ai', ...bad } as Partial<ServiceType>)])!;
      // Falls back to the fixed duration rather than advertising a range it cannot honour.
      expect(line(p)).not.toContain('AI-estimated');
      expect(line(p)).toContain('60 min');
    }
  });
});

describe('aiSummary — the ask the model needs', () => {
  it('tells the model to pass aiSummary, and that it is for the owner', () => {
    // The wiring is complete on both create paths; this line is the only reason anything
    // ever arrives. It went missing once and the field looked broken in prod as a result.
    const p = buildServicesSection([svc()])!;
    expect(p).toContain('aiSummary');
    expect(p).toMatch(/written for the owner/i);
  });

  it('tells it NOT to invent one', () => {
    // A summary fabricated from nothing is worse than an absent one: the owner acts on it.
    const p = buildServicesSection([svc()])!;
    expect(p).toMatch(/Do NOT invent one/i);
    expect(p).toMatch(/skip it entirely when nothing was said/i);
  });

  it('tells it the customer never sees it', () => {
    const p = buildServicesSection([svc()])!;
    expect(p).toMatch(/the customer never sees it/i);
  });
});
