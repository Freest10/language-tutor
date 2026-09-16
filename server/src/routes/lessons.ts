/**
 * Уроки: список, создание с планом, просмотр, пересборка плана.
 *
 * - `GET /api/lessons` — список с фильтрами по статусу, языку и названию;
 * - `POST /api/lessons` — урок в статусе `draft` со сгенерированным планом (201);
 * - `GET /api/lessons/:id` — урок целиком, без реплик диалога;
 * - `POST /api/lessons/:id/plan/regenerate` — новый план с учётом пожеланий ученика.
 *
 * Правила планирования живут в `services/lessonPlanService.ts`, промпты —
 * в `prompts/lessonPlan.ts`. Здесь только разбор запроса и перевод отказов модели
 * в коды API: 501 `not_configured`, 503 `upstream_unavailable`, 502 `upstream_error`.
 * Урок сохраняется только после того, как модель прислала план целиком, поэтому
 * отказ провайдера не оставляет в базе ни урока, ни его шагов.
 */
import type { FastifyPluginAsync } from 'fastify';

import {
  createLessonRequestSchema,
  createLessonResponseSchema,
  getLessonResponseSchema,
  lessonParamsSchema,
  listLessonsQuerySchema,
  listLessonsResponseSchema,
  regenerateLessonPlanRequestSchema,
  regenerateLessonPlanResponseSchema,
  type CreateLessonResponse,
  type GetLessonResponse,
  type ListLessonsResponse,
  type RegenerateLessonPlanResponse,
} from '@lt/shared';

import { parseBody, parseParams, parseQuery } from '../lib/validate.js';
import { providerErrorToAppError } from '../providers/types.js';
import {
  createLesson,
  getLesson,
  listLessons,
  regenerateLessonPlan,
} from '../services/lessonPlanService.js';

/** Маршруты уроков. */
export const lessonsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/lessons',
    { schema: { response: { 200: listLessonsResponseSchema } } },
    (request): ListLessonsResponse => listLessons(parseQuery(request, listLessonsQuerySchema)),
  );

  app.post(
    '/lessons',
    { schema: { response: { 201: createLessonResponseSchema } } },
    async (request, reply): Promise<CreateLessonResponse> => {
      const body = parseBody(request, createLessonRequestSchema);

      try {
        const lesson = await createLesson(body, { logger: request.log });

        reply.status(201);

        return lesson;
      } catch (error) {
        throw providerErrorToAppError(error, 'llm');
      }
    },
  );

  app.get(
    '/lessons/:id',
    { schema: { response: { 200: getLessonResponseSchema } } },
    (request): GetLessonResponse => getLesson(parseParams(request, lessonParamsSchema).id),
  );

  app.post(
    '/lessons/:id/plan/regenerate',
    { schema: { response: { 200: regenerateLessonPlanResponseSchema } } },
    async (request): Promise<RegenerateLessonPlanResponse> => {
      const { id } = parseParams(request, lessonParamsSchema);
      const body = parseBody(request, regenerateLessonPlanRequestSchema);

      try {
        return await regenerateLessonPlan(id, body, { logger: request.log });
      } catch (error) {
        throw providerErrorToAppError(error, 'llm');
      }
    },
  );
};
