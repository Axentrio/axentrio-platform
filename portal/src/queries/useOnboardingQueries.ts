/**
 * Onboarding — two different things share this name, and keeping them apart matters.
 *
 *   CHECKLIST (`useOnboardingChecklist`) — a derived "how set up are you" score,
 *              recomputed from live config. Powers the dashboard banner, shown forever,
 *              never blocks anything.
 *   SETUP     (`useSetupStatus` and friends) — the recorded state of the first-run
 *              wizard. Answered once, and it GATES the product until it is finished.
 *
 * The shapes below mirror the backend contract in api/src/onboarding/onboarding-state.ts.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface OnboardingSteps {
  aiEnabled: boolean;
  brandVoiceConfigured: boolean;
  knowledgeBaseHasDocs: boolean;
  calcomConnected: boolean;
  automationsConfigured: boolean;
  firstConversation: boolean;
  [key: string]: boolean;
}

interface OnboardingChecklistResponse {
  complete: boolean;
  completedCount: number;
  totalCount: number;
  steps: OnboardingSteps;
}

interface AvailableToolsResponse {
  tools: Any[];
}

export function useOnboardingChecklist() {
  return useQuery({
    queryKey: queryKeys.onboarding.checklist(),
    queryFn: () => api.get<OnboardingChecklistResponse>('/tenants/me/onboarding-status'),
  });
}

export function useAvailableTools() {
  return useQuery({
    queryKey: [...queryKeys.onboarding.all(), 'available-tools'],
    queryFn: () => api.get<AvailableToolsResponse>('/tenants/me/available-tools'),
  });
}

// ---------------------------------------------------------------------------
// First-run setup wizard
// ---------------------------------------------------------------------------

export const SETUP_STEPS = [
  'language',
  'company',
  'logo',
  'chatbot',
  'documents',
  'plan',
  'bookings',
  'leads',
  'social',
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];
export type SetupLanguage = 'nl' | 'fr' | 'en';
export type StepOutcome = 'done' | 'skipped';

export interface SetupCompany {
  vatNumber: string;
  name: string;
  legalForm?: string | null;
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  /** Server-decided from the register. Sending it has no effect. */
  verified?: boolean;
  /** #153 — business presence; online shops can disable the default-on quoted address. */
  presence?: 'online' | 'physical';
}

export interface SetupState {
  version: number;
  startedAt: string;
  completedAt: string | null;
  grandfathered?: boolean;
  language: SetupLanguage | null;
  company: SetupCompany | null;
  steps: Partial<Record<SetupStep, StepOutcome>>;
}

export interface SetupStatus {
  state: SetupState;
  nextStep: SetupStep | null;
  complete: boolean;
}

export function useSetupStatus() {
  return useQuery({
    queryKey: queryKeys.onboarding.setup(),
    queryFn: () => api.get<SetupStatus>('/onboarding/status'),
    // Read on every page load by the routing guard. It only changes when this same
    // client writes it, and every write pushes the fresh state into the cache.
    staleTime: 5 * 60 * 1000,
  });
}

export interface SubmitStepInput {
  step: SetupStep;
  outcome?: StepOutcome;
  language?: SetupLanguage;
  company?: SetupCompany;
}

export function useSubmitSetupStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SubmitStepInput) =>
      api.put<SetupStatus>('/onboarding/step', { outcome: 'done', ...input }),
    onSuccess: (status) => {
      qc.setQueryData(queryKeys.onboarding.setup(), status);
      // Skipping a step switches features off server-side, so cached entitlements
      // are stale the moment this returns.
      void qc.invalidateQueries({ queryKey: queryKeys.entitlements.all() });
    },
  });
}

export function useCompleteSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<SetupStatus>('/onboarding/complete'),
    onSuccess: (status) => qc.setQueryData(queryKeys.onboarding.setup(), status),
  });
}

export type CompanyLookupStatus = 'found' | 'not_found' | 'invalid_format' | 'unavailable';

export interface CompanyLookupResult {
  status: CompanyLookupStatus;
  company: (SetupCompany & { enterpriseNumber: string; countryCode: 'BE' }) | null;
  cached: boolean;
}

/**
 * A mutation rather than a query: the customer decides when to look up, and a
 * keystroke-triggered query would fire multi-second calls at a government register.
 */
export function useCompanyLookup() {
  return useMutation({
    mutationFn: (vat: string) =>
      api.get<CompanyLookupResult>(`/onboarding/company-lookup?vat=${encodeURIComponent(vat)}`),
  });
}
