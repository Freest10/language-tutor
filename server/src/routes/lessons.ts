/**
 * Уроки: список, создание с планом, просмотр, пересборка плана.
 *
 * - `GET /api/lessons`;
 * - `POST /api/lessons`;
 * - `GET /api/lessons/:id`;
 * - `POST /api/lessons/:id/plan/regenerate`.
 *
 * Заглушка: каждый маршрут отвечает 501 `not_configured`
 * (`details.reason = 'not_implemented'`). Обработчики пишет фичевый пакет —
 * прямо в этом файле, не трогая `app.ts` и `config/env.ts`.
 */
import type { FastifyPluginAsync } from 'fastify';

import { notImplementedRoute } from '../lib/httpErrors.js';

/** Маршруты уроков. */
export const lessonsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/lessons', notImplementedRoute('GET /api/lessons'));
  app.post('/lessons', notImplementedRoute('POST /api/lessons'));
  app.get('/lessons/:id', notImplementedRoute('GET /api/lessons/:id'));
  app.post(
    '/lessons/:id/plan/regenerate',
    notImplementedRoute('POST /api/lessons/:id/plan/regenerate'),
  );
};
