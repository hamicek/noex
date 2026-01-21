import en from './en.json';
import cs from './cs.json';

export type Locale = 'en' | 'cs';

export const locales: Locale[] = ['en', 'cs'];
export const defaultLocale: Locale = 'en';

export const localeNames: Record<Locale, string> = {
  en: 'English',
  cs: 'Čeština',
};

const translations: Record<Locale, typeof en> = { en, cs };

type TranslationKeys = typeof en;

/**
 * Get nested value from object using dot notation
 */
function getNestedValue(obj: unknown, path: string): string {
  const keys = path.split('.');
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return path;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === 'string' ? current : path;
}

/**
 * Get translation for a given key and locale
 */
export function t(locale: Locale, key: string): string {
  return getNestedValue(translations[locale], key);
}

/**
 * Create a translator function for a specific locale
 */
export function useTranslations(locale: Locale) {
  return (key: string): string => t(locale, key);
}

/**
 * Get locale from URL path
 */
export function getLocaleFromUrl(url: URL): Locale {
  const [, lang] = url.pathname.split('/');
  if (lang && locales.includes(lang as Locale)) {
    return lang as Locale;
  }
  return defaultLocale;
}

/**
 * Get path for different locale (for language switcher)
 */
export function getLocalizedPath(path: string, targetLocale: Locale): string {
  const segments = path.split('/').filter(Boolean);

  if (locales.includes(segments[0] as Locale)) {
    segments[0] = targetLocale;
  } else {
    segments.unshift(targetLocale);
  }

  return '/' + segments.join('/');
}

/**
 * Get all translations for a locale
 */
export function getTranslations(locale: Locale): TranslationKeys {
  return translations[locale];
}
