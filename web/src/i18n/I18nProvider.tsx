/**
 * Провайдер i18next для всего приложения.
 *
 * Помимо контекста переводов держит в актуальном состоянии атрибуты
 * `<html lang>` и `<html dir>`: от них зависят перенос слов, подбор шрифта
 * и произношение в экранных читалках.
 */
import { useEffect, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';

import { i18n } from './index';

/** Свойства провайдера переводов. */
export interface I18nProviderProps {
  children: ReactNode;
}

/** Подключает переводы и синхронизирует язык документа с выбранным языком. */
export function I18nProvider({ children }: I18nProviderProps) {
  useEffect(() => {
    const applyDocumentLanguage = (language: string): void => {
      document.documentElement.lang = language;
      document.documentElement.dir = i18n.dir(language);
    };

    applyDocumentLanguage(i18n.resolvedLanguage ?? i18n.language);
    i18n.on('languageChanged', applyDocumentLanguage);

    return () => {
      i18n.off('languageChanged', applyDocumentLanguage);
    };
  }, []);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
