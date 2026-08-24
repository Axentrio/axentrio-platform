import React, { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * A number input that may be EMPTY, meaning "no limit".
 *
 * Holds the raw string so clearing the box doesn't snap back to a value mid-edit, and only
 * ever emits a finite number or null — the plain NumberField below does
 * `parseInt(e.target.value, 10)` unguarded, so clearing it yields NaN, which JSON.stringify
 * writes as null and the schema then rejects with what looks to the owner like a server error.
 */
export const OptionalNumberField: React.FC<{
  label: string;
  hint?: string;
  value: number | null;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number | null) => void;
}> = ({ label, hint, value, min, max, step, onChange }) => {
  const [draft, setDraft] = useState<string>(value === null ? '' : String(value));
  // Re-sync when the parent value changes from outside (hydration, preset apply).
  useEffect(() => setDraft(value === null ? '' : String(value)), [value]);
  return (
    <div>
      <Label className="text-text-secondary mb-1 block">{label}</Label>
      <Input
        type="number"
        inputMode="decimal"
        value={draft}
        min={min}
        max={max}
        step={step}
        placeholder="No limit"
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          if (next.trim() === '') return onChange(null);
          const n = Number(next);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
      {hint && <p className="mt-1 text-xs text-text-muted">{hint}</p>}
    </div>
  );
};

export const NumberField: React.FC<{
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
}> = ({ label, value, onChange, min }) => (
  <div>
    <Label className="text-text-secondary mb-1 block">{label}</Label>
    <Input
      type="number"
      value={Number.isFinite(value) ? value : ''}
      min={min}
      onChange={(e) => onChange(parseInt(e.target.value, 10))}
      className={cn('w-full')}
    />
  </div>
);
