/**
 * Сборка Fastify-приложения: логгер, плагины, проверка схем, все маршруты API.
 *
 * ПРАВИЛО ПАКЕТОВ: фичевый пакет наполняет обработчиками СВОЙ файл в `src/routes/`
 * и не меняет ни `app.ts`, ни `config/env.ts` — список маршрутов и набор переменных
 * окружения зафиксированы здесь целиком, чтобы параллельная работа не пересекалась
 * в общих файлах.
 *
 * Запуск сервера — в `index.ts`; здесь приложение только собирается,
 * поэтому `buildApp()` пригоден для тестов через `app.inject()`.
 */
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { API_PREFIX } from '@lt/shared';

import { env } from './config/env.js';
import { registerZodValidation } from './lib/validate.js';
import { registerErrorHandler } from './plugins/errorHandler.js';
import { configRoutes } from './routes/config.js';
import { healthRoutes } from './routes/health.js';
import { lessonSessionRoutes } from './routes/lessonSession.js';
import { lessonsRoutes } from './routes/lessons.js';
import { materialsRoutes } from './routes/materials.js';
import { placementRoutes } from './routes/placement.js';
import { profileRoutes } from './routes/profile.js';
import { progressRoutes } from './routes/progress.js';
import { voiceRoutes } from './routes/voice.js';

/** Все модули маршрутов; каждый регистрируется с префиксом `API_PREFIX`. */
const ROUTE_MODULES = [
  healthRoutes,
  configRoutes,
  profileRoutes,
  placementRoutes,
  materialsRoutes,
  lessonsRoutes,
  lessonSessionRoutes,
  progressRoutes,
  voiceRoutes,
] as const;

/** Параметры сборки приложения. */
export interface BuildAppOptions {
  /** Логгер Fastify; по умолчанию собирается из `NODE_ENV` и `LOG_LEVEL`. */
  logger?: FastifyServerOptions['logger'];
}

/** Настройки логгера: в тестах — молчим, в разработке — человекочитаемый вывод. */
export function loggerOptions(): FastifyServerOptions['logger'] {
  if (env.isTest) {
    return false;
  }

  if (env.isDevelopment) {
    return {
      level: env.logLevel,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    };
  }

  return { level: env.logLevel };
}

/** Собирает инстанс Fastify со всеми маршрутами, но не начинает слушать порт. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? loggerOptions(),
    // Тело JSON-запроса ограничено тем же пределом, что и загрузка файла.
    bodyLimit: env.maxUploadBytes,
  });

  registerZodValidation(app);
  registerErrorHandler(app);

  // Приложение локальное: без CORS_ORIGIN отражаем Origin запроса (в том числе dev-сервер Vite).
  await app.register(cors, { origin: env.corsOrigin ?? true });
  await app.register(multipart, { limits: { fileSize: env.maxUploadBytes } });

  for (const routes of ROUTE_MODULES) {
    await app.register(routes, { prefix: API_PREFIX });
  }

  return app;
}
