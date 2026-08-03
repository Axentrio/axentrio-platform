import type { UseMutationResult } from '@tanstack/react-query';
import type { SetupStatus, SubmitStepInput } from '@/queries/useOnboardingQueries';

/**
 * Every step screen submits through the same mutation, so the wizard shell owns the
 * pending state and the cache update, and a step only decides WHAT to send.
 */
export interface StepProps {
  submit: UseMutationResult<SetupStatus, unknown, SubmitStepInput, unknown>;
}
