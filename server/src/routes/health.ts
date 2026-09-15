/**
 * `GET /api/health` — проверка живости процесса и доступности базы.
 *
 * База проверяется настоящим запросом: health должен ловить ситуацию,
 * когда файл базы недоступен, а не подтверждать, что процесс жив.
 */
import type { FastifyPluginAsync } from 'fastify';

import type { HealthResponse } from '@lt/shared';

import { APP_VERSION } from '../config/env.js';
import { getDb } from '../db/connection.js';
import { upstreamUnavailable } from '../lib/httpErrors.js';

/** Ответ health-check: состояние базы и версия сервера. */
export interface HealthPayload extends HealthResponse {
  db: 'ok';
  version: string;
}

/** Выполняет тривиальный запрос к базе; при отказе — 503. */
function checkDb(): 'ok' {
  try {
    const row = getDb().prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;

    if (row?.ok !== 1) {
      throw new Error('Запрос SELECT 1 вернул неожиданный результат');
    }
  } catch (error) {
    throw upstreamUnavailable('База данных недоступна', { cause: error });
  }

  return 'ok';
}

/** Маршруты health-check. */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', (): HealthPayload => ({ status: 'ok', db: checkDb(), version: APP_VERSION }));
};
