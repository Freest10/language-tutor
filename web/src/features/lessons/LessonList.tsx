/**
 * Список уроков: что уже запланировано, в каком состоянии и куда из этого перейти.
 *
 * Список ничего не загружает сам — данные и фильтр приходят со страницы, чтобы
 * одно и то же состояние списка не жило в двух местах.
 *
 * Действий у урока три: вернуться в комнату (продолжить или посмотреть, как
 * прошло), открыть план и удалить урок.
 *
 * Удаление подтверждается своим блоком прямо в строке списка, а не системным
 * `window.confirm`: диалог браузера блокирует поток, не переводится и не читается
 * экранной читалкой как часть страницы. Перечень последствий живёт в
 * `DeleteLessonConfirm` — общем блоке со страницей плана.
 *
 * Отказ 404 ошибкой не показывается: урока и так нет, а список после него
 * перечитывается сам — цель пользователя достигнута, пугать его нечем.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';

import { LESSON_STATUSES, type Lesson, type LessonStatus } from '@lt/shared';

import type { ApiError } from '../../api/client';

import { DeleteLessonConfirm } from './DeleteLessonConfirm';
import {
  isLessonAlreadyDeleted,
  useDeleteLesson,
  useLessonErrorMessage,
  useLessonFormatters,
  useLessonStatusText,
  type LessonStatusFilter,
} from './useLessons';

import { LoadingBlock } from '../../components/LoadingBlock';
import { useT } from '../../i18n/useT';
import { lessonPlanPath, lessonRoomPath } from '../../router';

/** Свойства списка уроков. */
export interface LessonListProps {
  /** Уроки текущей страницы списка. */
  lessons: Lesson[];
  /** Сколько уроков всего на сервере при текущем фильтре. */
  total: number;
  isLoading: boolean;
  isError: boolean;
  /** Отказ запроса; текст для пользователя собирает сам список. */
  error: ApiError | null;
  /** Есть ли уроки за пределами показанной страницы. */
  hasMore: boolean;
  /** Выбранный фильтр по статусу. */
  status: LessonStatusFilter;
  /** Смена фильтра по статусу. */
  onStatusChange: (status: LessonStatusFilter) => void;
  /** Показать следующую страницу списка. */
  onLoadMore: () => void;
  /** Перечитать список: и «Обновить», и повтор после ошибки. */
  onRetry: () => void;
  /** Открыть диалог создания урока (пустое состояние зовёт именно его). */
  onCreate: () => void;
}

/** Ключ действия в комнате урока: зависит от того, начат ли урок. */
function roomActionKey(status: LessonStatus): string {
  if (status === 'in_progress') {
    return 'list.actions.continue';
  }

  return status === 'completed' ? 'list.actions.review' : 'list.actions.start';
}

/** Свойства строки списка. */
interface LessonRowProps {
  lesson: Lesson;
  /** В этой строке открыто подтверждение удаления. */
  confirming: boolean;
  /** Запрос на удаление этого урока уже отправлен. */
  isDeleting: boolean;
  /** Показать подтверждение удаления. */
  onRequestDelete: (lessonId: string) => void;
  /** Удаление подтверждено. */
  onConfirmDelete: (lessonId: string) => void;
  /** Удаление отменено. */
  onCancelDelete: () => void;
}

/** Строка списка: название, статус, свойства урока, переходы и удаление. */
function LessonRow({
  lesson,
  confirming,
  isDeleting,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: LessonRowProps) {
  const t = useT('lessons');
  const { formatDateTime } = useLessonFormatters();
  const statusText = useLessonStatusText();
  const status = statusText(lesson.status);
  const titleId = useId();

  return (
    <li className="lt-list__item">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--lt-space-xs)' }}>
        <h3 id={titleId} style={{ margin: 0, fontSize: '1rem' }}>
          {lesson.title}
        </h3>
        <span>
          <span className={`lt-badge lt-badge--${status.tone}`} data-status={lesson.status}>
            {status.label}
          </span>
        </span>
        <span className="lt-status">
          {t('list.fields.createdAt', { date: formatDateTime(lesson.createdAt) })}
        </span>
        <span className="lt-status">
          {t('list.fields.topic', { topic: lesson.topic?.trim() || t('list.noTopic') })}
        </span>
        <span className="lt-status">
          {t('list.fields.duration', { minutes: lesson.plannedMinutes })} ·{' '}
          {t('list.fields.level', { level: lesson.level })} ·{' '}
          {t('list.fields.steps', { count: lesson.plan.length })}
        </span>
      </div>
      <div className="lt-toolbar" style={{ marginBottom: 0 }}>
        <Link className="lt-button" to={lessonRoomPath(lesson.id)} aria-describedby={titleId}>
          {t(roomActionKey(lesson.status))}
        </Link>
        <Link className="lt-button" to={lessonPlanPath(lesson.id)} aria-describedby={titleId}>
          {t('list.actions.openPlan')}
        </Link>
        <button
          type="button"
          className="lt-button"
          aria-describedby={titleId}
          disabled={confirming}
          onClick={() => {
            onRequestDelete(lesson.id);
          }}
        >
          {t('common:actions.delete')}
        </button>
      </div>
      {confirming && (
        <DeleteLessonConfirm
          lesson={lesson}
          isDeleting={isDeleting}
          onConfirm={() => {
            onConfirmDelete(lesson.id);
          }}
          onCancel={onCancelDelete}
        />
      )}
    </li>
  );
}

