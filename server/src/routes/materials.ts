/**
 * Учебные материалы: загрузка файла или текста, список, просмотр, удаление.
 *
 * - `GET /api/materials`;
 * - `POST /api/materials`;
 * - `GET /api/materials/:id`;
 * - `DELETE /api/materials/:id`.
 *
 * Заглушка: каждый маршрут отвечает 501 `not_configured`
 * (`details.reason = 'not_implemented'`). Обработчики пишет фичевый пакет —
 * прямо в этом файле, не трогая `app.ts` и `config/env.ts`.
 */
import type { FastifyPluginAsync } from 'fastify';

import { notImplementedRoute } from '../lib/httpErrors.js';

/** Маршруты учебных материалов. */
export const materialsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/materials', notImplementedRoute('GET /api/materials'));
  app.post('/materials', notImplementedRoute('POST /api/materials'));
  app.get('/materials/:id', notImplementedRoute('GET /api/materials/:id'));
  app.delete('/materials/:id', notImplementedRoute('DELETE /api/materials/:id'));
};
