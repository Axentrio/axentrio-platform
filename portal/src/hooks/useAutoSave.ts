import { useCallback, useEffect, useRef, useState } from 'react';

export type AutoSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

type MutateOpts = { onSuccess: () => void; onError: () => void };

interface UseAutoSaveOptions {
  // Stringified snapshot of the form's current state.
  snapshot: string;
  // Baseline snapshot established by hydration. Null while still loading;
  // the hook will not auto-save until this becomes non-null.
  initialSnapshot: string | null;
  // When false the hook skips saves entirely (e.g. validation failed).
  isValid: boolean;
  // The form's commit function. Hook calls this with onSuccess/onError —
  // the form supplies the payload + mutate call inside.
  save: (opts: MutateOpts) => void;
  // Debounce window in ms. Default 800.
  debounceMs?: number;
  // How long the "Saved" indicator lingers after a successful save.
  savedLingerMs?: number;
}

interface UseAutoSaveReturn {
  status: AutoSaveStatus;
  isDirty: boolean;
  flush: () => void;
  retry: () => void;
}

// Debounced auto-save with single-flight queueing.
// While a save is in-flight, the latest pending snapshot is queued and fired
// when the in-flight one resolves — so older requests cannot clobber newer state.
export function useAutoSave({
  snapshot,
  initialSnapshot,
  isValid,
  save,
  debounceMs = 800,
  savedLingerMs = 2500,
}: UseAutoSaveOptions): UseAutoSaveReturn {
  const [status, setStatus] = useState<AutoSaveStatus>('idle');
  // Baseline tracked in both state (for reactive isDirty) and ref (for stable
  // reads inside fire() without re-creating the callback).
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(initialSnapshot);
  const savedSnapshotRef = useRef<string | null>(initialSnapshot);
  const inFlightRef = useRef(false);
  const queuedSnapshotRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedLingerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep latest save fn in a ref so the debounce effect doesn't restart
  // when callers pass an inline closure.
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; }, [save]);

  // Sync baseline whenever a new hydration arrives. Callers gate hydration to
  // once-per-context (e.g. once-per-tenant), so a change here means we're now
  // looking at a fresh dataset and the prior baseline is stale. Between
  // hydrations, successful saves move the baseline forward via fire().
  useEffect(() => {
    if (initialSnapshot === null) return;
    savedSnapshotRef.current = initialSnapshot;
    setSavedSnapshot(initialSnapshot);
  }, [initialSnapshot]);

  const fire = useCallback((snap: string) => {
    if (inFlightRef.current) {
      queuedSnapshotRef.current = snap;
      return;
    }
    if (savedLingerTimeoutRef.current) {
      clearTimeout(savedLingerTimeoutRef.current);
      savedLingerTimeoutRef.current = null;
    }
    inFlightRef.current = true;
    setStatus('saving');
    saveRef.current({
      onSuccess: () => {
        savedSnapshotRef.current = snap;
        setSavedSnapshot(snap);
        inFlightRef.current = false;
        const queued = queuedSnapshotRef.current;
        queuedSnapshotRef.current = null;
        if (queued !== null && queued !== snap) {
          fire(queued);
          return;
        }
        setStatus('saved');
        savedLingerTimeoutRef.current = setTimeout(() => {
          setStatus('idle');
          savedLingerTimeoutRef.current = null;
        }, savedLingerMs);
      },
      onError: () => {
        inFlightRef.current = false;
        queuedSnapshotRef.current = null;
        setStatus('error');
      },
    });
  }, [savedLingerMs]);

  // Schedule a debounced save when the snapshot diverges from baseline.
  useEffect(() => {
    if (initialSnapshot === null) return;
    if (!isValid) return;
    if (snapshot === savedSnapshotRef.current) return;

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      fire(snapshot);
    }, debounceMs);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [snapshot, isValid, initialSnapshot, debounceMs, fire]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (savedLingerTimeoutRef.current) clearTimeout(savedLingerTimeoutRef.current);
    };
  }, []);

  const flush = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (initialSnapshot === null) return;
    if (!isValid) return;
    if (snapshot === savedSnapshotRef.current) return;
    fire(snapshot);
  }, [snapshot, isValid, initialSnapshot, fire]);

  const retry = useCallback(() => {
    if (!isValid) return;
    fire(snapshot);
  }, [snapshot, isValid, fire]);

  const isDirty = savedSnapshot !== null && snapshot !== savedSnapshot;

  return { status, isDirty, flush, retry };
}

export default useAutoSave;
