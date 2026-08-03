/**
 * What the assistant offers before being asked.
 *
 * The spec asks for proactive recommendations — "Your knowledge base is still empty",
 * "Your booking system is not connected yet". The difference between that and the static
 * example questions this replaces is that these are TRUE: they come from the readiness
 * endpoint, which already computes exactly this (what is missing, and where to fix it)
 * for the dashboard.
 *
 * Deriving them rather than writing them means the panel goes quiet on its own once a
 * workspace is set up, instead of nagging someone who finished last week — and a
 * suggestion that survives being finished is how a helpful panel becomes wallpaper.
 *
 * Falls back to the example questions when there is nothing to suggest, because an empty
 * drawer teaches nobody what the assistant is for.
 */
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles } from 'lucide-react';
import { useBotReadiness } from '@/queries/useReadinessQueries';

/** At most this many. A list of chores reads as a lecture. */
const MAX_SUGGESTIONS = 3;

interface Suggestion {
  key: string;
  label: string;
  route?: string;
  cta?: string;
}

export function CopilotSuggestions({ onAsk }: { onAsk: (question: string) => void }) {
  const { t } = useTranslation();
  const { data: readiness } = useBotReadiness();

  const suggestions: Suggestion[] = (readiness?.capabilities ?? [])
    .filter((c) => c.state !== 'live')
    .flatMap((c) =>
      c.missingSteps.map((step) => ({
        key: `${c.capability}:${step.id}`,
        label: step.label,
        route: step.cta?.route,
        cta: step.cta?.label,
      })),
    )
    .slice(0, MAX_SUGGESTIONS);

  if (suggestions.length === 0) {
    return (
      <ul className="mt-3 list-disc space-y-1 pl-5 text-text-tertiary">
        {(t('copilot.drawer.welcome.examples', { returnObjects: true }) as string[]).map((s) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => onAsk(s)}
              className="text-left transition-colors hover:text-text-secondary"
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <p className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
        <Sparkles className="h-3.5 w-3.5 text-primary-400" />
        {t('copilot.suggestions.title')}
      </p>
      <ul className="space-y-1.5">
        {suggestions.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-2 text-text-tertiary">
            <span className="min-w-0 truncate">{s.label}</span>
            {s.route && (
              <Link
                to={s.route}
                className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary-400 hover:text-primary-300"
              >
                {s.cta ?? t('copilot.suggestions.go')}
                <ArrowRight className="h-3 w-3" />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
