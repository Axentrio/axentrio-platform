/**
 * Service area — the places a business is willing to travel to.
 *
 * Suggestions come from the SAME table the API matches customer addresses against
 * (`@contracts/belgium-geo`), so a place the owner can pick here is by construction a place
 * the booking gate can recognise. That table is ~80 KB and searched in-process: no
 * round trip, no debounce, no endpoint to keep in sync.
 *
 * Anything the list does not offer can still be typed and added with Enter. Those manual
 * entries are matched only as far as their text can be resolved — an entry the parser
 * cannot place widens the area to "we cannot be sure", which makes the gate fail open
 * rather than turn a customer away. The copy below says so plainly, because an owner who
 * types "30 km around Aalst" deserves to know it reads as a note rather than a rule.
 */
import React from 'react';
import { MapPin, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { searchPlaces, type PlaceSuggestion } from '@contracts/belgium-geo';
import { MAX_SERVICE_AREA_ENTRIES, type ServiceAreaEntry } from '@contracts/service-area';

interface Props {
  value: ServiceAreaEntry[];
  onChange: (next: ServiceAreaEntry[]) => void;
}

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

export const ServiceAreaField: React.FC<Props> = ({ value, onChange }) => {
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
        The provinces and cities you'll travel to. Search and pick from the list, or type anything else and press
        Enter. Leave this empty and the assistant won't consider distance at all.
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
              className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-surface-2 py-1 pl-3 pr-1.5 text-xs text-text-primary"
            >
              {entry.label}
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

      {value.some((e) => e.kind === 'manual') && (
        <p className="text-xs text-text-muted">
          Typed entries are shown to the assistant, but only places it recognises are used to judge whether a
          customer is out of range — so a booking is never refused on the strength of a note it couldn't read.
        </p>
      )}
    </div>
  );
};
