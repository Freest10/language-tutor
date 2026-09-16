/**
 * Личный словарь: поиск, фильтр по стадии освоения, сортировка и пагинация.
 *
 * Фильтры держатся в состоянии блока и уходят в query-параметры запроса, а не
 * фильтруют уже полученную страницу: словарь может быть длиннее страницы, и
 * «поиск по видимому» врал бы о результате.
 *
 * Поиск применяется по отправке формы, а не на каждое нажатие клавиши: запрос
 * на каждый символ нагружает локальный сервер и мешает экранной читалке.
 */
import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import {
  SORT_ORDERS,
  VOCABULARY_SORT_FIELDS,
  VOCABULARY_STATUSES,
  type SortOrder,
  type VocabularySortField,
  type VocabularyStatus,
} from '@lt/shared';

import {
  defaultVocabularyOrder,
  PROGRESS_PAGE_SIZE,
  useProgressFormatters,
  useVocabulary,
} from './useProgress';

import { useApiErrorMessage, useT } from '../../i18n/useT';
import { lessonPlanPath } from '../../router';

/** Свойства таблицы словаря. */
export interface VocabularyTableProps {
  /** Сколько слов показывать на одной странице. */
  pageSize?: number;
}

/** Значение фильтра по стадии: `all` — без ограничения. */
type StatusFilter = VocabularyStatus | 'all';

/** Значение селекта как стадия освоения; `all` — фильтр снят. */
function toStatusFilter(value: string): StatusFilter {
  return VOCABULARY_STATUSES.find((status) => status === value) ?? 'all';
}

/** Значение селекта как поле сортировки; неизвестное — сортировка по умолчанию. */
function toSortField(value: string): VocabularySortField {
  return VOCABULARY_SORT_FIELDS.find((field) => field === value) ?? 'recent';
}

/** Значение селекта как направление сортировки. */
function toSortOrder(value: string): SortOrder {
  return SORT_ORDERS.find((order) => order === value) ?? 'desc';
}

