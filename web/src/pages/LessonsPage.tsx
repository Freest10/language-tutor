/**
 * Список уроков.
 *
 * Заготовка каркаса: содержимое наполняет пакет фичи, namespace переводов — `lessons`.
 */
import { useT } from '../i18n/useT';

/** Список уроков. */
export function LessonsPage() {
  const t = useT('lessons');

  return (
    <section className="lt-page" aria-labelledby="lt-lessons-title">
      <h1 id="lt-lessons-title" className="lt-page__title">
        {t('title')}
      </h1>
      <p className="lt-page__lead">{t('subtitle')}</p>
      <p className="lt-placeholder">{t('common:status.underConstruction')}</p>
    </section>
  );
}
