/**
 * Pick an address instead of typing one.
 *
 * The four venue fields below this control are the travel BASE - every first job of the day is
 * routed from them - and a typed address is only as good as the typing. "Grote Markt" with no
 * city geocodes to `approximate` or not at all, which quietly turns confirmable appointments into
 * Requests the owner has to triage by hand.
 *
 * IT NEVER TAKES THE KEYBOARD AWAY. Choosing a suggestion fills the fields in; editing them
 * afterwards is normal and expected, and it drops the verified identity because the address is no
 * longer the one that was verified. An owner whose address Google cannot suggest - a new build, a
 * renamed street - types it exactly as they do today. This is a shortcut, never a gate.
 *
 * Google's key never reaches this component: suggestions come from our own API, which holds the
 * key, attributes the spend to the tenant and rate-limits the calls.
 */
import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '../../services/apiClient';

export interface AddressSuggestion {
  placeId: string;
  text: string;
}

export interface SelectedAddress {
  placeId: string;
  formattedAddress: string;
  components: {
    street?: string | null;
    postalCode?: string | null;
    city?: string | null;
    country?: string | null;
  } | null;
}

/**
 * Long enough that a suggestion list is worth showing, short enough not to feel laggy.
 *
 * This is one of three spend controls, not a UI preference: suggestions bill per request, so
 * every keystroke that does NOT become a request is money. The other two are the server's
 * three-character minimum and the rate limiter.
 */
const DEBOUNCE_MS = 350;

interface Props {
  /** Called once the owner picks one. The parent fills its fields and keeps the id for Save. */
  onSelect: (selected: SelectedAddress) => void;
  label?: string;
  placeholder?: string;
}

export function AddressAutocomplete({ onSelect, label = 'Search for your address', placeholder = 'Start typing an address…' }: Props) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  /**
   * Which request the answer belongs to.
   *
   * Typing produces overlapping requests and they do not come back in order. Without this, a slow
   * answer for "Gro" can land after a fast one for "Grote Markt 1" and replace a correct list
   * with a stale one - the classic autocomplete flicker, and it makes the control look broken
   * exactly when someone is typing fastest.
   */
  const sequence = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    // Matches the server's minimum. Asking below it spends a request to be told "too short".
    if (trimmed.length < 3) {
      setSuggestions([]);
      return;
    }

    const mine = ++sequence.current;
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        // `api.post` resolves to the BODY, not an axios response: the wrapper does
        // `.then(res => res.data)` and the interceptor has already stripped the `{ success, data }`
        // envelope. Destructuring `{ data }` here made `data` undefined, so reading `.suggestions`
        // threw and the catch below turned it into an empty list - a working search that showed
        // nothing, with the error visible only in the console.
        const body = await api.post<{ suggestions: AddressSuggestion[] }>(
          '/scheduler/places/autocomplete',
          { query: trimmed }
        );
        if (mine === sequence.current) setSuggestions(body?.suggestions ?? []);
      } catch {
        // Suggestions are a convenience. Losing them must never look like a broken form, so the
        // list simply empties and the four fields below carry on taking typed input.
        if (mine === sequence.current) setSuggestions([]);
      } finally {
        if (mine === sequence.current) setBusy(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query]);

  const choose = async (suggestion: AddressSuggestion) => {
    setSuggestions([]);
    setQuery(suggestion.text);
    try {
      // Same unwrap. This one was worse: `onSelect(undefined)` meant picking a suggestion filled
      // the four fields below with nothing, so the shortcut silently did the opposite of its job.
      const selected = await api.post<SelectedAddress>('/scheduler/places/select', {
        placeId: suggestion.placeId,
      });
      onSelect(selected);
    } catch {
      // The id came from our own list, so a failure here is Google or the tenant's cap - not
      // something the owner did. The text they picked stays in the box and the fields below stay
      // editable, so they can finish by hand.
      setQuery(suggestion.text);
    }
  };

  return (
    <div className="sm:col-span-2">
      <Label htmlFor="venue-search">{label}</Label>
      <Input
        id="venue-search"
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        maxLength={200}
        onChange={(e) => setQuery(e.target.value)}
      />
      {busy && suggestions.length === 0 && (
        <p className="text-xs text-text-muted mt-1">Searching…</p>
      )}
      {suggestions.length > 0 && (
        <ul className="mt-1 border border-border rounded-md divide-y divide-border overflow-hidden">
          {suggestions.map((s) => (
            <li key={s.placeId}>
              <button
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover:bg-surface-hover"
                onClick={() => void choose(s)}
              >
                {s.text}
              </button>
            </li>
          ))}
          {/*
            Required, not decorative. Autocomplete (New) obliges us to attribute predictions
            wherever they are shown without a Google map beside them.
          */}
          <li className="px-3 py-1 text-[10px] text-text-muted text-right">Powered by Google</li>
        </ul>
      )}
      <p className="text-xs text-text-muted mt-1">
        Pick your address to fill the fields below, or just type them in.
      </p>
    </div>
  );
}
