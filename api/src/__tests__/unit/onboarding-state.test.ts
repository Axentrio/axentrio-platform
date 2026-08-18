/**
 * First-run setup rules.
 *
 * Onboarding cannot be skipped, which makes this the only thing standing between a new
 * customer and the product. Everything below is about the two ways that goes wrong:
 * letting someone through with an empty workspace, or trapping someone who was already
 * using the product long before any of this existed.
 */
import { describe, it, expect } from 'vitest';
import {
  emptyState,
  isComplete,
  nextStep,
  requiresOnboarding,
  validateStepSubmission,
  ONBOARDING_STEPS,
  REQUIRED_STEPS,
  SKIP_DISABLES,
  type OnboardingState,
} from '../../onboarding/onboarding-state';
import { TENANT_TOGGLEABLE_FEATURES } from '../../billing/feature-toggles';

const company = {
  vatNumber: 'BE0400378485', name: 'Colruyt Group', legalForm: 'NV',
  street: 'Edingensesteenweg 196', postalCode: '1500', city: 'Halle', verified: true,
};

/** Walk the wizard to completion. */
function finished(): OnboardingState {
  const s = emptyState();
  s.language = 'nl';
  s.company = company;
  for (const step of ONBOARDING_STEPS) s.steps[step] = 'done';
  return s;
}

describe('SKIP_DISABLES names only toggles that exist', () => {
  it('every key it would write is a real tenant feature toggle', () => {
    // A toggle that does not exist is a skip that silently does nothing — worse than
    // not offering the choice at all.
    for (const keys of Object.values(SKIP_DISABLES)) {
      for (const key of keys ?? []) {
        expect(TENANT_TOGGLEABLE_FEATURES).toContain(key);
      }
    }
  });

  it('never claims to disable a required step', () => {
    for (const step of Object.keys(SKIP_DISABLES)) {
      expect(REQUIRED_STEPS).not.toContain(step);
    }
  });
});

describe('nextStep — walks the wizard in order', () => {
  it('asks for a plan before offering paid social channels', () => {
    expect(ONBOARDING_STEPS).toEqual([
      'language',
      'company',
      'logo',
      'chatbot',
      'documents',
      'bookings',
      'leads',
      'plan',
      'social',
    ]);
  });

  it('starts at the language question', () => {
    expect(nextStep(emptyState())).toBe('language');
  });

  it('will not advance past language on a marker alone', () => {
    // The marker is client-controlled; the DATA is what proves the step happened.
    const s = emptyState();
    s.steps.language = 'done';
    expect(nextStep(s)).toBe('language');
    s.language = 'fr';
    expect(nextStep(s)).toBe('company');
  });

  it('will not advance past company without a company on the record', () => {
    const s = emptyState();
    s.language = 'en';
    s.steps.language = 'done';
    s.steps.company = 'done';
    expect(nextStep(s)).toBe('company');
    s.company = company;
    expect(nextStep(s)).toBe('logo');
  });

  it('treats a skipped optional step as answered', () => {
    const s = emptyState();
    s.language = 'nl';
    s.company = company;
    s.steps.language = 'done';
    s.steps.company = 'done';
    s.steps.logo = 'skipped';
    expect(nextStep(s)).toBe('chatbot');
  });

  it('returns null only once every step is answered', () => {
    expect(nextStep(finished())).toBeNull();
  });
});

describe('required steps cannot be skipped', () => {
  it('rejects a skip on each required step at the moment it is made', () => {
    // Accepting the skip and refusing to finish later is a worse experience than
    // saying no when the choice is made.
    for (const step of REQUIRED_STEPS) {
      expect(validateStepSubmission(step, 'skipped')).toMatchObject({ ok: false });
      expect(validateStepSubmission(step, 'done')).toEqual({ ok: true });
    }
  });

  it('accepts a skip on the optional ones', () => {
    for (const step of ['logo', 'chatbot', 'social', 'bookings', 'leads'] as const) {
      expect(validateStepSubmission(step, 'skipped')).toEqual({ ok: true });
    }
  });

  it('rejects a step it does not know', () => {
    expect(validateStepSubmission('nonsense' as never, 'done')).toMatchObject({ ok: false });
  });

  it('a skipped required step never counts as satisfied, even if stored', () => {
    // Belt and braces: the route rejects it, but state that arrived some other way
    // must not open the door either.
    const s = finished();
    s.steps.documents = 'skipped';
    expect(isComplete(s)).toBe(false);
    expect(nextStep(s)).toBe('documents');
  });
});

describe('requiresOnboarding — nobody already using the product gets trapped', () => {
  it('sends a brand-new workspace through setup', () => {
    expect(requiresOnboarding(null)).toBe(true);
    expect(requiresOnboarding(undefined)).toBe(true);
    expect(requiresOnboarding(emptyState())).toBe(true);
  });

  it('lets a finished workspace straight through', () => {
    expect(requiresOnboarding(finished())).toBe(false);
  });

  it('lets a grandfathered tenant through on the stamp alone', () => {
    // Tenants that predate onboarding are stamped complete by migration. They have no
    // language, no company and no steps, and must never see the wizard.
    const s = emptyState();
    s.completedAt = new Date().toISOString();
    s.grandfathered = true;
    expect(requiresOnboarding(s)).toBe(false);
    expect(isComplete(s)).toBe(true);
  });
});

describe('nextStep and isComplete cannot disagree', () => {
  it('reports no next step for a grandfathered tenant', () => {
    // The lockout failure mode: a customer of two years, whose steps are all literally
    // unanswered, must not be routed into a wizard asking for their VAT number.
    const grandfathered: OnboardingState = {
      ...emptyState(),
      completedAt: '2026-01-01T00:00:00.000Z',
      grandfathered: true,
    };
    expect(nextStep(grandfathered)).toBeNull();
    expect(isComplete(grandfathered)).toBe(true);
  });

  it('agrees with isComplete across every state these two are asked about', () => {
    // A caller that reads only one of the two must not reach a different conclusion
    // than a caller that reads the other.
    const partial = emptyState();
    partial.steps.language = 'done';
    partial.language = 'nl';

    const finished = emptyState();
    finished.completedAt = '2026-01-01T00:00:00.000Z';

    for (const state of [emptyState(), partial, finished]) {
      expect(isComplete(state)).toBe(nextStep(state) === null);
    }
  });
});
