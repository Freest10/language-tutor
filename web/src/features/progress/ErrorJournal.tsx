/**
 * Журнал ошибок: что было сказано, как правильно, почему и в каком уроке.
 *
 * Переключатели категорий строятся по `countsByCategory` ответа. Счётчики
 * фасетные — собственный фильтр `category` в них не учтён, поэтому соседние
 * категории остаются видимыми и ненулевыми и при выбранном фильтре: ученик
 * переключается между категориями, не сбрасывая фильтр «в никуда».
 *
 * Нижняя граница периода считается в момент выбора и хранится в состоянии:
 * если считать её при каждом рендере, значение менялось бы вместе с часами
 * и запрос уходил бы бесконечно.
 */
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { ERROR_CATEGORIES, type ErrorCategory, type ErrorLogEntry } from '@lt/shared';

import {
  ERROR_PERIODS,
  errorPeriodSince,
  isErrorPeriod,
  PROGRESS_PAGE_SIZE,
  useErrorJournal,
  useProgressFormatters,
  type ErrorPeriod,
} from './useProgress';

import { useApiErrorMessage, useT } from '../../i18n/useT';
import { lessonPlanPath } from '../../router';

/** Свойства журнала ошибок. */
export interface ErrorJournalProps {
  /** Сколько записей показывать на одной странице. */
  pageSize?: number;
}

/** Значение фильтра по категории: `all` — без ограничения. */
type CategoryFilter = ErrorCategory | 'all';

/** Группа записей одной категории. */
interface ErrorGroup {
  category: ErrorCategory;
  entries: ErrorLogEntry[];
}

/** Раскладывает страницу журнала по категориям в порядке `ERROR_CATEGORIES`. */
function groupByCategory(entries: ErrorLogEntry[]): ErrorGroup[] {
  return ERROR_CATEGORIES.map((category) => ({
    category,
    entries: entries.filter((entry) => entry.category === category),
  })).filter((group) => group.entries.length > 0);
}

/** Свойства таблицы одной категории. */
interface ErrorGroupTableProps {
  group: ErrorGroup;
}

