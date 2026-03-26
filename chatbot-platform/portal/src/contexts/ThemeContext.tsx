/**
 * Theme Context
 * Manages light/dark/system theme and accent color.
 * Applies .dark class on <html>, persists to localStorage.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { STORAGE_KEYS } from '@/config/constants';

type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  accent: string;
  accentSource: 'user' | 'org';
  setTheme: (theme: ThemeMode) => void;
  setAccent: (color: string) => void;
  setOrgAccent: (color: string | null) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(theme: ThemeMode): 'light' | 'dark' {
  if (theme === 'system') return getSystemTheme();
  return theme;
}

function applyThemeClass(resolved: 'light' | 'dark') {
  if (resolved === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

const DEFAULT_ACCENT = '#6366f1';

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(STORAGE_KEYS.THEME);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    return 'system';
  });

  const [accent, setAccentState] = useState<string>(() => {
    return localStorage.getItem(STORAGE_KEYS.ACCENT) || DEFAULT_ACCENT;
  });

  const [orgAccent, setOrgAccent] = useState<string | null>(null);

  const resolved = resolveTheme(theme);
  const activeAccent = orgAccent || accent;
  const accentSource: 'user' | 'org' = orgAccent ? 'org' : 'user';

  // Apply theme class whenever resolved theme changes
  useEffect(() => {
    applyThemeClass(resolved);
  }, [resolved]);

  // Listen for system theme changes when in 'system' mode
  useEffect(() => {
    if (theme !== 'system') return;

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyThemeClass(getSystemTheme());
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((newTheme: ThemeMode) => {
    setThemeState(newTheme);
    localStorage.setItem(STORAGE_KEYS.THEME, newTheme);
    applyThemeClass(resolveTheme(newTheme));
  }, []);

  const setAccent = useCallback((color: string) => {
    setAccentState(color);
    localStorage.setItem(STORAGE_KEYS.ACCENT, color);
  }, []);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        resolvedTheme: resolved,
        accent: activeAccent,
        accentSource,
        setTheme,
        setAccent,
        setOrgAccent,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
