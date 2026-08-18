/**
 * First-run setup.
 *
 * This is the only thing between a new customer and the product, so it is built to be
 * finished rather than admired: one question per screen, the consequence of every choice
 * stated in plain words, and no dead ends.
 *
 * Two rules it holds:
 *
 *   NOTHING IS HIDDEN. Skipping an optional step switches that feature off — the screen
 *   says so before the click, not after, because "not now" and "off" are the same
 *   decision and the customer should know they are making it.
 *
 *   NOTHING IS FAKED. Required steps are refused by the server until the real thing
 *   exists, so this screen never claims progress the workspace does not have.
 *
 * Visual language is the product's own — Card, the surface/edge tokens, the same button
 * variants as Settings — so setup looks like the place the customer is about to enter.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, ChevronLeft, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { cn } from '@/lib/utils';
import { extractApiErrorMessage } from '@/services/apiClient';
import {
  SETUP_STEPS,
  useCompleteSetup,
  useSetupStatus,
  useSubmitSetupStep,
  type SetupStep,
} from '@/queries/useOnboardingQueries';
import { LanguageStep } from './steps/LanguageStep';
import { CompanyStep } from './steps/CompanyStep';
import { LogoStep } from './steps/LogoStep';
import { DocumentsStep } from './steps/DocumentsStep';
import { PlanStep } from './steps/PlanStep';
import { ChatbotStep } from './steps/ChatbotStep';
import { ChoiceStep } from './steps/ChoiceStep';
import { BookingsStep } from './steps/BookingsStep';

/**
 * Steps with no way past them. Mirrors REQUIRED_STEPS on the server, which is the
 * enforcing copy — this one only decides whether to draw a Skip button.
 */
const REQUIRED: readonly SetupStep[] = ['language', 'company', 'documents', 'plan'];

export default function SetupWizard() {
  const { t } = useTranslation();
  const { data: status, isLoading } = useSetupStatus();
  const submitStep = useSubmitSetupStep();
  const completeSetup = useCompleteSetup();

  /**
   * Which screen to show. Defaults to whatever the server says is outstanding; a
   * customer who steps back to revisit an answer overrides it until they move on.
   */
  const [revisiting, setRevisiting] = React.useState<SetupStep | null>(null);
  const active = revisiting ?? status?.nextStep ?? null;

  /**
   * Answering ANY step hands control back to the server's ordering, so finishing a
   * revisit continues forward instead of sticking on that screen.
   *
   * Keyed off a completed submission, NOT off "this step has an outcome". The rail only
   * offers steps that are already answered, so the outcome test was true the instant
   * they clicked — it cleared `revisiting` before the screen could render and back
   * navigation did nothing at all.
   */
  const handledSubmission = React.useRef<unknown>(null);
  React.useEffect(() => {
    if (!submitStep.data || submitStep.data === handledSubmission.current) return;
    handledSubmission.current = submitStep.data;
    setRevisiting(null);
  }, [submitStep.data]);

  // SetupGate decides whether this screen is shown at all, so there is no
  // "already finished" branch here — one owner for that question, not two.
  if (isLoading || !status) return <PageSkeleton variant="list" rows={4} />;

  const answered = SETUP_STEPS.filter((s) => status.state.steps[s]).length;
  const index = active ? SETUP_STEPS.indexOf(active) : 0;
  const canSkip = active != null && !REQUIRED.includes(active);
  const busy = submitStep.isPending || completeSetup.isPending;

  const skip = () => active && submitStep.mutate({ step: active, outcome: 'skipped' });

  /**
   * A refused submission must SAY so. Only 402s get a global toast, so without this a
   * customer whose step the server rejected — an unverifiable answer, a document that
   * is not there — clicks Continue and watches nothing happen, on the one screen they
   * cannot navigate away from.
   */
  const refusal =
    extractApiErrorMessage(submitStep.error) ?? extractApiErrorMessage(completeSetup.error);

  const stepScreen = () => {
    switch (active) {
      case 'language':
        return <LanguageStep status={status} submit={submitStep} />;
      case 'company':
        return <CompanyStep status={status} submit={submitStep} />;
      case 'logo':
        return <LogoStep submit={submitStep} />;
      case 'documents':
        return <DocumentsStep submit={submitStep} />;
      case 'plan':
        return <PlanStep submit={submitStep} />;
      case 'chatbot':
        return <ChatbotStep status={status} submit={submitStep} />;
      case 'bookings':
        return <BookingsStep submit={submitStep} />;
      case 'social':
      case 'leads':
        return <ChoiceStep step={active} submit={submitStep} />;
      default:
        // Every step answered but not yet finalised.
        return (
          <div className="space-y-4 text-center">
            <h2 className="text-xl font-semibold text-text-primary">{t('setup.finish.title')}</h2>
            <p className="text-sm text-text-secondary">{t('setup.finish.body')}</p>
            <Button onClick={() => completeSetup.mutate()} disabled={busy} size="lg">
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('setup.finish.action')}
            </Button>
          </div>
        );
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-10">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <header className="space-y-3">
          <p className="text-sm text-text-secondary">
            {t('setup.progress', { current: index + 1, total: SETUP_STEPS.length })}
          </p>
          {/* The rail doubles as navigation: answered steps are revisitable, the rest
              are markers. Nothing ahead is clickable — the order is the point. */}
          <ol className="flex flex-wrap gap-1.5" aria-label={t('setup.progressLabel')}>
            {SETUP_STEPS.map((step) => {
              const done = Boolean(status.state.steps[step]);
              const isActive = step === active;
              return (
                <li key={step} className="flex-1 min-w-[1.5rem]">
                  <button
                    type="button"
                    disabled={!done || busy}
                    onClick={() => setRevisiting(step)}
                    aria-current={isActive ? 'step' : undefined}
                    title={t(`setup.steps.${step}.title`)}
                    className={cn(
                      'h-1.5 w-full rounded-full transition-colors',
                      isActive ? 'bg-primary-500' : done ? 'bg-primary-500/40' : 'bg-surface-2',
                      done && !isActive && 'hover:bg-primary-500/70 cursor-pointer',
                    )}
                  >
                    <span className="sr-only">{t(`setup.steps.${step}.title`)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </header>

        {refusal && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {refusal}
          </div>
        )}

        <Card variant="glass" className="p-6 sm:p-8">
          {stepScreen()}
        </Card>

        <div className="flex items-center justify-between gap-3">
          <div>
            {revisiting && (
              <Button variant="ghost" size="sm" onClick={() => setRevisiting(null)} disabled={busy}>
                <ChevronLeft className="mr-1 h-4 w-4" />
                {t('setup.backToCurrent')}
              </Button>
            )}
          </div>
          {canSkip && (
            <div className="text-right">
              <Button variant="ghost" size="sm" onClick={skip} disabled={busy}>
                {t('setup.skip')}
              </Button>
              {/* Say what skipping costs BEFORE the click. */}
              <p className="mt-1 text-xs text-text-muted">
                {t(`setup.steps.${active}.skipConsequence`)}
              </p>
            </div>
          )}
        </div>

        {answered > 0 && (
          <p className="flex items-center justify-center gap-1.5 text-xs text-text-muted">
            <Check className="h-3.5 w-3.5" />
            {t('setup.answeredCount', { count: answered })}
          </p>
        )}
      </div>
    </div>
  );
}
