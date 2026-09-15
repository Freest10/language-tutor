/**
 * Прогресс: словарь, ошибки и история уровня.
 *
 * Заготовка каркаса: содержимое наполняет пакет фичи, namespace переводов — `progress`.
 */
import { useT } from '../i18n/useT';

/** Прогресс: словарь, ошибки и история уровня. */
export function ProgressPage() {
  const t = useT('progress');

  return (
    <section className="lt-page" aria-labelledby="lt-progress-title">
      <h1 id="lt-progress-title" className="lt-page__title">
        {t('title')}
      </h1>
      <p className="lt-page__lead">{t('subtitle')}</p>
      <p className="lt-placeholder">{t('common:status.underConstruction')}</p>
    </section>
  );
}
