import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import cors from '@fastify/cors';
import { config } from 'dotenv';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { API_PREFIX, type HealthResponse } from '@lt/shared';

const moduleDir = dirname(fileURLToPath(import.meta.url));

// `.env` лежит в корне монорепо: путь считаем от текущего файла,
// чтобы не зависеть от cwd (dev — из server/, prod — из dist/src/).
config({
  path: [resolve(moduleDir, '../../.env'), resolve(moduleDir, '../../../.env')],
  quiet: true,
});

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 8787),
  logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;

function loggerOptions(): FastifyServerOptions['logger'] {
  if (env.nodeEnv === 'test') {
    return false;
  }
  if (env.nodeEnv === 'development') {
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

/** Собирает инстанс Fastify без запуска прослушивания порта (удобно для тестов). */
export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: loggerOptions() });

  await app.register(cors, { origin: true });

  app.get(`${API_PREFIX}/health`, async (): Promise<HealthResponse> => ({ status: 'ok' }));

  return app;
}

async function start(): Promise<void> {
  const app = await buildServer();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }

  try {
    await app.listen({ host: env.host, port: env.port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await start();
}
