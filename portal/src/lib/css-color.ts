/**
 * Read theme CSS variables as `rgb()` strings.
 *
 * Recharts (and anything else that cannot take a Tailwind class) still flows
 * from the same tokens in `styles/index.css`. Theme changes are observed off
 * the `.dark` class on <html>, so this does not need ThemeProvider.
 */
import { useMemo, useSyncExternalStore } from 'react';

export function cssRgb(variable: `--${string}`): string {
  if (typeof document === 'undefined') return '';
  const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return raw ? `rgb(${raw})` : '';
}

function subscribe(onStoreChange: () => void) {
  if (typeof document === 'undefined') return () => undefined;
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

function themeSnapshot() {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/** Observed `.dark` on <html>. Safe without ThemeProvider; follows the class, not React state. */
export function useHtmlThemeMode() {
  return useSyncExternalStore(subscribe, themeSnapshot, () => 'light');
}

export function useChartPalette() {
  const mode = useHtmlThemeMode();
  return useMemo(
    () => ({
      bot: cssRgb('--color-primary-400'),
      human: cssRgb('--color-status-online'),
      lead: cssRgb('--color-status-away'),
      busy: cssRgb('--color-status-busy'),
      muted: cssRgb('--color-text-muted'),
      grid: cssRgb('--color-edge'),
      axis: cssRgb('--color-text-secondary'),
      tooltip: {
        backgroundColor: cssRgb('--color-surface-2'),
        border: `1px solid ${cssRgb('--color-edge')}`,
        borderRadius: 12,
        color: cssRgb('--color-text-primary'),
      },
    }),
    [mode],
  );
}
