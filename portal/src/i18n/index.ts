import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';
import nl from './locales/nl.json';
import fr from './locales/fr.json';

export const SUPPORTED_LOCALES = ['en', 'nl', 'fr'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

export const isSupportedLocale = (value: unknown): value is SupportedLocale =>
  typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      nl: { translation: nl },
      fr: { translation: fr },
    },
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALES as unknown as string[],
    nonExplicitSupportedLngs: true, // 'en-US' → 'en', etc.
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'handsoff_locale',
    },
    returnNull: false,
  });

export default i18n;
