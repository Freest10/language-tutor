/**
 * Список уроков и создание нового урока.
 *
 * Страница держит фильтр по статусу, размер показанной страницы списка и
 * открытость диалога создания; данные и мутации живут в
 * `features/lessons/useLessons`, чтобы комната урока и план читали тот же кэш.
 *
 * Про ненастроенную языковую модель предупреждаем здесь, до открытия диалога:
 * без модели план не сгенерируется, и об этом лучше узнать до заполнения формы.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { CreateLessonDialog } from '../features/lessons/CreateLessonDialog';
import { LessonList } from '../features/lessons/LessonList';
import {
  LESSONS_PAGE_SIZE,
  useLessonGenerationReadiness,
  useLessons,
  type LessonStatusFilter,
} from '../features/lessons/useLessons';
import { useT } from '../i18n/useT';
import { lessonPlanPath } from '../router';

/** Список уроков. */
export function LessonsPage() {
  const t = useT('lessons');
  const navigate = useNavigate();
  const readiness = useLessonGenerationReadiness();
  const [status, setStatus] = useState<LessonStatusFilter>('all');
  const [limit, setLimit] = useState(LESSONS_PAGE_SIZE);
  const [isCreateOpen, setCreateOpen] = useState(false);
  const { lessons, total, hasMore, isLoading, isError, error, refetch } = useLessons({
    limit,
    ...(status === 'all' ? {} : { status }),
  });

  return (
    <section className="lt-page" aria-labelledby="lt-lessons-title">
      <h1 id="lt-lessons-title" className="lt-page__title">
        {t('title')}
      </h1>
      <p className="lt-page__lead">{t('subtitle')}</p>

      {!readiness.isChecking && !readiness.isUnknown && !readiness.isAvailable && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p className="lt-banner__title">{t('create.llm.unavailable.title')}</p>
          <p>{t('create.llm.unavailable.description')}</p>
          {readiness.reason && <p>{readiness.reason}</p>}
        </div>
      )}

      <div className="lt-toolbar">
        <button
          type="button"
          className="lt-button"
          onClick={() => {
            setCreateOpen(true);
          }}
        >
          {t('create.open')}
        </button>
      </div>

      <LessonList
        lessons={lessons}
        total={total}
        isLoading={isLoading}
        isError={isError}
        error={error}
        hasMore={hasMore}
        status={status}
        onStatusChange={(next) => {
          setStatus(next);
          setLimit(LESSONS_PAGE_SIZE);
        }}
        onLoadMore={() => {
          setLimit((current) => current + LESSONS_PAGE_SIZE);
        }}
        onRetry={refetch}
        onCreate={() => {
          setCreateOpen(true);
        }}
      />

      {isCreateOpen && (
        <CreateLessonDialog
          onClose={() => {
            setCreateOpen(false);
          }}
          onCreated={(lesson) => {
            setCreateOpen(false);
            void navigate(lessonPlanPath(lesson.id));
          }}
        />
      )}
    </section>
  );
}
