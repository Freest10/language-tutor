/**
 * Обращения к `/api/progress`: сводка, личный словарь, журнал ошибок и история уровня.
 *
 * Модуль знает только про HTTP и схемы `@lt/shared`; кэш, фильтры и состояния
 * интерфейса живут в `features/progress/useProgress.ts`.
 *
 * Все четыре маршрута только читают: уровень пересчитывается ходом урока
 * (допущение A13), поэтому мутаций у раздела прогресса нет.
 */
import {
  getProgressSummaryResponseSchema,
  listErrorsResponseSchema,
  listLevelHistoryResponseSchema,
  listVocabularyResponseSchema,
  type ErrorCategory,
  type GetProgressSummaryResponse,
  type LanguageCode,
  type ListErrorsResponse,
  type ListLevelHistoryResponse,
  type ListVocabularyResponse,
  type SortOrder,
  type VocabularySortField,
  type VocabularyStatus,
} from '@lt/shared';

import { api } from './client';

/** Корень путей раздела прогресса (без префикса `/api` — его добавляет клиент). */
export const PROGRESS_PATH = '/progress';

/** Путь сводки прогресса. */
export const PROGRESS_SUMMARY_PATH = `${PROGRESS_PATH}/summary`;

/** Путь личного словаря. */
export const PROGRESS_VOCABULARY_PATH = `${PROGRESS_PATH}/vocabulary`;

/** Путь журнала ошибок. */
export const PROGRESS_ERRORS_PATH = `${PROGRESS_PATH}/errors`;

/** Путь истории изменений уровня. */
export const PROGRESS_LEVEL_HISTORY_PATH = `${PROGRESS_PATH}/level-history`;

/** `GET /api/progress/summary` — сводка прогресса целиком. */
export function getProgressSummary(signal?: AbortSignal): Promise<GetProgressSummaryResponse> {
  return api.get(PROGRESS_SUMMARY_PATH, {
    schema: getProgressSummaryResponseSchema,
    signal,
  });
}

/** Параметры личного словаря; пустые значения в query не уходят. */
export interface ListVocabularyParams {
  limit?: number;
  offset?: number;
  status?: VocabularyStatus;
  language?: LanguageCode;
  lessonId?: string;
  search?: string;
  sort?: VocabularySortField;
  order?: SortOrder;
}

/** `GET /api/progress/vocabulary` — страница личного словаря. */
export function listVocabulary(
  params: ListVocabularyParams = {},
  signal?: AbortSignal,
): Promise<ListVocabularyResponse> {
  return api.get(PROGRESS_VOCABULARY_PATH, {
    query: {
      limit: params.limit,
      offset: params.offset,
      status: params.status,
      language: params.language,
      lessonId: params.lessonId,
      search: params.search,
      sort: params.sort,
      order: params.order,
    },
    schema: listVocabularyResponseSchema,
    signal,
  });
}

/** Параметры журнала ошибок; `since`/`until` — момент времени в ISO-8601. */
export interface ListErrorsParams {
  limit?: number;
  offset?: number;
  category?: ErrorCategory;
  lessonId?: string;
  since?: string;
  until?: string;
  order?: SortOrder;
}

/** `GET /api/progress/errors` — страница журнала ошибок со счётчиками по категориям. */
export function listErrors(
  params: ListErrorsParams = {},
  signal?: AbortSignal,
): Promise<ListErrorsResponse> {
  return api.get(PROGRESS_ERRORS_PATH, {
    query: {
      limit: params.limit,
      offset: params.offset,
      category: params.category,
      lessonId: params.lessonId,
      since: params.since,
      until: params.until,
      order: params.order,
    },
    schema: listErrorsResponseSchema,
    signal,
  });
}

/** Параметры истории уровня. */
export interface ListLevelHistoryParams {
  limit?: number;
  offset?: number;
  order?: SortOrder;
}

/** `GET /api/progress/level-history` — страница истории изменений уровня. */
export function listLevelHistory(
  params: ListLevelHistoryParams = {},
  signal?: AbortSignal,
): Promise<ListLevelHistoryResponse> {
  return api.get(PROGRESS_LEVEL_HISTORY_PATH, {
    query: {
      limit: params.limit,
      offset: params.offset,
      order: params.order,
    },
    schema: listLevelHistoryResponseSchema,
    signal,
  });
}
