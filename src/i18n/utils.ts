import en from './en';
import kn from './kn';
import ta from './ta';

export const DEFAULT_LOCALE = 'en' as const;
export const SUPPORTED_LOCALES = ['en', 'kn', 'ta'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  kn: 'ಕನ್ನಡ',
  ta: 'தமிழ்',
};

type Dict = { [key: string]: string | Dict };

const dictionaries: Record<Locale, Dict> = { en, kn, ta };

function lookup(dict: Dict, path: string): string | undefined {
  const value = path.split('.').reduce<Dict | string | undefined>((node, key) => {
    if (node && typeof node === 'object') return node[key];
    return undefined;
  }, dict);
  return typeof value === 'string' ? value : undefined;
}

export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

// Every page dictionary key must exist in en.ts (the fallback) - kn/ta only
// need to exist once translated, so a page can be migrated locale-by-locale.
export function useTranslations(locale: Locale) {
  return function t(path: string, params?: Record<string, string | number>): string {
    const raw = lookup(dictionaries[locale], path) ?? lookup(dictionaries[DEFAULT_LOCALE], path) ?? path;
    if (!params) return raw;
    return Object.entries(params).reduce((str, [key, value]) => str.replaceAll(`{${key}}`, String(value)), raw);
  };
}

// Strips a leading /kn or /ta segment so callers (language switcher, hreflang
// links) can re-apply getRelativeLocaleUrl for a *different* locale against
// the same underlying page, rather than just prefixing the current URL.
export function stripLocalePrefix(pathname: string): string {
  const match = pathname.match(/^\/(kn|ta)(\/.*|$)/);
  return match ? match[2] || '/' : pathname;
}
