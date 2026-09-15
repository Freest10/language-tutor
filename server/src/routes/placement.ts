/**
 * Определение исходного уровня: сессия, ответы на вопросы, итог.
 *
 * - `POST /api/placement/sessions`;
 * - `POST /api/placement/sessions/:id/turns`;
 * - `POST /api/placement/sessions/:id/finish`.
 *
 * Заглушка: каждый маршрут отвечает 501 `not_configured`
 * (`details.reason = 'not_implemented'`). Обработчики пишет фичевый пакет —
 * прямо в этом файле, не трогая `app.ts` и `config/env.ts`.
 */
import type { FastifyPluginAsync } from 'fastify';

import { notImplementedRoute } from '../lib/httpErrors.js';

/** Маршруты определения исходного уровня. */
export const placementRoutes: FastifyPluginAsync = async (app) => {
  app.post('/placement/sessions', notImplementedRoute('POST /api/placement/sessions'));
  app.post(
    '/placement/sessions/:id/turns',
    notImplementedRoute('POST /api/placement/sessions/:id/turns'),
  );
  app.post(
    '/placement/sessions/:id/finish',
    notImplementedRoute('POST /api/placement/sessions/:id/finish'),
  );
};
