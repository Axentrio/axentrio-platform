/**
 * HumanControl — B-PR5b timed human-control UI.
 *
 *  - TakeoverMenu: the ONE duration menu (indefinite + 1/2/4/8/12/24h) reused
 *    by "Take Over" and "Change duration". It only EMITS the chosen policy;
 *    the caller owns the wire payload (Inbox maps an initial indefinite pick
 *    to the modeless legacy body, and a change-duration pick to an explicit
 *    { mode, hours? } — the backend treats a same-owner re-claim with an
 *    explicit mode as a policy update).
 *  - HumanControlBadge: "AI paused" + a live countdown to humanControlUntil.
 *    The 1-second interval lives INSIDE the timed badge, so a tick re-renders
 *    only the badge — never the window around it. The client NEVER releases
 *    at 0: it shows "resuming…" and waits for the server's upsert to flip
 *    ownership (the expiry worker owns the deadline).
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Timer } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  TAKEOVER_HOURS,
  WARNING_THRESHOLD_MS,
  formatRemaining,
  type TakeoverPolicy,
} from '@utils/humanControl';

// ---------------------------------------------------------------------------
// TakeoverMenu
// ---------------------------------------------------------------------------

interface TakeoverMenuProps {
  /** The trigger button — rendered via Radix `asChild`. */
  trigger: React.ReactElement;
  onSelect: (policy: TakeoverPolicy) => void;
  /** Tenant default — marked in the menu so the operator sees the preselection. */
  defaultPolicy?: TakeoverPolicy;
}

function isDefaultPick(policy: TakeoverPolicy, fallback: TakeoverPolicy | undefined): boolean {
  if (!fallback) return policy.mode === 'indefinite';
  if (policy.mode === 'indefinite' || fallback.mode === 'indefinite') {
    return policy.mode === fallback.mode;
  }
  return policy.hours === fallback.hours;
}

export const TakeoverMenu: React.FC<TakeoverMenuProps> = ({ trigger, onSelect, defaultPolicy }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [customHours, setCustomHours] = useState('');

  const applyCustomHours = () => {
    const hours = Number(customHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24) return;
    onSelect({ mode: 'timed', hours });
    setOpen(false);
    setCustomHours('');
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          data-default={isDefaultPick({ mode: 'indefinite' }, defaultPolicy) ? 'true' : undefined}
          onClick={() => onSelect({ mode: 'indefinite' })}
        >
          {t('inbox.takeover.indefinite')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {TAKEOVER_HOURS.map((hours) => (
          <DropdownMenuItem
            key={hours}
            data-default={isDefaultPick({ mode: 'timed', hours }, defaultPolicy) ? 'true' : undefined}
            onClick={() => onSelect({ mode: 'timed', hours })}
          >
            {t('inbox.takeover.forHours', { count: hours })}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => e.preventDefault()}
          className="focus:bg-transparent"
        >
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              applyCustomHours();
            }}
          >
            <input
              type="number"
              min={1}
              max={24}
              step={1}
              value={customHours}
              onChange={(e) => setCustomHours(e.target.value)}
              placeholder={t('inbox.takeover.customHours')}
              aria-label={t('inbox.takeover.customHours')}
              className="w-24 rounded-md border border-edge bg-surface-3 px-2 py-1 text-xs text-text-primary"
            />
            <button type="submit" className="text-xs font-medium text-primary-400">
              {t('inbox.takeover.customHoursApply')}
            </button>
          </form>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

// ---------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------

/**
 * Ticks once a second toward `until`. The interval stops itself at 0 (no dead
 * timer while "resuming…" waits for the server) and is cleared on unmount and
 * whenever `until` changes (a duration change re-arms it).
 */
function useCountdown(until: string): number {
  const [remaining, setRemaining] = useState(() => new Date(until).getTime() - Date.now());
  useEffect(() => {
    const target = new Date(until).getTime();
    if (Number.isNaN(target)) return undefined; // invalid deadline — never arm a timer
    setRemaining(target - Date.now());
    if (target - Date.now() <= 0) return undefined; // already expired — nothing to tick
    const id = window.setInterval(() => {
      const left = target - Date.now();
      setRemaining(left);
      if (left <= 0) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [until]);
  return remaining;
}

// ---------------------------------------------------------------------------
// HumanControlBadge
// ---------------------------------------------------------------------------

const BADGE_BASE =
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';

interface HumanControlBadgeProps {
  mode: 'timed' | 'indefinite' | null | undefined;
  until: string | null | undefined;
}

/**
 * The "AI paused" badge for a human-owned conversation. Timed control gets the
 * live countdown; indefinite — and a chat whose summary fields are not known
 * yet (the detail GET does not carry them) — gets the plain badge.
 */
export const HumanControlBadge: React.FC<HumanControlBadgeProps> = ({ mode, until }) => {
  const { t } = useTranslation();
  // An unparseable deadline must not reach the countdown: NaN would render
  // garbage and arm an interval that can never self-stop (NaN <= 0 is false).
  if (mode === 'timed' && until && !Number.isNaN(Date.parse(until))) {
    return <TimedControlBadge until={until} />;
  }
  return (
    <span
      data-testid="human-control-badge"
      data-state="indefinite"
      className={cn(BADGE_BASE, 'bg-primary-600/15 text-primary-400')}
    >
      <Pause className="w-3 h-3" />
      {t('inbox.humanControl.indefinite')}
    </span>
  );
};

/** The ticking half — isolated so the 1s tick re-renders ONLY this span. */
const TimedControlBadge: React.FC<{ until: string }> = ({ until }) => {
  const { t } = useTranslation();
  const remainingMs = useCountdown(until);
  const expired = remainingMs <= 0;
  const warning = !expired && remainingMs < WARNING_THRESHOLD_MS;
  return (
    <span
      data-testid="human-control-badge"
      data-state={expired ? 'resuming' : warning ? 'warning' : 'timed'}
      className={cn(
        BADGE_BASE,
        expired
          ? 'bg-surface-3 text-text-secondary animate-pulse'
          : warning
            ? 'bg-amber-500/15 text-amber-600'
            : 'bg-primary-600/15 text-primary-400',
      )}
    >
      <Timer className="w-3 h-3" />
      {expired
        ? t('inbox.humanControl.resuming')
        : t('inbox.humanControl.timed', { time: formatRemaining(remainingMs) })}
    </span>
  );
};
