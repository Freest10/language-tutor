/**
 * Определение исходного уровня: сессия, ответы на вопросы, итог.
 *
 * - `POST /api/placement/sessions` — создаёт сессию под изучаемый язык профиля
 *   и возвращает первый вопрос (201);
 * - `GET /api/placement/sessions/:id` — сессия целиком: нужна клиенту, чтобы
 *   вернуться к незавершённому тесту после перезагрузки страницы. Отдельной DTO
 *   у чтения в контракте нет, поэтому используется форма ответа на создание
 *   (`{ session, nextTurn }`): все ходы уже лежат в `session.turns`;
 * - `POST /api/placement/sessions/:id/turns` — ответ ученика текстом (голос
 *   распознаётся на клиенте) и следующий вопрос;
 * - `POST /api/placement/sessions/:id/finish` — итог: уровень в профиль,
 *   запись в историю уровня, резюме сильных и слабых сторон.
 *
 * Правила теста живут в `services/placementService.ts`, промпты — в
 * `prompts/placement.ts`. Здесь только разбор запроса и перевод отказов модели
 * в коды API: 501 `not_configured`, 503 `upstream_unavailable`, 502 `upstream_error`.
 * Сессия сохраняется до обращения к модели, а её идентификатор уходит в
 * `details.sessionId` ответа об ошибке — прерванный тест можно продолжить.
 */
import type { FastifyPluginAsync } from 'fastify';

import {
  createPlacementSessionRequestSchema,
  createPlacementSessionResponseSchema,
  finishPlacementSessionRequestSchema,
  finishPlacementSessionResponseSchema,
  placementSessionParamsSchema,
  submitPlacementTurnRequestSchema,
  submitPlacementTurnResponseSchema,
  type CreatePlacementSessionResponse,
  type FinishPlacementSessionResponse,
  type SubmitPlacementTurnResponse,
} from '@lt/shared';

import { parseBody, parseParams } from '../lib/validate.js';
import { providerErrorToAppError } from '../providers/types.js';
import {
  createPlacementSession,
  finishPlacementSession,
  getPlacementSession,
  submitPlacementTurn,
} from '../services/placementService.js';

/** Маршруты определения исходного уровня. */
export const placementRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/placement/sessions',
    { schema: { response: { 201: createPlacementSessionResponseSchema } } },
    async (request, reply): Promise<CreatePlacementSessionResponse> => {
      const body = parseBody(request, createPlacementSessionRequestSchema);

      try {
        const created = await createPlacementSession(body, { logger: request.log });

        reply.status(201);

        return created;
      } catch (error) {
        throw providerErrorToAppError(error, 'llm');
      }
    },
  );

  app.get(
    '/placement/sessions/:id',
    { schema: { response: { 200: createPlacementSessionResponseSchema } } },
    (request): CreatePlacementSessionResponse =>
      getPlacementSession(parseParams(request, placementSessionParamsSchema).id),
  );

  app.post(
    '/placement/sessions/:id/turns',
    { schema: { response: { 200: submitPlacementTurnResponseSchema } } },
    async (request): Promise<SubmitPlacementTurnResponse> => {
      const { id } = parseParams(request, placementSessionParamsSchema);
      const body = parseBody(request, submitPlacementTurnRequestSchema);

      try {
        return await submitPlacementTurn(id, body, { logger: request.log });
      } catch (error) {
        throw providerErrorToAppError(error, 'llm');
      }
    },
  );

  app.post(
    '/placement/sessions/:id/finish',
    { schema: { response: { 200: finishPlacementSessionResponseSchema } } },
    async (request): Promise<FinishPlacementSessionResponse> => {
      const { id } = parseParams(request, placementSessionParamsSchema);
      const body = parseBody(request, finishPlacementSessionRequestSchema);

      try {
        return await finishPlacementSession(id, body, { logger: request.log });
      } catch (error) {
        throw providerErrorToAppError(error, 'llm');
      }
    },
  );
};
