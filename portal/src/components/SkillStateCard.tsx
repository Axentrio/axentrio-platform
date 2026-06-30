/**
 * SkillStateCard — tenant-facing per-skill state badge (composable-templates
 * Phase 6). Shows a bound skill's name, a colour-coded state badge whose text is
 * the plain-English remedy ("Finish setup", "Upgrade plan", "Ready"), and — when
 * ready — the tools the bot can actually use for it (kb_search, create_booking…).
 *
 * State drives the badge COLOUR; the wire `remedy` is mapped to display copy here
 * (the API carries the machine-level remedy; the upsell/links are deferred to
 * Phase 6.5). `absent` skills never reach this component — the API omits them.
 */
import type { SkillReadinessDto, SkillState } from '@contracts/skill-readiness';

// Plain-English action per state (the wire `remedy` is the machine form). Mirrors
// the spec mapping; `ready` shows "Ready", non-actionable states show an em dash.
const REMEDY_TEXT: Record<SkillState, string> = {
  ready: 'Ready',
  unentitled: 'Upgrade plan',
  disabled: 'Enable in settings',
  unconfigured: 'Finish setup',
  absent: '—',
  error: '—',
};

// Badge colour by state: green = live, amber = needs a tenant action, red = error.
const STATE_BADGE_CLASS: Record<SkillState, string> = {
  ready: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  unentitled: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  disabled: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  unconfigured: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  error: 'bg-red-500/15 text-red-400 border-red-500/30',
  absent: 'bg-surface-3 text-text-muted border-edge',
};

interface SkillStateCardProps {
  skill: SkillReadinessDto;
  /** Tools the skill exposes when ready (e.g. kb_search, create_booking). Shown
   *  only in the `ready` state; optional because the readiness DTO omits them. */
  readyTools?: string[];
}

export function SkillStateCard({ skill, readyTools }: SkillStateCardProps) {
  return (
    <div className="rounded-lg border border-edge bg-surface-2 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-text-primary">{skill.name}</span>
        <span
          data-testid="skill-state-badge"
          data-state={skill.state}
          className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATE_BADGE_CLASS[skill.state]}`}
        >
          {REMEDY_TEXT[skill.state]}
        </span>
      </div>
      {skill.state === 'ready' && readyTools && readyTools.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1">
          {readyTools.map((tool) => (
            <li
              key={tool}
              className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-text-muted"
            >
              {tool}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default SkillStateCard;
