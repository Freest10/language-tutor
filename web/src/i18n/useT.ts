/**
 * Хуки переводов: единая точка входа для всех страниц.
 *
 * `useT('profile')` возвращает `t` своего namespace; ключ чужого namespace
 * доступен через префикс — `t('common:actions.retry')`.
 */
import type { TFunction } from 'i18next';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import {
  DEFAULT_NAMESPACE,
  localeLabel,
  storeLocale,
  toUiLocale,
  UI_LOCALES,
  type AppNamespace,
  type UiLocale,
} from './index';

import { ApiError } from '../api/client';

/**
 * Функция перевода для namespace фичи.
 *
 * @param namespace имя namespace; по умолчанию — общий `common`.
 */
export function useT(namespace: AppNamespace = DEFAULT_NAMESPACE): TFunction<AppNamespace> {
  const { t } = useTranslation(namespace);

  return t;
}

/** Состояние и переключение языка интерфейса. */
export interface LocaleControls {
  /** Текущий язык интерфейса. */
  locale: UiLocale;
  /** Все доступные языки интерфейса. */
  locales: readonly UiLocale[];
  /** Переключает язык и запоминает выбор до следующей загрузки страницы. */
  setLocale: (locale: UiLocale) => void;
  /** Название языка на нём самом — для подписи в переключателе. */
  localeLabel: (locale: UiLocale) => string;
}

/** Язык интерфейса: чтение и переключение (не путать с языком изучения, A12). */
export function useLocale(): LocaleControls {
  const { i18n } = useTranslation();
  const locale = toUiLocale(i18n.resolvedLanguage ?? i18n.language) ?? UI_LOCALES[0];

  const setLocale = useCallback(
    (next: UiLocale): void => {
      storeLocale(next);
      void i18n.changeLanguage(next);
    },
    [i18n],
  );

  return { locale, locales: UI_LOCALES, setLocale, localeLabel };
}

/**
 * Переводит ошибку запроса в текст для пользователя: по коду из конверта API,
 * с отдельными формулировками для обрыва связи и таймаута.
 */
export function useApiErrorMessage(): (error: unknown) => string {
  const { t } = useTranslation(DEFAULT_NAMESPACE);

  return useCallback(
    (error: unknown): string => {
      if (!(error instanceof ApiError)) {
        return t('errors.unknown');
      }

      if (error.isTimeout) {
        return t('errors.timeout');
      }

      if (error.isNetworkError) {
        return t('errors.network');
      }

      return t(`errors.byCode.${error.code}`, { defaultValue: error.message });
    },
    [t],
  );
}
