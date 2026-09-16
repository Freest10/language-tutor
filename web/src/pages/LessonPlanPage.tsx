/**
 * План урока: этапы занятия до его начала.
 *
 * Страница отвечает за состояния данных — загрузку, отсутствие урока и отказ
 * сервера, — а сам план и форму пересборки рисует `LessonPlanView`.
 *
 * Про ненастроенную модель предупреждаем до нажатия «пересобрать»: без неё
 * новый план взять неоткуда, и попытка закончится ошибкой.
 *
 * Удаление урока живёт здесь, а не в `LessonPlanView`: просмотр плана —
 * представление, которое получает состояние мутаций свойствами, а после удаления
 * нужно уйти на список уроков, и переходы между разделами держит страница.
 * Остаться на странице удалённого урока нельзя: следующий же запрос вернёт 404.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { LoadingBlock } from '../components/LoadingBlock';
import { DeleteLessonConfirm } from '../features/lessons/DeleteLessonConfirm';
import { LessonPlanView } from '../features/lessons/LessonPlanView';
import {
  isLessonAlreadyDeleted,
  useDeleteLesson,
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
  const navigate = useNavigate();
  const { id = '' } = useParams<{ id: string }>();
  const readiness = useLessonGenerationReadiness();
  const { lesson, isLoading, isError, error, refetch } = useLesson(id);
  const regenerate = useRegenerateLessonPlan(id);
  const remove = useDeleteLesson();
  const [isConfirmingDelete, setConfirmingDelete] = useState(false);
  // 404 значит, что урок уже удалён: это не отказ, а то же самое удаление.
  const deleteError = remove.error !== null && !isLessonAlreadyDeleted(remove.error);

  const leaveToList = (): void => {
    setConfirmingDelete(false);
    void navigate(ROUTE_PATHS.lessons);
  };

  const confirmDelete = (): void => {
    remove.mutate(id, {
      onSuccess: leaveToList,
      onError: (deleteFailure) => {
        if (isLessonAlreadyDeleted(deleteFailure)) {
          leaveToList();
        }
      },
    });
  };

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
        {lesson && (
          <button
            type="button"
            className="lt-button"
            disabled={isConfirmingDelete}
            onClick={() => {
              setConfirmingDelete(true);
            }}
          >
            {t('plan.actions.delete')}
          </button>
        )}
      </div>

      {lesson && isConfirmingDelete && (
        <DeleteLessonConfirm
          lesson={lesson}
          isDeleting={remove.isPending}
          onConfirm={confirmDelete}
          onCancel={() => {
            setConfirmingDelete(false);
          }}
        />
      )}

      {deleteError && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p className="lt-banner__title">{t('errors.deleteFailed')}</p>
          <p>{toErrorMessage(remove.error)}</p>
        </div>
      )}

      {isLoading && <LoadingBlock label={t('plan.loading')} card />}

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
