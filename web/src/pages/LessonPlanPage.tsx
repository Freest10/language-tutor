/**
 * План урока: этапы занятия до его начала.
 *
 * Страница отвечает за состояния данных — загрузку, отсутствие урока и отказ
 * сервера, — а сам план и форму пересборки рисует `LessonPlanView`.
 *
 * Про ненастроенную модель предупреждаем до нажатия «пересобрать»: без неё
 * новый план взять неоткуда, и попытка закончится ошибкой.
 */
import { Link, useParams } from 'react-router-dom';

import { LessonPlanView } from '../features/lessons/LessonPlanView';
import {
  useLesson,
  useLessonErrorMessage,
  useLessonGenerationReadiness,
  useRegenerateLessonPlan,
} from '../features/lessons/useLessons';
import { useT } from '../i18n/useT';
import { ROUTE_PATHS } from '../router';

/** План выбранного урока. */
export function LessonPlanPage() {
  const t = useT('lessons');
  const toErrorMessage = useLessonErrorMessage();
  const { id = '' } = useParams<{ id: string }>();
  const readiness = useLessonGenerationReadiness();
  const { lesson, isLoading, isError, error, refetch } = useLesson(id);
  const regenerate = useRegenerateLessonPlan(id);

  return (
    <section className="lt-page" aria-labelledby="lt-lesson-plan-title">
      <h1 id="lt-lesson-plan-title" className="lt-page__title">
        {t('plan.title')}
      </h1>
      <p className="lt-page__lead">{t('plan.subtitle')}</p>

      <div className="lt-toolbar">
        <Link className="lt-button" to={ROUTE_PATHS.lessons}>
          {t('plan.actions.backToList')}
        </Link>
      </div>

      {isLoading && (
        <div className="lt-card" aria-busy="true">
          <p className="lt-placeholder" role="status">
            {t('plan.loading')}
          </p>
          <p
            className="lt-skeleton"
            aria-hidden="true"
            style={{ height: '2rem', marginBottom: 'var(--lt-space-sm)' }}
          />
          <p className="lt-skeleton" aria-hidden="true" style={{ height: '2rem', margin: 0 }} />
        </div>
      )}

      {isError && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p className="lt-banner__title">
            {error?.isNotFound ? t('plan.errors.notFound') : t('plan.errors.loadFailed')}
          </p>
          <p>{toErrorMessage(error)}</p>
          <button type="button" className="lt-button" onClick={refetch}>
            {t('common:actions.retry')}
          </button>
        </div>
      )}

      {!isLoading && !isError && !lesson && <p className="lt-placeholder">{t('plan.empty')}</p>}

      {!readiness.isChecking && !readiness.isUnknown && !readiness.isAvailable && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p className="lt-banner__title">{t('create.llm.unavailable.title')}</p>
          <p>{t('plan.regenerate.unavailable')}</p>
          {readiness.reason && <p>{readiness.reason}</p>}
        </div>
      )}

      {lesson && (
        <LessonPlanView
          lesson={lesson}
          isRegenerating={regenerate.isPending}
          regenerateError={regenerate.error}
          canRegenerate={readiness.isAvailable || readiness.isUnknown}
          model={readiness.model}
          onRegenerate={(body) => {
            regenerate.mutate(body);
          }}
        />
      )}
    </section>
  );
}
