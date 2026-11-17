import { useCallback, useEffect, useState } from 'react';

/**
 * Colour themes. Each one is a combination of solid colours defined in styles/tokens.css
 * (`[data-theme='<id>']`); `dark` and `light` are the neutral black/grey and white/grey pair.
 */
export const THEMES = [
  'dark',
  'light',
  'cobalt',
  'citrus',
  'poppy',
  'pine',
  'plum',
  'ocean',
] as const;
export type Theme = (typeof THEMES)[number];
const STORAGE_KEY = 'hqps.theme';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function readStoredTheme(): Theme {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (isTheme(v)) return v;
  } catch {
    // ignore
  }
  return 'dark';
}

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
}

/** Theme preference, persisted per browser (dark by default). */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, t);
    } catch {
      // ignore
    }
  }, []);
  return [theme, setTheme];
}
