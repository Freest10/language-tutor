import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  API_PREFIX,
  apiErrorResponseSchema,
  getConfigResponseSchema,
  ttsRequestSchema,
} from '@lt/shared';

import { buildApp } from '../src/app.js';
import { APP_VERSION, EnvValidationError, parseEnv } from '../src/config/env.js';
import { IN_MEMORY_DB_PATH, openDatabase, setDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { parseBody } from '../src/lib/validate.js';

/** Маршруты-заглушки: каждый обязан отвечать 501 с конвертом ошибки. */
const STUB_ROUTES: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string }[] = [
  { method: 'POST', url: '/placement/sessions' },
  { method: 'POST', url: '/placement/sessions/placement-1/turns' },
  { method: 'POST', url: '/placement/sessions/placement-1/finish' },
  { method: 'GET', url: '/lessons' },
  { method: 'POST', url: '/lessons' },
  { method: 'GET', url: '/lessons/lesson-1' },
  { method: 'POST', url: '/lessons/lesson-1/plan/regenerate' },
  { method: 'POST', url: '/lessons/lesson-1/start' },
  { method: 'POST', url: '/lessons/lesson-1/turns' },
  { method: 'POST', url: '/lessons/lesson-1/steps/step-1/advance' },
  { method: 'POST', url: '/lessons/lesson-1/exercises/exercise-1/attempts' },
  { method: 'POST', url: '/lessons/lesson-1/complete' },
  { method: 'GET', url: '/lessons/lesson-1/messages' },
  { method: 'GET', url: '/progress/summary' },
  { method: 'GET', url: '/progress/vocabulary' },
  { method: 'GET', url: '/progress/errors' },
  { method: 'GET', url: '/progress/level-history' },
];

/** Текст, который не должен попасть в ответ 500. */
const SECRET_DETAIL = 'секрет: /Users/tester/data/app.db';

let app: FastifyInstance;

beforeAll(async () => {
  const db = openDatabase(IN_MEMORY_DB_PATH);

  migrate(db);
  setDb(db);

  app = await buildApp();

  // Настоящие маршруты пока заглушены, поэтому проверку схем, разбор тела
  // и обработку неожиданного исключения вешаем на служебные маршруты.
  app.post('/__test__/schema', { schema: { body: ttsRequestSchema } }, (request) => request.body);
  app.post('/__test__/parse-body', (request) => parseBody(request, ttsRequestSchema));
  app.get('/__test__/boom', () => {
    throw new Error(SECRET_DETAIL);
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /api/health', () => {
  it('отвечает ok и проверяет базу запросом', async () => {
    const response = await app.inject({ method: 'GET', url: `${API_PREFIX}/health` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', db: 'ok', version: APP_VERSION });
  });
});

describe('GET /api/config', () => {
  it('отдаёт конфигурацию по схеме из @lt/shared', async () => {
    const response = await app.inject({ method: 'GET', url: `${API_PREFIX}/config` });

    expect(response.statusCode).toBe(200);

    const config = getConfigResponseSchema.parse(response.json());

    expect(config.apiPrefix).toBe(API_PREFIX);
    expect(config.version).toBe(APP_VERSION);
    expect(config.supportedLanguages.length).toBeGreaterThan(0);
    expect(config.limits.maxPageSize).toBeGreaterThan(0);
  });
});

describe('маршруты-заглушки', () => {
  it.each(STUB_ROUTES)('$method /api$url отвечает 501', async ({ method, url }) => {
    const response = await app.inject({ method, url: `${API_PREFIX}${url}` });

    expect(response.statusCode).toBe(501);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('not_configured');
    expect(body.error.details).toMatchObject({ reason: 'not_implemented' });
  });
});

describe('обработчик ошибок', () => {
  it('отвечает 400 с кодом validation_error на невалидное тело (схема маршрута)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/__test__/schema',
      payload: { text: '', speed: 9 },
    });

    expect(response.statusCode).toBe(400);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('validation_error');
    expect(body.error.details).toMatchObject({ source: 'body' });
  });

  it('отвечает 400 с кодом validation_error на невалидное тело (parseBody)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/__test__/parse-body',
      payload: { text: 42 },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });

  it('применяет значения по умолчанию из схемы к телу запроса', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/__test__/schema',
      payload: { text: 'Guten Morgen' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ text: 'Guten Morgen', format: 'mp3', speed: 1 });
  });

  it('отвечает 400 конвертом ошибки на неразбираемый JSON', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/__test__/schema',
      headers: { 'content-type': 'application/json' },
      payload: '{ не json',
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('bad_request');
  });

  it('отвечает 404 конвертом ошибки на несуществующий путь', async () => {
    const response = await app.inject({ method: 'GET', url: `${API_PREFIX}/no-such-route` });

    expect(response.statusCode).toBe(404);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('не отдаёт наружу стек и сообщение неожиданной ошибки', async () => {
    const response = await app.inject({ method: 'GET', url: '/__test__/boom' });

    expect(response.statusCode).toBe(500);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('internal_error');
    expect(body.error.details).toBeUndefined();
    expect(response.body).not.toContain(SECRET_DETAIL);
    expect(response.body).not.toContain('stack');
    expect(response.body).not.toContain('at ');
  });
});

describe('разбор переменных окружения', () => {
  it('подставляет значения по умолчанию', () => {
    const parsed = parseEnv({});

    expect(parsed.port).toBe(8787);
    expect(parsed.llmModel).toBe('qwen3:8b');
    expect(parsed.llmBaseUrl).toBe('http://localhost:11434/v1');
    expect(parsed.sttProvider).toBe('browser');
    expect(parsed.ttsProvider).toBe('browser');
    expect(parsed.maxUploadBytes).toBe(25 * 1024 * 1024);
  });

  it('считает пустой DB_PATH незаданным', () => {
    expect(parseEnv({ DB_PATH: '' }).dbPath).toBeUndefined();
  });

  it('падает с перечислением проблемных переменных', () => {
    expect(() => parseEnv({ LLM_BASE_URL: '', STT_PROVIDER: 'nonsense' })).toThrow(
      EnvValidationError,
    );

    try {
      parseEnv({ LLM_BASE_URL: '', STT_PROVIDER: 'nonsense' });
      expect.unreachable('parseEnv обязан бросить EnvValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).variables).toEqual(['LLM_BASE_URL', 'STT_PROVIDER']);
      expect((error as EnvValidationError).message).toContain('LLM_BASE_URL');
      expect((error as EnvValidationError).message).toContain('STT_PROVIDER');
    }
  });
});
