/**
 * Данные раздела прогресса: сводка, словарь, журнал ошибок и история уровня.
 *
 * Хуки и ключи запросов вынесены отдельно от компонентов, чтобы блоки страницы
 * (и, при необходимости, карточки на других экранах) попадали в один кэш.
 *
 * Соглашение о ключах: первый элемент — namespace фичи (`['progress', ...]`),
 * поэтому инвалидация по `PROGRESS_QUERY_KEY` задевает весь раздел целиком.
 *
 * Фильтры и пагинация входят в ключ запроса: смена фильтра — это другой запрос,
 * а не перерисовка того же. Пока новая страница едет, показывается предыдущая
 * (`keepPreviousData`), чтобы таблица не схлопывалась под курсором.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import {
  ERROR_CATEGORIES,
  type ErrorCategory,
  type ErrorLogEntry,
  type LevelHistoryEntry,
  type ProgressSummary,
  type SortOrder,
  type VocabularyItem,
  type VocabularySortField,
} from '@lt/shared';

import { ApiError } from '../../api/client';
import {
  getProgressSummary,
  listErrors,
  listLevelHistory,
  listVocabulary,
  type ListErrorsParams,
  type ListLevelHistoryParams,
  type ListVocabularyParams,
} from '../../api/progress';
import { useLocale } from '../../i18n/useT';
import { formatDate, formatDateTime } from '../../lib/format';

/** Корень ключей запросов фичи: по нему инвалидируется весь раздел. */
export const PROGRESS_QUERY_KEY = ['progress'] as const;

/** Ключи запросов прогресса. */
export const progressQueryKeys = {
  /** Весь раздел целиком. */
  all: PROGRESS_QUERY_KEY,
  /** Сводка прогресса. */
  summary: () => [...PROGRESS_QUERY_KEY, 'summary'] as const,
  /** Страница словаря с конкретным набором фильтров. */
  vocabulary: (params: ListVocabularyParams) =>
    [...PROGRESS_QUERY_KEY, 'vocabulary', params] as const,
  /** Страница журнала ошибок с конкретным набором фильтров. */
  errors: (params: ListErrorsParams) => [...PROGRESS_QUERY_KEY, 'errors', params] as const,
  /** Страница истории уровня. */
  levelHistory: (params: ListLevelHistoryParams) =>
    [...PROGRESS_QUERY_KEY, 'levelHistory', params] as const,
};

/** Сколько строк словаря и записей журнала показывается на одной странице. */
export const PROGRESS_PAGE_SIZE = 10;

/** Сколько записей истории уровня подгружается за раз. */
export const LEVEL_HISTORY_PAGE_SIZE = 10;

/** Сводка прогресса и состояние её загрузки. */
export interface UseProgressSummaryResult {
  /** Сводка с сервера; `null` — ещё не загружена или запрос не удался. */
  summary: ProgressSummary | null;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: ApiError | null;
  refetch: () => void;
}

/** Сводка прогресса: уровень, уроки, лексика, ошибки, серии занятий. */
export function useProgressSummary(): UseProgressSummaryResult {
  const { data, error, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: progressQueryKeys.summary(),
    queryFn: ({ signal }) => getProgressSummary(signal),
  });

  const refresh = useCallback((): void => {
    void refetch();
  }, [refetch]);

  return {
    summary: data ?? null,
    isLoading,
    isFetching,
    isError,
    error: error ? ApiError.from(error) : null,
    refetch: refresh,
  };
}

/** Страница личного словаря и состояние её загрузки. */
export interface UseVocabularyResult {
  items: VocabularyItem[];
  /** Сколько слов всего при текущих фильтрах. */
  total: number;
  /** Смещение показанной страницы. */
  offset: number;
  /** Есть ли слова за пределами показанной страницы. */
  hasMore: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: ApiError | null;
  refetch: () => void;
}

/** Личный словарь с фильтрами, поиском и сортировкой. */
export function useVocabulary(params: ListVocabularyParams = {}): UseVocabularyResult {
  const { data, error, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: progressQueryKeys.vocabulary(params),
    queryFn: ({ signal }) => listVocabulary(params, signal),
    placeholderData: keepPreviousData,
  });

  const refresh = useCallback((): void => {
    void refetch();
  }, [refetch]);

  return {
    items: data?.items ?? [],
    total: data?.total ?? 0,
    offset: data?.offset ?? 0,
    hasMore: data?.hasMore ?? false,
    isLoading,
    isFetching,
    isError,
    error: error ? ApiError.from(error) : null,
    refetch: refresh,
  };
}

/** Счётчики по всем категориям ошибок. */
export type ErrorCategoryCounts = Record<ErrorCategory, number>;

/** Нулевые счётчики: используются, пока ответа нет, чтобы переключатели не пропадали. */
export const EMPTY_ERROR_CATEGORY_COUNTS: ErrorCategoryCounts = Object.fromEntries(
  ERROR_CATEGORIES.map((category) => [category, 0]),
) as ErrorCategoryCounts;

/** Страница журнала ошибок и состояние её загрузки. */
export interface UseErrorJournalResult {
  items: ErrorLogEntry[];
  /** Сколько записей всего при текущих фильтрах. */
  total: number;
  /** Смещение показанной страницы. */
  offset: number;
  /** Есть ли записи за пределами показанной страницы. */
  hasMore: boolean;
  /**
   * Счётчики по всем пяти категориям. Фасетные: собственный фильтр `category`
   * в них не учтён, поэтому по ним можно рисовать переключатели категорий —
   * соседние счётчики остаются ненулевыми и при выбранной категории.
   */
  countsByCategory: ErrorCategoryCounts;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: ApiError | null;
  refetch: () => void;
}

