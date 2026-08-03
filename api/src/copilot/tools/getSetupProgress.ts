/**
 * Copilot tool: getSetupProgress
 *
 * The one thing in the spec's context list that had no tool behind it. Without it the
 * assistant can describe how to set something up but has no idea whether the customer
 * already did — so "how do I upload documents?" gets the same answer whether they have
 * none or forty, and the proactive nudges the spec asks for ("Your knowledge base is
 * still empty") cannot be grounded in anything.
 *
 * Reads the recorded first-run wizard state, not a re-derivation of it. What the customer
 * ANSWERED is the fact worth reporting: a step they explicitly skipped is a decision the
 * assistant should respect rather than nag about, which a live "is bookings configured"
 * check could not distinguish from "not got to it yet".
 *
 * Returns the shape of setup only — step names and outcomes. No company details, no VAT
 * number, no addresses; the record contains them and they are none of the model's
 * business (invariant #8).
 */
import { Tenant } from '../../database/entities/Tenant';
import {
  ONBOARDING_STEPS,
  isComplete,
  nextStep,
  type OnboardingStep,
  type StepOutcome,
} from '../../onboarding/onboarding-state';
import type { CopilotTool, CopilotToolContext } from './types';

export interface SetupProgressResult {
  /** True once setup is finished — including workspaces that predate the wizard. */
  complete: boolean;
  /** Set only for a workspace that predates the wizard and never answered it. */
  grandfathered: boolean;
  /** The step still outstanding, or null. */
  nextStep: OnboardingStep | null;
  answered: OnboardingStep[];
  /** Explicit declines. The assistant should treat these as decisions, not omissions. */
  skipped: OnboardingStep[];
  notYetReached: OnboardingStep[];
}

export const getSetupProgress: CopilotTool<Record<string, never>, SetupProgressResult> = {
  name: 'getSetupProgress',
  description:
    "Return how far the tenant got through first-run setup: whether it is complete, which step is outstanding, and which steps they answered vs explicitly skipped. Steps are: language, company, logo, chatbot, documents, social, bookings, leads, plan. A SKIPPED step is a deliberate decision by the customer — do not nag about it; mention it only if they ask about that feature. Use this before suggesting setup work, so you never tell someone to do something they have already done.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },

  async execute(_args, ctx: CopilotToolContext): Promise<SetupProgressResult> {
    const tenant = await ctx.manager.findOne(Tenant, {
      where: { id: ctx.tenantId },
      select: ['id', 'settings'],
    });
    if (!tenant) throw new Error(`getSetupProgress: tenant ${ctx.tenantId} not found`);

    const state = tenant.settings?.onboarding ?? null;
    if (!state) {
      // No record at all: a workspace that has not started. Every step is ahead of it.
      return {
        complete: false,
        grandfathered: false,
        nextStep: ONBOARDING_STEPS[0],
        answered: [],
        skipped: [],
        notYetReached: [...ONBOARDING_STEPS],
      };
    }

    const outcomeOf = (s: OnboardingStep): StepOutcome | undefined => state.steps?.[s];

    return {
      complete: isComplete(state),
      grandfathered: state.grandfathered === true,
      nextStep: nextStep(state),
      answered: ONBOARDING_STEPS.filter((s) => outcomeOf(s) === 'done'),
      skipped: ONBOARDING_STEPS.filter((s) => outcomeOf(s) === 'skipped'),
      notYetReached: ONBOARDING_STEPS.filter((s) => !outcomeOf(s)),
    };
  },
};