/** Список уроков с фильтром по статусу и переходами в урок и в его план. */
export function LessonList({
  lessons,
  total,
  isLoading,
  isError,
  error,
  hasMore,
  status,
  onStatusChange,
  onLoadMore,
  onRetry,
  onCreate,
}: LessonListProps) {
  const t = useT('lessons');
  const toErrorMessage = useLessonErrorMessage();
  const statusText = useLessonStatusText();
  const remove = useDeleteLesson();
  const headingId = useId();
  const filterId = `${headingId}-filter`;
  const isEmpty = !isLoading && !isError && lessons.length === 0;
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // 404 значит, что урок удалён где-то ещё: показывать такой отказ незачем.
  const deleteError = remove.error !== null && !isLessonAlreadyDeleted(remove.error);

  const confirmDelete = (lessonId: string): void => {
    remove.mutate(lessonId, {
      onSuccess: () => {
        setConfirmingId(null);
      },
      onError: (error) => {
        if (isLessonAlreadyDeleted(error)) {
          setConfirmingId(null);
        }
      },
    });
  };

  return (
    <section className="lt-card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t('list.title')}</h2>

      <div className="lt-toolbar">
        <label className="lt-field__label" htmlFor={filterId}>
          {t('list.filter.label')}
        </label>
        <select
          id={filterId}
          value={status}
          onChange={(event) => {
            onStatusChange(event.target.value as LessonStatusFilter);
          }}
        >
          <option value="all">{t('list.filter.all')}</option>
          {LESSON_STATUSES.map((value) => (
            <option key={value} value={value}>
              {statusText(value).label}
            </option>
          ))}
        </select>
        <button type="button" className="lt-button" disabled={isLoading} onClick={onRetry}>
          {t('common:actions.refresh')}
        </button>
      </div>

      {isLoading && <LoadingBlock label={t('common:status.loading')} />}

      {isError && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p className="lt-banner__title">{t('list.error')}</p>
          <p>{toErrorMessage(error)}</p>
          <button type="button" className="lt-button" onClick={onRetry}>
            {t('common:actions.retry')}
          </button>
        </div>
      )}

      {isEmpty && status !== 'all' && <p className="lt-placeholder">{t('list.emptyFiltered')}</p>}

      {isEmpty && status === 'all' && (
        <div className="lt-placeholder">
          <p style={{ marginTop: 0 }}>{t('list.empty.title')}</p>
          <p>{t('list.empty.description')}</p>
          <button type="button" className="lt-button" onClick={onCreate}>
            {t('list.empty.action')}
          </button>
        </div>
      )}

      {lessons.length > 0 && (
        <>
          <p className="lt-status">{t('list.summary', { shown: lessons.length, total })}</p>
          <ul className="lt-list" aria-labelledby={headingId}>
            {lessons.map((lesson) => (
              <LessonRow
                key={lesson.id}
                lesson={lesson}
                confirming={lesson.id === confirmingId}
                isDeleting={remove.isPending && remove.variables === lesson.id}
                onRequestDelete={setConfirmingId}
                onConfirmDelete={confirmDelete}
                onCancelDelete={() => {
                  setConfirmingId(null);
                }}
              />
            ))}
          </ul>

          {hasMore && (
            <button type="button" className="lt-button" onClick={onLoadMore}>
              {t('list.loadMore')}
            </button>
          )}
        </>
      )}

      {deleteError && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p className="lt-banner__title">{t('errors.deleteFailed')}</p>
          <p>{toErrorMessage(remove.error)}</p>
        </div>
      )}
    </section>
  );
}
