/**
 * Определение исходного уровня в коротком диалоге.
 *
 * Заготовка каркаса: содержимое наполняет пакет фичи, namespace переводов — `placement`.
 */
import { useT } from '../i18n/useT';

/** Определение исходного уровня в коротком диалоге. */
export function PlacementPage() {
  const t = useT('placement');

  return (
    <section className="lt-page" aria-labelledby="lt-placement-title">
      <h1 id="lt-placement-title" className="lt-page__title">
        {t('title')}
      </h1>
      <p className="lt-page__lead">{t('subtitle')}</p>
      <p className="lt-placeholder">{t('common:status.underConstruction')}</p>
    </section>
  );
}
