import { useCallback, useEffect, useState } from 'react';

/** Light/dark preference. "system" follows the OS; a choice is a per-browser convenience in localStorage. */
export type Theme = 'system' | 'light' | 'dark';
const KEY = 'urumi-theme';
const EVENT = 'urumi-theme-change';

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === 'system') delete el.dataset.theme;
  else el.dataset.theme = t;
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState(readTheme);
  // Keep every picker on the page (account menu, Account page) showing the same choice.
  useEffect(() => {
    const sync = (e: Event) => setThemeState((e as CustomEvent<Theme>).detail);
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    applyTheme(t);
    try {
      if (t === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      /* storage blocked: the choice lasts for this page view */
    }
    window.dispatchEvent(new CustomEvent<Theme>(EVENT, { detail: t }));
  }, []);
  return [theme, setTheme];
}
