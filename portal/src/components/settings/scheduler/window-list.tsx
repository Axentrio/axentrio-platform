import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TimeSelect } from '@/components/ui/time-select';
import type { TimeWindow } from '../../../queries/useSchedulerQueries';
import { DEFAULT_WINDOW } from './scheduler-types';

/**
 * The open windows for one day (or one date override).
 *
 * The entity, the API and the slot engine have always stored an ARRAY. This editor used to
 * render `windows[0]` and write a single-element array back, so a lunch break — or any
 * second window seeded by a preset or written through the API — was silently destroyed the
 * next time the owner pressed Save. Editing the whole array is the fix.
 */
export const WindowList: React.FC<{
  windows: TimeWindow[];
  disabled?: boolean;
  timezone?: string | null;
  onChange: (next: TimeWindow[]) => void;
}> = ({ windows, disabled, timezone, onChange }) => (
  <div className="flex flex-col gap-1.5">
    {windows.map((w, i) => (
      // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- no-stable-id
      <div key={i} className="flex items-center gap-2">
        {/* Booking windows stay on a 15-minute grid; opening hours use stepMinutes={1}. */}
        <TimeSelect
          value={w.start}
          disabled={disabled}
          timezone={timezone}
          stepMinutes={15}
          allowEndOfDay={false}
          onChange={(v) => onChange(windows.map((x, j) => (j === i ? { ...x, start: v } : x)))}
        />
        <span className="text-text-muted">–</span>
        <TimeSelect
          value={w.end}
          disabled={disabled}
          timezone={timezone}
          stepMinutes={15}
          allowEndOfDay
          onChange={(v) => onChange(windows.map((x, j) => (j === i ? { ...x, end: v } : x)))}
        />
        {windows.length > 1 && (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={disabled}
            aria-label="Remove this time range"
            className="text-red-400 hover:text-red-300"
            onClick={() => onChange(windows.filter((_, j) => j !== i))}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        )}
        {i === windows.length - 1 && (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={disabled}
            aria-label="Add another time range"
            onClick={() => onChange([...windows, { ...DEFAULT_WINDOW }])}
          >
            <Plus className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>
    ))}
  </div>
);
