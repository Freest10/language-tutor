/**
 * Профиль ученика.
 *
 * - `GET /api/profile`;
 * - `PUT /api/profile`.
 *
 * Заглушка: каждый маршрут отвечает 501 `not_configured`
 * (`details.reason = 'not_implemented'`). Обработчики пишет фичевый пакет —
 * прямо в этом файле, не трогая `app.ts` и `config/env.ts`.
 */
import type { FastifyPluginAsync } from 'fastify';

import { notImplementedRoute } from '../lib/httpErrors.js';

/** Профиль ученика. */
export const profileRoutes: FastifyPluginAsync = async (app) => {
  app.get('/profile', notImplementedRoute('GET /api/profile'));
  app.put('/profile', notImplementedRoute('PUT /api/profile'));
};
