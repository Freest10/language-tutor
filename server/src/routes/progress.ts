/**
 * Прогресс: сводка, словарь, журнал ошибок, история уровня.
 *
 * - `GET /api/progress/summary` — уровень и его история, счётчики лексики, топ
 *   категорий ошибок, серии занятий и готовность уровня к пересчёту (A13);
 * - `GET /api/progress/vocabulary` — личный словарь с фильтрами и сортировкой;
 * - `GET /api/progress/errors` — журнал ошибок со счётчиками по категориям;
 * - `GET /api/progress/level-history` — история изменений уровня.
 *
 * Все четыре маршрута только читают: уровень пересчитывается ходом урока через
 * `progressService.maybeAdjustLevel()`, а не запросом с экрана прогресса.
 */
import type { FastifyPluginAsync } from 'fastify';

import {
  getProgressSummaryResponseSchema,
  listErrorsQuerySchema,
  listErrorsResponseSchema,
  listLevelHistoryQuerySchema,
  listLevelHistoryResponseSchema,
  listVocabularyQuerySchema,
  listVocabularyResponseSchema,
  type GetProgressSummaryResponse,
  type ListErrorsResponse,
  type ListLevelHistoryResponse,
  type ListVocabularyResponse,
} from '@lt/shared';

import { parseQuery } from '../lib/validate.js';
import {
  getProgressSummary,
  listErrors,
  listLevelHistory,
  listVocabulary,
} from '../services/progressService.js';

/** Маршруты прогресса. */
export const progressRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/progress/summary',
    { schema: { response: { 200: getProgressSummaryResponseSchema } } },
    (): GetProgressSummaryResponse => getProgressSummary(),
  );

  app.get(
    '/progress/vocabulary',
    { schema: { response: { 200: listVocabularyResponseSchema } } },
    (request): ListVocabularyResponse =>
      listVocabulary(parseQuery(request, listVocabularyQuerySchema)),
  );

  app.get(
    '/progress/errors',
    { schema: { response: { 200: listErrorsResponseSchema } } },
    (request): ListErrorsResponse => listErrors(parseQuery(request, listErrorsQuerySchema)),
  );

  app.get(
    '/progress/level-history',
    { schema: { response: { 200: listLevelHistoryResponseSchema } } },
    (request): ListLevelHistoryResponse =>
      listLevelHistory(parseQuery(request, listLevelHistoryQuerySchema)),
  );
};
