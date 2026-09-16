/**
 * Инициализация i18next: ресурсы, определение языка интерфейса и его хранение.
 *
 * ПРАВИЛО ПАКЕТОВ: фичевый пакет наполняет СВОИ файлы в `locales/<lng>/<namespace>.json`
 * и не меняет этот модуль — состав языков и namespace зафиксирован здесь целиком,
 * чтобы параллельная работа не пересекалась в общем файле.
 *
 * Множественное число берётся из `Intl.PluralRules` самим i18next: для русского
 * нужны суффиксы `_one`/`_few`/`_many`/`_other`, для английского — `_one`/`_other`.
 *
 * Язык интерфейса не связан с изучаемым языком и языком объяснений (допущение A12):
 * те два хранятся в профиле на сервере, этот — только в localStorage браузера.
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import { LANGUAGE_LABELS } from '@lt/shared';

import enCommon from './locales/en/common.json';
import enLessonRoom from './locales/en/lessonRoom.json';
import enLessons from './locales/en/lessons.json';
import enMaterials from './locales/en/materials.json';
import enPlacement from './locales/en/placement.json';
import enProfile from './locales/en/profile.json';
import enProgress from './locales/en/progress.json';
import enVoice from './locales/en/voice.json';
import ruCommon from './locales/ru/common.json';
import ruLessonRoom from './locales/ru/lessonRoom.json';
import ruLessons from './locales/ru/lessons.json';
import ruMaterials from './locales/ru/materials.json';
import ruPlacement from './locales/ru/placement.json';
import ruProfile from './locales/ru/profile.json';
import ruProgress from './locales/ru/progress.json';
import ruVoice from './locales/ru/voice.json';

import { LOCALE_STORAGE_KEY, readStoredValue, writeStoredValue } from '../lib/storage';

/** Языки интерфейса, для которых есть полный набор переводов. */
export const UI_LOCALES = ['en', 'ru'] as const;

/** Язык интерфейса. */
export type UiLocale = (typeof UI_LOCALES)[number];

/** Язык интерфейса, на который откатываемся, если перевода нет. */
export const FALLBACK_LOCALE: UiLocale = 'en';

/** Namespace переводов: по одному на фичу, плюс общий `common`. */
export const APP_NAMESPACES = [
  'common',
  'profile',
  'placement',
  'materials',
  'lessons',
  'lessonRoom',
  'progress',
  'voice',
] as const;

/** Namespace переводов. */
export type AppNamespace = (typeof APP_NAMESPACES)[number];

/** Namespace по умолчанию: навигация, кнопки, статусы и общие ошибки. */
export const DEFAULT_NAMESPACE = 'common' satisfies AppNamespace;

/** Ключ localStorage, в котором хранится выбранный язык интерфейса. */
export { LOCALE_STORAGE_KEY };

/** Все переводы, вшитые в бандл: запросов за словарями во время работы нет. */
export const resources = {
  en: {
    common: enCommon,
    profile: enProfile,
    placement: enPlacement,
    materials: enMaterials,
    lessons: enLessons,
    lessonRoom: enLessonRoom,
    progress: enProgress,
    voice: enVoice,
  },
  ru: {
    common: ruCommon,
    profile: ruProfile,
    placement: ruPlacement,
    materials: ruMaterials,
    lessons: ruLessons,
    lessonRoom: ruLessonRoom,
    progress: ruProgress,
    voice: ruVoice,
  },
} as const;

/** Поддерживается ли значение как язык интерфейса. */
export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === 'string' && (UI_LOCALES as readonly string[]).includes(value);
}

/** Приводит код вида `ru-RU` к поддерживаемому языку интерфейса. */
export function toUiLocale(value: string | null | undefined): UiLocale | null {
  if (!value) {
    return null;
  }

  const primary = value.toLowerCase().split('-')[0] ?? '';

  return isUiLocale(primary) ? primary : null;
}

/** Название языка интерфейса на нём самом (`Русский`, `English`). */
export function localeLabel(locale: UiLocale): string {
  return LANGUAGE_LABELS[locale].nativeName;
}

/** Ранее выбранный язык интерфейса; `null`, если выбора не было. */
export function readStoredLocale(): UiLocale | null {
  return toUiLocale(readStoredValue(LOCALE_STORAGE_KEY));
}

/** Запоминает выбранный язык интерфейса до следующей загрузки страницы. */
export function storeLocale(locale: UiLocale): void {
  writeStoredValue(LOCALE_STORAGE_KEY, locale);
}

/** Язык интерфейса при старте: выбор пользователя → язык браузера → `en`. */
export function detectInitialLocale(): UiLocale {
  const stored = readStoredLocale();

  if (stored) {
    return stored;
  }

  const preferred = typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? [])];

  if (typeof navigator !== 'undefined' && navigator.language) {
    preferred.push(navigator.language);
  }

  for (const candidate of preferred) {
    const locale = toUiLocale(candidate);

    if (locale) {
      return locale;
    }
  }

  return FALLBACK_LOCALE;
}

void i18next.use(initReactI18next).init({
  resources,
  lng: detectInitialLocale(),
  fallbackLng: FALLBACK_LOCALE,
  supportedLngs: [...UI_LOCALES],
  ns: [...APP_NAMESPACES],
  defaultNS: DEFAULT_NAMESPACE,
  // Словари уже в бандле: инициализация синхронная, Suspense не нужен.
  initAsync: false,
  returnNull: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

/** Инициализированный экземпляр i18next. Провайдер и хуки работают только с ним. */
export const i18n = i18next;

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof DEFAULT_NAMESPACE;
    returnNull: false;
  }
}
