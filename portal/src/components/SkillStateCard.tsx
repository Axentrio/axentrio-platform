/**
 * SkillStateCard — tenant-facing per-skill state (composable-templates Phase 6).
 *
 * Signature element of the composable-templates UI: a colour-coded STATE DOT that
 * turns the skill-state machine into a glanceable "is this capability live?" signal.
 * The dot answers "healthy?"; the pill carries the plain-English action ("Finish
 * setup", "Upgrade plan", "Ready"); when ready, the tools the bot can actually call
 * are listed in mono (machine identifiers), indented under the name.
 *
 * `absent` skills never reach this component — the API omits them.
 */
import type { SkillReadinessDto, SkillState } from '@contracts/skill-readiness';

// Plain-English action per state (the wire `remedy` is the machine form).
const REMEDY_TEXT: Record<SkillState, string> = {
  ready: 'Ready',
  unentitled: 'Upgrade plan',
  disabled: 'Enable in settings',
  unconfigured: 'Finish setup',
  absent: '—',
  error: '—',
};

// The status ramp, one hue per meaning: green = live, amber = needs a tenant
// action, red = error, muted = not offered. Same hues across the dot + pill.
const STATE_DOT: Record<SkillState, string> = {
  ready: 'bg-emerald-400 ring-2 ring-emerald-400/25',
  unentitled: 'bg-amber-400',
  disabled: 'bg-amber-400',
  unconfigured: 'bg-amber-400',
  error: 'bg-red-400',
  absent: 'bg-surface-4',
};
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
  const showTools = skill.state === 'ready' && !!readyTools?.length;
  return (
    <div className="rounded-lg border border-edge bg-surface-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[skill.state]}`}
          />
          <span className="truncate text-sm font-medium text-text-primary">{skill.name}</span>
        </div>
        <span
          data-testid="skill-state-badge"
          data-state={skill.state}
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATE_BADGE_CLASS[skill.state]}`}
        >
          {REMEDY_TEXT[skill.state]}
        </span>
      </div>
      {showTools && (
        <ul className="mt-2 flex flex-wrap gap-1 pl-4">
          {readyTools!.map((tool) => (
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
