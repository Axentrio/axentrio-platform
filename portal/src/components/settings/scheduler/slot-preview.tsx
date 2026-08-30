import React, { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useBookingAvailability } from '../../../queries/useSchedulerQueries';
import { formatClockTime } from '@contracts/clock-format';

/** Calls the availability endpoint for the next 7 days. Reflects SAVED config. */
export const SlotPreview: React.FC<{ timezone: string }> = ({ timezone }) => {
  const range = useMemo(() => {
    const s = new Date();
    const e = new Date(s.getTime() + 7 * 24 * 3600_000);
    return { start: s.toISOString(), end: e.toISOString() };
  }, []);
  const { data, isLoading, isError } = useBookingAvailability(range.start, range.end, true);

  const grouped = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const s of data?.slots ?? []) {
      const day = new Intl.DateTimeFormat('en-GB', {
        timeZone: data?.timezone ?? timezone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      }).format(new Date(s.start));
      const time = formatClockTime(s.start, data?.timezone ?? timezone);
      if (!out.has(day)) out.set(day, []);
      out.get(day)!.push(time);
    }
    return Array.from(out.entries());
  }, [data, timezone]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-text-muted">
        <Loader2 className="w-4 h-4 animate-spin" /> Computing slots…
      </div>
    );
  }
  if (isError) {
    return <p className="text-xs text-text-muted">Save your settings first, then preview.</p>;
  }
  const total = data?.slots.length ?? 0;
  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">
        {total} open slot{total === 1 ? '' : 's'} in the next 7 days · reflects saved settings · {data?.timezone ?? timezone}
      </p>
      {grouped.length === 0 ? (
        <p className="text-xs text-text-muted">No open slots in this window.</p>
      ) : (
        <div className="space-y-1.5">
          {grouped.map(([day, times]) => (
            <SlotPreviewDay key={day} day={day} times={times} />
          ))}
        </div>
      )}
    </div>
  );
};

/** One day's row in the preview: label + wrapping time chips, expandable. */
export const SlotPreviewDay: React.FC<{ day: string; times: string[] }> = ({ day, times }) => {
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 8;
  const shown = expanded ? times : times.slice(0, LIMIT);
  const hidden = times.length - shown.length;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-edge bg-surface-1/40 px-3 py-2">
      <span className="w-24 shrink-0 pt-0.5 text-xs font-medium text-text-secondary">{day}</span>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((t) => (
          <span
            key={t}
            className="rounded-md border border-edge bg-surface-2 px-2 py-0.5 text-xs tabular-nums text-text-primary"
          >
            {t}
          </span>
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="rounded-md px-2 py-0.5 text-xs font-medium text-primary-400 hover:text-primary-300"
          >
            +{hidden} more
          </button>
        )}
        {expanded && times.length > LIMIT && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="rounded-md px-2 py-0.5 text-xs text-text-muted hover:text-text-secondary"
          >
            show less
          </button>
        )}
      </div>
    </div>
  );
};
