/**
 * "What should I do next with this lead?" — shown inside an expanded lead row.
 *
 * The recommendation is computed server-side from the lead's own facts (followup.ts),
 * not by a model, so this component only has to render it honestly:
 *
 *  - the reasons are shown, always. A suggested action with no stated cause is exactly
 *    the unexplainable AI verdict the readiness score was designed to avoid.
 *  - the copy never claims anything happened. Nothing is sent, queued or logged here.
 *
 * ADVISORY ONLY, and deliberately not actionable in this slice: there is no worklist and
 * no follow-up state, so there is nothing to mark done and no "Snooze" that could
 * persist. A control that silently forgot its own state would be worse than no control.
 * Do not add one here before the worklist exists to back it.
 *
 * Renders nothing when `followUp` is absent — the server omits the key entirely for a
 * tenant without `aiBusinessInsights`, which is what keeps this off their screen.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Mail, MessageSquare, Phone } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { FollowUpRecommendation } from '@/queries/useLeadsQueries';

const VIA_ICON = { phone: Phone, channel: MessageSquare, email: Mail } as const;

/** English fallbacks live next to the keys they back, so a missing locale still reads. */
const ACTION_FALLBACK: Record<FollowUpRecommendation['action'], string> = {
  confirm_request: 'Confirm or decline the slot they asked for',
  win_back_cancelled: 'Offer them a new time — their booking was cancelled',
  check_in_after_visit: 'Check they were happy with the visit',
  offer_a_time: 'Get back to them with a time',
  ask_what_they_need: 'Ask what they need',
};

export const LeadFollowUp: React.FC<{ followUp: FollowUpRecommendation | null | undefined }> = ({
  followUp,
}) => {
  const { t } = useTranslation();
  if (!followUp) return null;

  const Icon = VIA_ICON[followUp.via];
  const urgent = followUp.priority === 'now';

  return (
    <div className="rounded-lg border border-edge bg-surface-1 p-2.5">
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${urgent ? 'text-destructive' : 'text-text-muted'}`} />
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-text-primary">
              {t(`leads.followUp.actions.${followUp.action}`, {
                defaultValue: ACTION_FALLBACK[followUp.action],
              })}
            </span>
            <Badge variant={urgent ? 'warning' : 'secondary'}>
              {t(`leads.followUp.priority.${followUp.priority}`, {
                defaultValue: urgent ? 'Today' : 'This week',
              })}
            </Badge>
          </div>

          {/* Every recommendation states the facts it came from — without them this is
              an opinion about someone's customer that nobody can check. */}
          <p className="text-text-secondary">
            <span className="font-medium">
              {t('leads.followUp.becauseLabel', { defaultValue: 'Because' })}:
            </span>{' '}
            {followUp.reasons
              .map((r) =>
                t(`leads.followUp.reasons.${r.key}`, { defaultValue: r.label, days: r.days }),
              )
              .join(' · ')}
          </p>

          {/* Says plainly that this is a suggestion and nothing has been done about it,
              so nobody assumes the platform already chased the customer. */}
          <p className="text-text-muted">
            {t('leads.followUp.advisory', {
              defaultValue:
                'Worked out from this lead’s own details. Nothing has been sent — this is a suggestion only.',
            })}
          </p>
        </div>
      </div>
    </div>
  );
};
