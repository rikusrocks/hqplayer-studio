import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Locale } from '../format';
import { en } from './messages.en';
import { zh, type MessageKey } from './messages.zh';

export const MESSAGES: Record<Locale, Record<MessageKey, string>> = { 'zh-CN': zh, en };
export const LOCALES: Array<{ id: Locale; label: string }> = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en', label: 'English' },
];

const STORAGE_KEY = 'hqps.locale';

export type TranslateParams = Record<string, string | number>;
export type Translate = (key: MessageKey, params?: TranslateParams) => string;

/** Replace `{name}` placeholders. Unknown placeholders are left untouched. */
export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m,
  );
}

export function translate(locale: Locale, key: MessageKey, params?: TranslateParams): string {
  const dict = MESSAGES[locale] ?? zh;
  return interpolate(dict[key] ?? zh[key] ?? key, params);
}

function readStoredLocale(): Locale {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (v === 'en' || v === 'zh-CN') return v;
  } catch {
    // storage unavailable (private mode, sandbox) — fall through to default
  }
  return 'zh-CN';
}

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readStoredLocale);
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: (key, params) => translate(locale, key, params),
    }),
    [locale, setLocale],
  );
  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
  }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

export function useT(): Translate {
  return useI18n().t;
}

export type { MessageKey };
