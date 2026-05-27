import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoSave } from './useAutoSave';

type SaveOpts = { onSuccess: () => void; onError: () => void };

type HookProps = {
  snapshot: string;
  initialSnapshot: string | null;
  isValid: boolean;
  save: (opts: SaveOpts) => void;
  debounceMs?: number;
  savedLingerMs?: number;
};

const baseProps = (overrides: Partial<HookProps>): HookProps => ({
  snapshot: 'A',
  initialSnapshot: 'A',
  isValid: true,
  save: vi.fn(),
  debounceMs: 800,
  savedLingerMs: 2500,
  ...overrides,
});

describe('useAutoSave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not schedule a save before hydration (initialSnapshot is null)', () => {
    const save = vi.fn();
    renderHook((p: HookProps) => useAutoSave(p), {
      initialProps: baseProps({ snapshot: 'X', initialSnapshot: null, save }),
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('debounces rapid edits into a single save after the trailing delay', () => {
    const save = vi.fn();
    const { rerender } = renderHook((p: HookProps) => useAutoSave(p), {
      initialProps: baseProps({ snapshot: 'A', initialSnapshot: 'A', save }),
    });

    rerender(baseProps({ snapshot: 'edit1', initialSnapshot: 'A', save }));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    rerender(baseProps({ snapshot: 'edit2', initialSnapshot: 'A', save }));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(save).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('skips save while isValid is false', () => {
    const save = vi.fn();
    const { rerender } = renderHook((p: HookProps) => useAutoSave(p), {
      initialProps: baseProps({ snapshot: 'A', initialSnapshot: 'A', save }),
    });

    rerender(baseProps({ snapshot: 'bad', initialSnapshot: 'A', isValid: false, save }));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('flush() cancels the debounce timer and saves immediately', () => {
    const save = vi.fn();
    const { rerender, result } = renderHook((p: HookProps) => useAutoSave(p), {
      initialProps: baseProps({ snapshot: 'A', initialSnapshot: 'A', save }),
    });

    rerender(baseProps({ snapshot: 'edited', initialSnapshot: 'A', save }));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(save).not.toHaveBeenCalled();

    act(() => {
      result.current.flush();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flush() is a no-op when the snapshot is clean', () => {
    const save = vi.fn();
    const { result } = renderHook((p: HookProps) => useAutoSave(p), {
      initialProps: baseProps({ snapshot: 'A', initialSnapshot: 'A', save }),
    });

    act(() => {
      result.current.flush();
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('walks idle → saving → saved → idle and clears isDirty on success', () => {
    let capturedOnSuccess: (() => void) | null = null;
    const save = vi.fn((opts: SaveOpts) => {
      capturedOnSuccess = opts.onSuccess;
    });
    const { rerender, result } = renderHook((p: HookProps) => useAutoSave(p), {
      initialProps: baseProps({ snapshot: 'A', initialSnapshot: 'A', save }),
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.isDirty).toBe(false);

    rerender(baseProps({ snapshot: 'edit', initialSnapshot: 'A', save }));
    expect(result.current.isDirty).toBe(true);

    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(result.current.status).toBe('saving');

    act(() => {
      capturedOnSuccess?.();
    });
    expect(result.current.status).toBe('saved');
    expect(result.current.isDirty).toBe(false);

    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(result.current.status).toBe('idle');
  });

  it('queues a newer snapshot when a save is in-flight and fires it after the current resolves', () => {
    const captured: SaveOpts[] = [];
    const save = vi.fn((opts: SaveOpts) => {
      captured.push(opts);
    });
    const { rerender, result } = renderHook((p: HookProps) => useAutoSave(p), {
      initialProps: baseProps({ snapshot: 'A', initialSnapshot: 'A', save }),
    });

    // First edit → debounce → save fires
    rerender(baseProps({ snapshot: 'v1', initialSnapshot: 'A', save }));
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(save).toHaveBeenCalledTimes(1);

    // Second edit while v1 save is still in-flight → debounce fires but
    // fire() queues v2 because inFlightRef is true.
    rerender(baseProps({ snapshot: 'v2', initialSnapshot: 'A', save }));
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(save).toHaveBeenCalledTimes(1);

    // Resolve v1 → hook auto-fires the queued v2 save.
    act(() => {
      captured[0].onSuccess();
    });
    expect(save).toHaveBeenCalledTimes(2);

    // Resolve v2 → baseline catches up to v2, isDirty clears.
    act(() => {
      captured[1].onSuccess();
    });
    expect(result.current.isDirty).toBe(false);
    expect(result.current.status).toBe('saved');
  });

  it('moves to error on failure and retry() re-fires the save', () => {
    const captured: SaveOpts[] = [];
    const save = vi.fn((opts: SaveOpts) => {
      captured.push(opts);
    });
    const { rerender, result } = renderHook((p: HookProps) => useAutoSave(p), {
      initialProps: baseProps({ snapshot: 'A', initialSnapshot: 'A', save }),
    });

    rerender(baseProps({ snapshot: 'edit', initialSnapshot: 'A', save }));
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(result.current.status).toBe('saving');

    act(() => {
      captured[0].onError();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.isDirty).toBe(true);

    act(() => {
      result.current.retry();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('saving');

    act(() => {
      captured[1].onSuccess();
    });
    expect(result.current.status).toBe('saved');
    expect(result.current.isDirty).toBe(false);
  });

  it('resets the baseline when initialSnapshot changes (tenant switch) — no spurious save', () => {
    const save = vi.fn();
    const { rerender, result } = renderHook((p: HookProps) => useAutoSave(p), {
      initialProps: baseProps({ snapshot: 'A', initialSnapshot: 'A', save }),
    });
    expect(result.current.isDirty).toBe(false);

    // New tenant arrives — both the current snapshot and the baseline move to a new value.
    rerender(baseProps({ snapshot: 'B', initialSnapshot: 'B', save }));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.isDirty).toBe(false);
  });
});
