/**
 * Ход урока: старт, реплики диалога, переходы по шагам, попытки, завершение.
 *
 * - `POST /api/lessons/:id/start` — урок переходит в `in_progress`, первый шаг
 *   становится активным, тьютор здоровается и открывает шаг;
 * - `POST /api/lessons/:id/turns` — реплика ученика и ответ тьютора вместе с
 *   исправлениями и, если тьютор счёл нужным, заданиями;
 * - `POST /api/lessons/:id/steps/:stepId/advance` — шаг закрывается
 *   (`completed`/`skipped`), открывается следующий с вводной репликой и заданиями;
 * - `POST /api/lessons/:id/exercises/:exerciseId/attempts` — разбор ответа ученика
 *   на задание: оценка, обратная связь и исправления;
 * - `POST /api/lessons/:id/complete` — итог урока, пересчёт уровня (A13), новые
 *   слова и записи журнала ошибок за урок;
 * - `GET /api/lessons/:id/messages` — история диалога для восстановления комнаты
 *   после перезагрузки.
 *
 * Правила занятия живут в `services/lessonSessionService.ts`, задания — в
 * `services/exerciseService.ts`, промпты — в `prompts/tutorTurn.ts`,
 * `prompts/exercise.ts` и `prompts/answerCheck.ts`. Здесь только разбор запроса
 * и перевод отказов модели в коды API: 501 `not_configured`,
 * 503 `upstream_unavailable`, 502 `upstream_error`.
 *
 * Отдельного эндпоинта генерации заданий в контракте нет: задания приезжают полем
 * `exercises[]` ответов `/turns` и `/advance`. Реплика ученика сохраняется до
 * обращения к модели, поэтому отказ провайдера не стоит ученику сказанного —
 * тот же ход можно просто повторить.
 */
import type { FastifyPluginAsync } from 'fastify';

import {
  advanceLessonStepRequestSchema,
  advanceLessonStepResponseSchema,
  completeLessonRequestSchema,
  completeLessonResponseSchema,
  createExerciseAttemptRequestSchema,
  createExerciseAttemptResponseSchema,
  lessonExerciseParamsSchema,
  lessonParamsSchema,
  lessonStepParamsSchema,
  lessonTurnRequestSchema,
  lessonTurnResponseSchema,
  listLessonMessagesQuerySchema,
  listLessonMessagesResponseSchema,
  startLessonRequestSchema,
  startLessonResponseSchema,
  type AdvanceLessonStepResponse,
  type CompleteLessonResponse,
  type CreateExerciseAttemptResponse,
  type LessonTurnResponse,
  type ListLessonMessagesResponse,
  type StartLessonResponse,
} from '@lt/shared';

import { parseBody, parseParams, parseQuery } from '../lib/validate.js';
import { providerErrorToAppError } from '../providers/types.js';
import {
  advanceLessonStep,
  completeLesson,
  listLessonMessages,
  startLesson,
  submitExerciseAttempt,
  submitLessonTurn,
} from '../services/lessonSessionService.js';

/** Маршруты хода урока. */
export const lessonSessionRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/lessons/:id/start',
    { schema: { response: { 200: startLessonResponseSchema } } },
    async (request): Promise<StartLessonResponse> => {
      const { id } = parseParams(request, lessonParamsSchema);

      parseBody(request, startLessonRequestSchema);

      try {
        return await startLesson(id, { logger: request.log });
      } catch (error) {
        throw providerErrorToAppError(error, 'llm');
      }
    },
  );

  app.post(
    '/lessons/:id/turns',
    { schema: { response: { 200: lessonTurnResponseSchema } } },
    async (request): Promise<LessonTurnResponse> => {
      const { id } = parseParams(request, lessonParamsSchema);
      const body = parseBody(request, lessonTurnRequestSchema);

      try {
        return await submitLessonTurn(id, body, { logger: request.log });
      } catch (error) {
        throw providerErrorToAppError(error, 'llm');
      }
    },
  );

  app.post(
    '/lessons/:id/steps/:stepId/advance',
    { schema: { response: { 200: advanceLessonStepResponseSchema } } },
    async (request): Promise<AdvanceLessonStepResponse> => {
      const { id, stepId } = parseParams(request, lessonStepParamsSchema);
      const body = parseBody(request, advanceLessonStepRequestSchema);

      try {
        return await advanceLessonStep(id, stepId, body, { logger: request.log });
      } catch (error) {
        throw providerErrorToAppError(error, 'llm');
      }
    },
  );

  app.post(
    '/lessons/:id/exercises/:exerciseId/attempts',
    { schema: { response: { 201: createExerciseAttemptResponseSchema } } },
    async (request, reply): Promise<CreateExerciseAttemptResponse> => {
      const { id, exerciseId } = parseParams(request, lessonExerciseParamsSchema);
      const body = parseBody(request, createExerciseAttemptRequestSchema);

      try {
        const attempt = await submitExerciseAttempt(id, exerciseId, body, {
          logger: request.log,
        });

        reply.status(201);

        return attempt;
      } catch (error) {
        throw providerErrorToAppError(error, 'llm');
      }
    },
  );

  app.post(
    '/lessons/:id/complete',
    { schema: { response: { 200: completeLessonResponseSchema } } },
    async (request): Promise<CompleteLessonResponse> => {
      const { id } = parseParams(request, lessonParamsSchema);
      const body = parseBody(request, completeLessonRequestSchema);

      try {
        return await completeLesson(id, body, { logger: request.log });
      } catch (error) {
        throw providerErrorToAppError(error, 'llm');
      }
    },
  );

  app.get(
    '/lessons/:id/messages',
    { schema: { response: { 200: listLessonMessagesResponseSchema } } },
    (request): ListLessonMessagesResponse =>
      listLessonMessages(
        parseParams(request, lessonParamsSchema).id,
        parseQuery(request, listLessonMessagesQuerySchema),
      ),
  );
};
