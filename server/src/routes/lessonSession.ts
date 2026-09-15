/**
 * Ход урока: старт, реплики диалога, переходы по шагам, попытки, завершение.
 *
 * - `POST /api/lessons/:id/start`;
 * - `POST /api/lessons/:id/turns`;
 * - `POST /api/lessons/:id/steps/:stepId/advance`;
 * - `POST /api/lessons/:id/exercises/:exerciseId/attempts`;
 * - `POST /api/lessons/:id/complete`;
 * - `GET /api/lessons/:id/messages`.
 *
 * Заглушка: каждый маршрут отвечает 501 `not_configured`
 * (`details.reason = 'not_implemented'`). Обработчики пишет фичевый пакет —
 * прямо в этом файле, не трогая `app.ts` и `config/env.ts`.
 */
import type { FastifyPluginAsync } from 'fastify';

import { notImplementedRoute } from '../lib/httpErrors.js';

/** Маршруты хода урока. */
export const lessonSessionRoutes: FastifyPluginAsync = async (app) => {
  app.post('/lessons/:id/start', notImplementedRoute('POST /api/lessons/:id/start'));
  app.post('/lessons/:id/turns', notImplementedRoute('POST /api/lessons/:id/turns'));
  app.post(
    '/lessons/:id/steps/:stepId/advance',
    notImplementedRoute('POST /api/lessons/:id/steps/:stepId/advance'),
  );
  app.post(
    '/lessons/:id/exercises/:exerciseId/attempts',
    notImplementedRoute('POST /api/lessons/:id/exercises/:exerciseId/attempts'),
  );
  app.post('/lessons/:id/complete', notImplementedRoute('POST /api/lessons/:id/complete'));
  app.get('/lessons/:id/messages', notImplementedRoute('GET /api/lessons/:id/messages'));
};
