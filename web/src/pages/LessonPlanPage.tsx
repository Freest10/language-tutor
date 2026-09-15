/**
 * План урока: шаги до начала занятия.
 *
 * Заготовка каркаса: содержимое наполняет пакет фичи, namespace переводов — `lessons`.
 */
import { useParams } from 'react-router-dom';

import { useT } from '../i18n/useT';

/** План выбранного урока. */
export function LessonPlanPage() {
  const t = useT('lessons');
  const { id = '' } = useParams<{ id: string }>();

  return (
    <section className="lt-page" aria-labelledby="lt-lesson-plan-title">
      <h1 id="lt-lesson-plan-title" className="lt-page__title">
        {t('plan.title')}
      </h1>
      <p className="lt-page__lead">{t('plan.subtitle')}</p>
      <p className="lt-facts__value">{t('plan.lessonId', { id })}</p>
      <p className="lt-placeholder">{t('common:status.underConstruction')}</p>
    </section>
  );
}