/** Журнал ошибок с фильтрами по категории и периоду. */
export function useErrorJournal(params: ListErrorsParams = {}): UseErrorJournalResult {
  const { data, error, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: progressQueryKeys.errors(params),
    queryFn: ({ signal }) => listErrors(params, signal),
    placeholderData: keepPreviousData,
  });

  const refresh = useCallback((): void => {
    void refetch();
  }, [refetch]);

  return {
    items: data?.items ?? [],
    total: data?.total ?? 0,
    offset: data?.offset ?? 0,
    hasMore: data?.hasMore ?? false,
    countsByCategory: data
      ? { ...EMPTY_ERROR_CATEGORY_COUNTS, ...data.countsByCategory }
      : EMPTY_ERROR_CATEGORY_COUNTS,
    isLoading,
    isFetching,
    isError,
    error: error ? ApiError.from(error) : null,
    refetch: refresh,
  };
}

/** Страница истории уровня и состояние её загрузки. */
export interface UseLevelHistoryResult {
  items: LevelHistoryEntry[];
  /** Сколько изменений уровня всего. */
  total: number;
  /** Есть ли записи за пределами показанной страницы. */
  hasMore: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: ApiError | null;
  refetch: () => void;
}

/** История изменений уровня: от свежих к давним. */
export function useLevelHistory(params: ListLevelHistoryParams = {}): UseLevelHistoryResult {
  const { data, error, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: progressQueryKeys.levelHistory(params),
    queryFn: ({ signal }) => listLevelHistory(params, signal),
    placeholderData: keepPreviousData,
  });

  const refresh = useCallback((): void => {
    void refetch();
  }, [refetch]);

  return {
    items: data?.items ?? [],
    total: data?.total ?? 0,
    hasMore: data?.hasMore ?? false,
    isLoading,
    isFetching,
    isError,
    error: error ? ApiError.from(error) : null,
    refetch: refresh,
  };
}

/** Категория ошибки вместе с числом записей в ней. */
export interface ErrorCategoryCount {
  category: ErrorCategory;
  count: number;
}

/**
 * Категории ошибок от частых к редким.
 *
 * Порядок при равных счётчиках задаётся `ERROR_CATEGORIES`, чтобы список
 * не переставлялся между рендерами на пустых данных.
 */
export function sortedErrorCategories(counts: Partial<ErrorCategoryCounts>): ErrorCategoryCount[] {
  return ERROR_CATEGORIES.map((category) => ({ category, count: counts[category] ?? 0 })).sort(
    (left, right) =>
      right.count - left.count ||
      ERROR_CATEGORIES.indexOf(left.category) - ERROR_CATEGORIES.indexOf(right.category),
  );
}

/** Период журнала ошибок: `all` — без нижней границы. */
export const ERROR_PERIODS = ['all', 'week', 'month', 'quarter'] as const;

/** Период журнала ошибок. */
export type ErrorPeriod = (typeof ERROR_PERIODS)[number];

/** Сколько дней охватывает период; `null` — без нижней границы. */
export const ERROR_PERIOD_DAYS: Record<ErrorPeriod, number | null> = {
  all: null,
  week: 7,
  month: 30,
  quarter: 90,
};

/**
 * Нижняя граница периода в ISO-8601.
 *
 * Считается один раз в обработчике выбора, а не при каждом рендере: иначе
 * значение менялось бы вместе с часами и запрос уходил бы бесконечно.
 *
 * @param period выбранный период.
 * @param now момент отсчёта; по умолчанию текущее время.
 * @returns момент времени или `undefined`, если период не ограничен снизу.
 */
export function errorPeriodSince(
  period: ErrorPeriod,
  now: number = Date.now(),
): string | undefined {
  const days = ERROR_PERIOD_DAYS[period];

  return days === null ? undefined : new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Поддерживается ли значение как период журнала ошибок. */
export function isErrorPeriod(value: string): value is ErrorPeriod {
  return (ERROR_PERIODS as readonly string[]).includes(value);
}

/** Порядок сортировки, естественный для поля: по алфавиту — вперёд, остальное — от большего. */
export function defaultVocabularyOrder(sort: VocabularySortField): SortOrder {
  return sort === 'alphabetical' ? 'asc' : 'desc';
}

/** Форматирование дат, долей и чисел по языку интерфейса. */
export interface ProgressFormatters {
  /** Только дата: `15 сент. 2026 г.` */
  formatDate: (isoDate: string) => string;
  /** Дата и время: у записей журнала важен и час. */
  formatDateTime: (isoDate: string) => string;
  /** Доля 0..1 в процентах без дробной части. */
  formatPercent: (ratio: number) => string;
  /** Целое число с разделителями разрядов. */
  formatNumber: (value: number) => string;
}

/** Форматирование дат, долей и чисел по текущему языку интерфейса. */
export function useProgressFormatters(): ProgressFormatters {
  const { locale } = useLocale();

  return useMemo(() => {
    const percentFormat = new Intl.NumberFormat(locale, {
      style: 'percent',
      maximumFractionDigits: 0,
    });
    const numberFormat = new Intl.NumberFormat(locale);

    return {
      formatDate: (isoDate: string) => formatDate(isoDate, locale),
      formatDateTime: (isoDate: string) => formatDateTime(isoDate, locale),
      formatPercent: (ratio: number) => percentFormat.format(ratio),
      formatNumber: (value: number) => numberFormat.format(value),
    };
  }, [locale]);
}
