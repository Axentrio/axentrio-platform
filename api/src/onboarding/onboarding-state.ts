/**
 * First-run setup: what a new workspace must answer before it can use the platform.
 *
 * The product decision this encodes is that onboarding CANNOT BE SKIPPED, which makes
 * this the only thing standing between a new customer and the product. So the rules
 * live here, pure and dependency-free, rather than being spread across a wizard's
 * components where "can they continue" would be re-derived slightly differently on each
 * screen.
 *
 * TWO KINDS OF STEP, and the difference matters:
 *
 *   REQUIRED   — language, company, documents. There is no way past these. A workspace
 *                without a knowledge document has a bot that cannot answer anything, so
 *                letting someone finish setup without one only defers the disappointment.
 *   OPTIONAL   — chatbot, social, bookings, leads. Skipping is a real answer: it SWITCHES
 *                THE FEATURE OFF rather than leaving it half-configured. A tenant who
 *                said "not now" to bookings should not have a booking surface quietly
 *                waiting to confuse them.
 *
 * GRANDFATHERING. Existing tenants are stamped complete by migration. Absent state means
 * a genuinely new workspace, so nobody who has been using the product for months is ever
 * trapped in a setup wizard on their next login.
 */

export const ONBOARDING_VERSION = 1;

export type OnboardingLanguage = 'nl' | 'fr' | 'en';

/** Ordered: this IS the sequence the wizard walks. */
export const ONBOARDING_STEPS = [
  'language',
  'company',
  'logo',
  'chatbot',
  'documents',
  'social',
  'bookings',
  'leads',
  'plan',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Steps with no way past them. */
export const REQUIRED_STEPS: readonly OnboardingStep[] = ['language', 'company', 'documents', 'plan'];

/**
 * Skipping these switches the matching features OFF, using the SAME tenant feature
 * toggles the Settings → Features screen writes — so "not now" during setup and "off"
 * later are one decision with one source of truth.
 *
 * Every key here is checked against TENANT_TOGGLEABLE_FEATURES by a test. Naming a
 * toggle that does not exist would write a key nothing reads: a skip that silently did
 * nothing, which is worse than not offering the choice.
 *
 * `chatbot` is deliberately absent. There is no toggleable feature for it — the website
 * assistant is `settings.ai.enabled` on the tenant, not an entitlement — so skipping it
 * is handled by the route rather than pretended to be a toggle here.
 */
export const SKIP_DISABLES: Partial<Record<OnboardingStep, readonly string[]>> = {
  social: ['channelWhatsapp', 'channelMessenger', 'channelInstagram', 'channelTelegram'],
  bookings: ['bookings'],
  leads: ['leadCapture'],
};

export type StepOutcome = 'done' | 'skipped';

export interface OnboardingCompany {
  vatNumber: string;
  name: string;
  legalForm: string | null;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  /**
   * True when the register confirmed the number. False when the customer typed the
   * details because the register was unreachable — recorded rather than hidden, so a
   * later fraud question has an honest answer instead of a silent assumption.
   */
  verified: boolean;
}

export interface OnboardingState {
  version: number;
  startedAt: string;
  completedAt: string | null;
  /** Set by migration on tenants that predate onboarding; never set by the wizard. */
  grandfathered?: boolean;
  language: OnboardingLanguage | null;
  company: OnboardingCompany | null;
  steps: Partial<Record<OnboardingStep, StepOutcome>>;
}

export function emptyState(now = new Date()): OnboardingState {
  return {
    version: ONBOARDING_VERSION,
    startedAt: now.toISOString(),
    completedAt: null,
    language: null,
    company: null,
    steps: {},
  };
}

/**
 * A step counts as answered when the wizard recorded an outcome for it. Language and
 * company additionally have to carry their DATA — a `done` marker with no company on the
 * record would let someone through with an empty workspace, and the marker is the thing
 * a client controls.
 */
export function isStepSatisfied(state: OnboardingState, step: OnboardingStep): boolean {
  const outcome = state.steps[step];
  if (!outcome) return false;
  if (step === 'language') return state.language != null;
  if (step === 'company') return state.company != null;
  // Required steps cannot be satisfied by skipping them — see nextStep.
  if (REQUIRED_STEPS.includes(step) && outcome === 'skipped') return false;
  return true;
}

/**
 * The first step still unanswered, or null when setup is finished.
 *
 * A stamped `completedAt` ends it outright, without consulting the individual steps.
 * Grandfathered tenants are exactly this case: they are complete and have answered
 * nothing, and reading their unanswered steps literally would route a customer of two
 * years into a wizard asking for their VAT number.
 *
 * Keeping the check here rather than only in `isComplete` holds the invariant
 * `isComplete(s) === (nextStep(s) === null)` for every state, so a caller that reads only
 * one of the two cannot reach a different conclusion than a caller that reads the other.
 */
export function nextStep(state: OnboardingState): OnboardingStep | null {
  if (state.completedAt) return null;
  return ONBOARDING_STEPS.find((s) => !isStepSatisfied(state, s)) ?? null;
}

export function isComplete(state: OnboardingState | null | undefined): boolean {
  if (!state) return false;
  if (state.completedAt) return true;
  return nextStep(state) === null;
}

/**
 * Whether this workspace has to be sent through setup.
 *
 * Absent state means a new workspace. Existing tenants were stamped complete by
 * migration, so "no record" cannot be mistaken for "never finished" by someone who has
 * been using the product since before this shipped.
 */
export function requiresOnboarding(state: OnboardingState | null | undefined): boolean {
  return !isComplete(state);
}

export type StepRejection = { ok: false; reason: string };
export type StepAcceptance = { ok: true };

/**
 * Guard a step submission. Rejects rather than silently coercing: a wizard that accepts
 * a skip on a required step and then refuses to finish is worse than one that says no at
 * the moment the choice is made.
 */
export function validateStepSubmission(
  step: OnboardingStep,
  outcome: StepOutcome,
): StepAcceptance | StepRejection {
  if (!ONBOARDING_STEPS.includes(step)) return { ok: false, reason: `Unknown step: ${step}` };
  if (outcome === 'skipped' && REQUIRED_STEPS.includes(step)) {
    return { ok: false, reason: `The ${step} step cannot be skipped` };
  }
  return { ok: true };
}
