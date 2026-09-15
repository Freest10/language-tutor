/**
 * Прогресс: сводка, словарь, журнал ошибок, история уровня.
 *
 * - `GET /api/progress/summary`;
 * - `GET /api/progress/vocabulary`;
 * - `GET /api/progress/errors`;
 * - `GET /api/progress/level-history`.
 *
 * Заглушка: каждый маршрут отвечает 501 `not_configured`
 * (`details.reason = 'not_implemented'`). Обработчики пишет фичевый пакет —
 * прямо в этом файле, не трогая `app.ts` и `config/env.ts`.
 */
import type { FastifyPluginAsync } from 'fastify';

import { notImplementedRoute } from '../lib/httpErrors.js';

/** Маршруты прогресса. */
export const progressRoutes: FastifyPluginAsync = async (app) => {
  app.get('/progress/summary', notImplementedRoute('GET /api/progress/summary'));
  app.get('/progress/vocabulary', notImplementedRoute('GET /api/progress/vocabulary'));
  app.get('/progress/errors', notImplementedRoute('GET /api/progress/errors'));
  app.get('/progress/level-history', notImplementedRoute('GET /api/progress/level-history'));
};
