/**
 * Точка входа сервера: поднимает приложение из `app.ts` и слушает порт.
 *
 * Здесь нет ни конфигурации, ни маршрутов: окружение разбирает `config/env.ts`,
 * приложение собирает `app.ts`. Модули подключаются динамически, чтобы ошибку
 * конфигурации показать одним понятным сообщением, а не стеком импорта.
 */
import { pathToFileURL } from 'node:url';

import type { FastifyInstance } from 'fastify';

/** Имя ошибки из `config/env.ts` (импорт модуля здесь невозможен: он и падает). */
const ENV_VALIDATION_ERROR_NAME = 'EnvValidationError';

/** Загружает приложение и конфигурацию, переводя ошибку окружения в выход с кодом 1. */
async function load(): Promise<{
  buildApp: () => Promise<FastifyInstance>;
  host: string;
  port: number;
  closeDb: () => void;
}> {
  try {
    const { buildApp } = await import('./app.js');
    const { env } = await import('./config/env.js');
    const { closeDb } = await import('./db/connection.js');

    return { buildApp, host: env.host, port: env.port, closeDb };
  } catch (error) {
    if (error instanceof Error && error.name === ENV_VALIDATION_ERROR_NAME) {
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  }
}

async function start(): Promise<void> {
  const { buildApp, host, port, closeDb } = await load();
  const app = await buildApp();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().then(() => {
        closeDb();
        process.exit(0);
      });
    });
  }

  try {
    await app.listen({ host, port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

const entrypoint = process.argv[1];

if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await start();
}