/** Записи одной категории: фрагмент, исправление, объяснение и ссылка на урок. */
function ErrorGroupTable({ group }: ErrorGroupTableProps) {
  const t = useT('progress');
  const { formatDateTime } = useProgressFormatters();

  return (
    <table className="lt-table">
      <caption>
        {t('errors.groupCaption', { category: t(`errors.category.${group.category}`) })}
        {' · '}
        {t('common:units.errors', { count: group.entries.length })}
      </caption>
      <thead>
        <tr>
          <th scope="col">{t('errors.columns.occurredAt')}</th>
          <th scope="col">{t('errors.columns.original')}</th>
          <th scope="col">{t('errors.columns.corrected')}</th>
          <th scope="col">{t('errors.columns.explanation')}</th>
          <th scope="col">{t('errors.columns.lesson')}</th>
        </tr>
      </thead>
      <tbody>
        {group.entries.map((entry) => (
          <tr key={entry.id}>
            <td>{formatDateTime(entry.occurredAt)}</td>
            <th scope="row">
              <span>{entry.original}</span>{' '}
              <span
                className={
                  entry.severity === 'major'
                    ? 'lt-badge lt-badge--warn'
                    : 'lt-badge lt-badge--muted'
                }
              >
                {t(`errors.severity.${entry.severity}`)}
              </span>
            </th>
            <td>
              {entry.corrected.length > 0 ? (
                entry.corrected
              ) : (
                <span className="lt-status">{t('errors.noCorrection')}</span>
              )}
            </td>
            <td>{entry.explanation}</td>
            <td>
              {entry.lessonId ? (
                <Link to={lessonPlanPath(entry.lessonId)}>{t('errors.lessonLink')}</Link>
              ) : (
                <span className="lt-status">{t('errors.noLesson')}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Журнал ошибок с фильтрами по категории и периоду и группировкой по категориям. */
export function ErrorJournal({ pageSize = PROGRESS_PAGE_SIZE }: ErrorJournalProps = {}) {
  const t = useT('progress');
  const toApiErrorMessage = useApiErrorMessage();
  const headingId = useId();
  const periodId = useId();

  const [category, setCategory] = useState<CategoryFilter>('all');
  const [period, setPeriod] = useState<ErrorPeriod>('all');
  const [since, setSince] = useState<string | undefined>(undefined);
  const [offset, setOffset] = useState(0);

  const {
    items,
    total,
    hasMore,
    countsByCategory,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useErrorJournal({
    limit: pageSize,
    offset,
    category: category === 'all' ? undefined : category,
    since,
    order: 'desc',
  });

  const groups = useMemo(() => groupByCategory(items), [items]);
  const hasFilters = category !== 'all' || period !== 'all';

  const resetFilters = (): void => {
    setCategory('all');
    setPeriod('all');
    setSince(undefined);
    setOffset(0);
  };

  return (
    <section className="lt-card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t('errors.title')}</h2>
      <p className="lt-page__lead">{t('errors.lead')}</p>

      <div className="lt-toolbar" role="group" aria-label={t('errors.categoryLabel')}>
        <button
          type="button"
          className={category === 'all' ? 'lt-chip lt-chip--selected' : 'lt-chip'}
          aria-pressed={category === 'all'}
          onClick={() => {
            setCategory('all');
            setOffset(0);
          }}
        >
          {t('errors.categoryAll')}
        </button>
        {ERROR_CATEGORIES.map((value) => (
          <button
            key={value}
            type="button"
            className={category === value ? 'lt-chip lt-chip--selected' : 'lt-chip'}
            aria-pressed={category === value}
            onClick={() => {
              setCategory(value);
              setOffset(0);
            }}
          >
            {t('errors.categoryOption', {
              category: t(`errors.category.${value}`),
              count: countsByCategory[value] ?? 0,
            })}
          </button>
        ))}
      </div>

      <div className="lt-field">
        <label className="lt-field__label" htmlFor={periodId}>
          {t('errors.periodLabel')}
        </label>
        <select
          id={periodId}
          value={period}
          onChange={(event) => {
            const next = isErrorPeriod(event.target.value) ? event.target.value : 'all';

            setPeriod(next);
            setSince(errorPeriodSince(next));
            setOffset(0);
          }}
        >
          {ERROR_PERIODS.map((value) => (
            <option key={value} value={value}>
              {t(`errors.period.${value}`)}
            </option>
          ))}
        </select>
      </div>

      {isLoading && (
        <p className="lt-placeholder" role="status">
          {t('common:status.loading')}
        </p>
      )}

      {isError && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p className="lt-banner__title">{t('errors.error')}</p>
          <p>{toApiErrorMessage(error)}</p>
          <button type="button" className="lt-button" onClick={refetch}>
            {t('common:actions.retry')}
          </button>
        </div>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <>
          <p className="lt-placeholder">
            {hasFilters ? t('errors.emptyFiltered') : t('errors.empty')}
          </p>
          {hasFilters && (
            <button type="button" className="lt-button" onClick={resetFilters}>
              {t('errors.resetFilters')}
            </button>
          )}
        </>
      )}

      {!isError && items.length > 0 && (
        <>
          {isFetching && (
            <p className="lt-status" role="status">
              {t('errors.updating')}
            </p>
          )}
          {groups.map((group) => (
            <ErrorGroupTable key={group.category} group={group} />
          ))}

          <div className="lt-toolbar">
            <p className="lt-status">
              {t('errors.range', { from: offset + 1, to: offset + items.length, total })}
            </p>
            <button
              type="button"
              className="lt-button"
              disabled={offset === 0}
              onClick={() => {
                setOffset((current) => Math.max(0, current - pageSize));
              }}
            >
              {t('errors.previousPage')}
            </button>
            <button
              type="button"
              className="lt-button"
              disabled={!hasMore}
              onClick={() => {
                setOffset((current) => current + pageSize);
              }}
            >
              {t('errors.nextPage')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
