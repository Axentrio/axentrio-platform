/**
 * SkillCoverageWarning — "you pay for this, and this bot can't do it".
 *
 * The tenant-facing half of the entitled-but-undelivered diagnostic
 * (api/src/modules/skill-coverage.ts). The failure it makes visible, from
 * production: a Pro tenant's bot bound a template that selected only the booking
 * skill, so the agent's template tool-gate stripped `capture_lead` — their
 * `leadCapture` entitlement was on, they paid for Leads, and the bot silently
 * never captured one.
 *
 * ONE alert listing every affected feature, not one alert per skill. `handoff` is
 * entitled on every paid tier, so a bot on any booking-only speciality trips at
 * least two of these at once; stacking a separate amber block per skill turned a
 * real signal into a wall the operator learns to scroll past.
 *
 * Deliberately NOT dismissible (unlike BookingSetupBanner): this is a
 * misconfiguration costing the tenant money, not an onboarding nudge. It sits in
 * the speciality-binding section because that is where the tenant-actionable fix is.
 *
 * The remedy names only what a workspace admin can actually DO. Editing which skills
 * a speciality contains is a super-admin action (the admin template routes sit behind
 * requireSuperAdmin), so telling them to "ask your admin to add it" would be sending
 * them to a screen they cannot reach. Binding a different speciality is theirs.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import type { UnselectedEntitledSkill } from '@/queries/useReadinessQueries';

export interface SkillCoverageWarningProps {
  skills: UnselectedEntitledSkill[] | undefined;
}

export const SkillCoverageWarning: React.FC<SkillCoverageWarningProps> = ({ skills }) => {
  const { t } = useTranslation();
  if (!skills?.length) return null;

  // Plan-facing feature name (e.g. leadCapture → "Leads"), falling back to the skill's
  // own label for features the settings screen doesn't list.
  const featureLabels = skills.map((s) =>
    t(`features.keys.${s.feature}.label`, { defaultValue: s.skillName }),
  );

  return (
    <div
      data-testid="skill-coverage-warning"
      data-skills={skills.map((s) => s.skillId).join(',')}
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-text-primary">
          {t('ai.bot.template.warnings.unselectedEntitled.title', {
            defaultValue: "Your plan includes {{features}}, but this bot won't use them",
            count: skills.length,
            features: featureLabels.join(', '),
          })}
        </p>
        <p className="mt-0.5 text-xs text-text-muted">
          {t('ai.bot.template.warnings.unselectedEntitled.body', {
            defaultValue:
              'No speciality bound to this bot includes the {{skills}} skill, so the bot never receives it. Bind a speciality above that lists it, or contact support if you need it added to the speciality you use.',
            skills: skills.map((s) => s.skillName).join(', '),
          })}
        </p>
      </div>
    </div>
  );
};

export default SkillCoverageWarning;
