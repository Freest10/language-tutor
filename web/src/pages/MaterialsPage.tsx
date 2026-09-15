/**
 * Материалы, на которых строятся уроки.
 *
 * Заготовка каркаса: содержимое наполняет пакет фичи, namespace переводов — `materials`.
 */
import { useT } from '../i18n/useT';

/** Материалы, на которых строятся уроки. */
export function MaterialsPage() {
  const t = useT('materials');

  return (
    <section className="lt-page" aria-labelledby="lt-materials-title">
      <h1 id="lt-materials-title" className="lt-page__title">
        {t('title')}
      </h1>
      <p className="lt-page__lead">{t('subtitle')}</p>
      <p className="lt-placeholder">{t('common:status.underConstruction')}</p>
    </section>
  );
}
