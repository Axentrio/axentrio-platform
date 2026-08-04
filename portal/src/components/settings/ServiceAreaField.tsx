/**
 * Service area — the places a business works in.
 *
 * Suggestions come from the SAME table the API matches customer addresses against
 * (`@contracts/belgium-geo`), so a place picked here is by construction a place the booking
 * gate can recognise. That table is ~80 KB and searched in-process: no round trip, no
 * debounce, no endpoint to keep in sync.
 *
 * PICKED PLACES ARE RULES; TYPED ONES ARE NOTES. Only entries chosen from the list are used
 * to judge whether a customer is out of range — typed text is passed to the assistant to
 * read but never enforced. The UI says so out loud, because the alternative (guessing at
 * "30 km around Aalst") silently produced a rule NARROWER than the owner asked for.
 *
 * The chips carry their kind, because "Antwerpen" is both a province and a city and the two
 * are indistinguishable once saved — picking the wrong one silently shrinks the area to a
 * single municipality.
 */
import React from 'react';
import { MapPin, X, Info } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { searchPlaces, type PlaceSuggestion } from '@contracts/belgium-geo';
import { MAX_SERVICE_AREA_ENTRIES, type ServiceAreaEntry } from '@contracts/service-area';

interface Props {
  value: ServiceAreaEntry[];
  onChange: (next: ServiceAreaEntry[]) => void;
  /** True when at least one bookable service asks for the customer's address. */
  hasAddressService: boolean;
}

const KIND_LABEL: Record<ServiceAreaEntry['kind'], string> = {
  province: 'province',
  municipality: 'city',
  manual: 'note',
};

/** Same entry twice is always a no-op, whether it came from the list or was typed. */
function alreadyHas(entries: ServiceAreaEntry[], candidate: ServiceAreaEntry): boolean {
  return entries.some((e) => {
    if (e.kind !== candidate.kind) return false;
    if (e.kind === 'manual' || candidate.kind === 'manual') {
      return e.label.trim().toLowerCase() === candidate.label.trim().toLowerCase();
    }
    return e.id === candidate.id;
  });
}

export const ServiceAreaField: React.FC<Props> = ({ value, onChange, hasAddressService }) => {
  const [query, setQuery] = React.useState('');
  const [highlight, setHighlight] = React.useState(0);
  const [focused, setFocused] = React.useState(false);

  const suggestions = React.useMemo<PlaceSuggestion[]>(() => {
    if (query.trim().length < 2) return [];
    return searchPlaces(query, 6).filter(
      (s) => !alreadyHas(value, { kind: s.kind, id: s.id, label: s.label }),
    );
  }, [query, value]);

  React.useEffect(() => setHighlight(0), [query]);

  const full = value.length >= MAX_SERVICE_AREA_ENTRIES;
  const enforceable = value.filter((e) => e.kind !== 'manual').length;

  const add = (entry: ServiceAreaEntry) => {
    if (full || alreadyHas(value, entry)) return;
    onChange([...value, entry]);
    setQuery('');
  };

  const remove = (index: number) => onChange(value.filter((_, i) => i !== index));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === 'Escape') {
      setQuery('');
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const picked = suggestions[highlight];
    if (picked) {
      add({ kind: picked.kind, id: picked.id, label: picked.label });
      return;
    }
    const typed = query.trim();
    if (typed) add({ kind: 'manual', label: typed });
  };

  return (
    <div className="space-y-3 border-t border-edge pt-4">
      <h3 className="text-sm font-medium text-text-primary">Service area</h3>
      <p className="text-xs text-text-muted">
        The provinces and cities you'll travel to. Pick from the list to make it a rule the assistant enforces, or
        type anything else and press Enter to leave the assistant a note. Leave this empty and distance is never
        considered.
      </p>

      <div className="relative">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          // Deferred so a click on a suggestion lands before the list unmounts.
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          disabled={full}
          placeholder={full ? `Limit of ${MAX_SERVICE_AREA_ENTRIES} places reached` : 'Search province, city or postal code'}
          aria-label="Search for a province, city or postal code"
        />

        {focused && suggestions.length > 0 && (
          <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-edge bg-surface-1 shadow-lg">
            {suggestions.map((s, i) => (
              <li key={`${s.kind}:${s.id}`}>
                <button
                  type="button"
                  // onMouseDown, not onClick: blur would otherwise close the list first.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add({ kind: s.kind, id: s.id, label: s.label });
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
                    i === highlight ? 'bg-surface-2 text-text-primary' : 'text-text-secondary',
                  )}
                >
                  <MapPin className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                  <span className="truncate">
                    {s.label}
                    <span className="text-text-muted">, {s.context}</span>
                  </span>
                  {/* "Antwerpen" is both a province and a city — say which this row is. */}
                  <span className="ml-auto shrink-0 text-[11px] uppercase tracking-wide text-text-muted">
                    {KIND_LABEL[s.kind]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {value.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {value.map((entry, i) => (
            <span
              key={`${entry.kind}:${entry.kind === 'manual' ? entry.label : entry.id}`}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border py-1 pl-3 pr-1.5 text-xs',
                entry.kind === 'manual'
                  ? 'border-dashed border-edge bg-surface-1 text-text-secondary'
                  : 'border-edge bg-surface-2 text-text-primary',
              )}
            >
              {entry.label}
              <span className="text-[10px] uppercase tracking-wide text-text-muted">{KIND_LABEL[entry.kind]}</span>
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label={`Remove ${entry.label}`}
                className="rounded-full p-0.5 text-text-muted transition-colors hover:bg-surface-1 hover:text-text-primary"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* An area nothing can enforce is the quiet failure mode: it looks configured and does
          nothing. Both causes get said plainly rather than left for the owner to discover. */}
      {enforceable > 0 && !hasAddressService && (
        <p className="flex gap-2 rounded-lg border border-edge bg-surface-1/40 px-3 py-2 text-xs text-text-muted">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            None of your services asks for the customer's address, so there is nothing to compare this area
            against and no booking will be held back. Turn on <strong>Ask for the customer's address</strong> on the
            services you travel to.
          </span>
        </p>
      )}
      {value.length > 0 && enforceable === 0 && (
        <p className="flex gap-2 rounded-lg border border-edge bg-surface-1/40 px-3 py-2 text-xs text-text-muted">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            These are notes for the assistant to read. Pick at least one province or city from the list if you want
            out-of-area jobs held back for you to confirm.
          </span>
        </p>
      )}
    </div>
  );
};