/** Личный словарь ученика с фильтрами, сортировкой и постраничным просмотром. */
export function VocabularyTable({ pageSize = PROGRESS_PAGE_SIZE }: VocabularyTableProps = {}) {
  const t = useT('progress');
  const toApiErrorMessage = useApiErrorMessage();
  const { formatDate, formatNumber } = useProgressFormatters();
  const headingId = useId();
  const searchId = useId();
  const statusId = useId();
  const sortId = useId();
  const orderId = useId();

  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<VocabularySortField>('recent');
  const [order, setOrder] = useState<SortOrder>(defaultVocabularyOrder('recent'));
  const [offset, setOffset] = useState(0);

  const { items, total, hasMore, isLoading, isFetching, isError, error, refetch } = useVocabulary({
    limit: pageSize,
    offset,
    status: status === 'all' ? undefined : status,
    search: search.length > 0 ? search : undefined,
    sort,
    order,
  });

  const hasFilters = search.length > 0 || status !== 'all';

  const submitSearch = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSearch(draft.trim());
    setOffset(0);
  };

  const resetFilters = (): void => {
    setDraft('');
    setSearch('');
    setStatus('all');
    setOffset(0);
  };

  return (
    <section className="lt-card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t('vocabulary.title')}</h2>
      <p className="lt-page__lead">{t('vocabulary.lead')}</p>

      <form className="lt-toolbar" role="search" onSubmit={submitSearch}>
        <div className="lt-field">
          <label className="lt-field__label" htmlFor={searchId}>
            {t('vocabulary.searchLabel')}
          </label>
          <input
            id={searchId}
            type="text"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </div>
        <button type="submit" className="lt-button">
          {t('vocabulary.searchSubmit')}
        </button>
        {search.length > 0 && (
          <button
            type="button"
            className="lt-button"
            onClick={() => {
              setDraft('');
              setSearch('');
              setOffset(0);
            }}
          >
            {t('vocabulary.searchClear')}
          </button>
        )}
      </form>

      <div className="lt-toolbar">
        <div className="lt-field">
          <label className="lt-field__label" htmlFor={statusId}>
            {t('vocabulary.statusLabel')}
          </label>
          <select
            id={statusId}
            value={status}
            onChange={(event) => {
              setStatus(toStatusFilter(event.target.value));
              setOffset(0);
            }}
          >
            <option value="all">{t('vocabulary.statusAll')}</option>
            {VOCABULARY_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`vocabulary.status.${value}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="lt-field">
          <label className="lt-field__label" htmlFor={sortId}>
            {t('vocabulary.sortLabel')}
          </label>
          <select
            id={sortId}
            value={sort}
            onChange={(event) => {
              const next = toSortField(event.target.value);

              setSort(next);
              // Естественный порядок у полей разный: по алфавиту — вперёд, у остальных — от большего.
              setOrder(defaultVocabularyOrder(next));
              setOffset(0);
            }}
          >
            {VOCABULARY_SORT_FIELDS.map((value) => (
              <option key={value} value={value}>
                {t(`vocabulary.sort.${value}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="lt-field">
          <label className="lt-field__label" htmlFor={orderId}>
            {t('vocabulary.orderLabel')}
          </label>
          <select
            id={orderId}
            value={order}
            onChange={(event) => {
              setOrder(toSortOrder(event.target.value));
              setOffset(0);
            }}
          >
            {SORT_ORDERS.map((value) => (
              <option key={value} value={value}>
                {t(`vocabulary.order.${value}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading && (
        <p className="lt-placeholder" role="status">
          {t('common:status.loading')}
        </p>
      )}

      {isError && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p className="lt-banner__title">{t('vocabulary.error')}</p>
          <p>{toApiErrorMessage(error)}</p>
          <button type="button" className="lt-button" onClick={refetch}>
            {t('common:actions.retry')}
          </button>
        </div>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <>
          <p className="lt-placeholder">
            {hasFilters ? t('vocabulary.emptyFiltered') : t('vocabulary.empty')}
          </p>
          {hasFilters && (
            <button type="button" className="lt-button" onClick={resetFilters}>
              {t('vocabulary.resetFilters')}
            </button>
          )}
        </>
      )}

      {!isError && items.length > 0 && (
        <>
          {isFetching && (
            <p className="lt-status" role="status">
              {t('vocabulary.updating')}
            </p>
          )}
          <table className="lt-table">
            <caption>{t('vocabulary.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('vocabulary.columns.term')}</th>
                <th scope="col">{t('vocabulary.columns.translation')}</th>
                <th scope="col">{t('vocabulary.columns.status')}</th>
                <th scope="col">{t('vocabulary.columns.timesSeen')}</th>
                <th scope="col">{t('vocabulary.columns.lastSeenAt')}</th>
                <th scope="col">{t('vocabulary.columns.lesson')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <th scope="row">
                    {item.term}
                    {item.transcription && <span className="lt-status"> {item.transcription}</span>}
                  </th>
                  <td>
                    {item.translation}
                    {item.partOfSpeech && <span className="lt-status"> {item.partOfSpeech}</span>}
                  </td>
                  <td>
                    <span className="lt-badge">{t(`vocabulary.status.${item.status}`)}</span>
                  </td>
                  <td>
                    {t('vocabulary.timesSeenValue', {
                      correct: formatNumber(item.timesCorrect),
                      seen: formatNumber(item.timesSeen),
                    })}
                  </td>
                  <td>{formatDate(item.lastSeenAt)}</td>
                  <td>
                    {item.lessonId ? (
                      <Link to={lessonPlanPath(item.lessonId)}>{t('vocabulary.lessonLink')}</Link>
                    ) : (
                      <span className="lt-status">{t('vocabulary.noLesson')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="lt-toolbar">
            <p className="lt-status">
              {t('vocabulary.range', {
                from: offset + 1,
                to: offset + items.length,
                total,
              })}
            </p>
            <button
              type="button"
              className="lt-button"
              disabled={offset === 0}
              onClick={() => {
                setOffset((current) => Math.max(0, current - pageSize));
              }}
            >
              {t('vocabulary.previousPage')}
            </button>
            <button
              type="button"
              className="lt-button"
              disabled={!hasMore}
              onClick={() => {
                setOffset((current) => current + pageSize);
              }}
            >
              {t('vocabulary.nextPage')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
