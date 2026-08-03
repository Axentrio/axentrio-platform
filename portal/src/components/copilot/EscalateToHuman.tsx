/**
 * "Talk to a person" — the way out of a conversation the assistant cannot finish.
 *
 * The assistant is read-only and says "I don't know" rather than inventing. Without this
 * the honesty is a dead end: the customer is told nobody can help and left to hunt for an
 * address. So the exit sits under every conversation, not only after a failure.
 *
 * Collapsed to a single line until asked for, because it is not the point of the drawer —
 * a support form permanently occupying the bottom of the panel implies the assistant is
 * expected to fail.
 *
 * The transcript travels with the request but is read SERVER-side. Support has to receive
 * what actually happened, not what a client chose to attach.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, LifeBuoy, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@components/ui/textarea';
import { useEscalateToSupport } from '@/queries/useCopilotQueries';
import { extractApiErrorMessage } from '@/services/apiClient';

export function EscalateToHuman() {
  const { t } = useTranslation();
  const escalate = useEscalateToSupport();
  const [open, setOpen] = React.useState(false);
  const [message, setMessage] = React.useState('');

  if (escalate.isSuccess) {
    return (
      <div className="flex items-start gap-2 border-t border-edge px-4 py-3 text-sm text-status-online">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <p>{t('copilot.escalate.sent', { inbox: escalate.data.inbox })}</p>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="border-t border-edge px-4 py-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 text-xs text-text-tertiary transition-colors hover:text-text-secondary"
        >
          <LifeBuoy className="h-3.5 w-3.5" />
          {t('copilot.escalate.open')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-edge px-4 py-3">
      <p className="text-xs text-text-secondary">{t('copilot.escalate.prompt')}</p>
      <Textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        maxLength={4000}
        placeholder={t('copilot.escalate.placeholder')}
        className="resize-none text-sm"
      />
      {escalate.isError && (
        <p role="alert" className="text-xs text-status-error">
          {extractApiErrorMessage(escalate.error) ?? t('copilot.escalate.failed')}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={escalate.isPending}>
          {t('common.cancel')}
        </Button>
        <Button
          size="sm"
          onClick={() => escalate.mutate(message.trim())}
          disabled={message.trim().length === 0 || escalate.isPending}
        >
          {escalate.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {t('copilot.escalate.send')}
        </Button>
      </div>
    </div>
  );
}
