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

/** Текст, который не должен попасть в ответ 500. */
const SECRET_DETAIL = 'секрет: /Users/tester/data/app.db';

let app: FastifyInstance;

beforeAll(async () => {
  const db = openDatabase(IN_MEMORY_DB_PATH);

  migrate(db);
  setDb(db);

  app = await buildApp();

  // Проверку схем, разбор тела и обработку неожиданного исключения вешаем на
  // служебные маршруты: прикладные эндпоинты проверяются своими тестами.
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

describe('сетевые границы доступа', () => {
  // Аутентификации нет по замыслу (A6), поэтому привязка к интерфейсу и список
  // CORS-источников — единственные границы доступа. Дефолты обязаны быть узкими:
  // иначе профиль, материалы и расшифровки уроков читает любой сайт, открытый
  // пользователем, и любой сосед по сети.
  it('по умолчанию слушает петлю, а не все интерфейсы', () => {
    expect(parseEnv({}).host).toBe('127.0.0.1');
  });

  it('по умолчанию разрешает CORS только собственному вебу', () => {
    expect(parseEnv({}).corsOrigin).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  it('учитывает WEB_PORT в списке разрешённых источников', () => {
    expect(parseEnv({ WEB_PORT: '4321' }).corsOrigin).toEqual([
      'http://localhost:4321',
      'http://127.0.0.1:4321',
    ]);
  });

  it('пустой CORS_ORIGIN не означает «отражать любой Origin»', () => {
    const { corsOrigin } = parseEnv({ CORS_ORIGIN: '   ' });

    expect(corsOrigin).not.toHaveLength(0);
    expect(corsOrigin).toEqual(expect.arrayContaining(['http://localhost:5173']));
  });

  it('отвергает запрос с чужого источника и пропускает свой', async () => {
    const foreign = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/health`,
      headers: { origin: 'https://evil.example' },
    });
    const own = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/health`,
      headers: { origin: 'http://localhost:5173' },
    });

    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    expect(own.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
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

describe('страховка тестов', () => {
  it('не даёт тесту уйти в сеть без подмены fetch', async () => {
    // Заглушка ставится в `test/setup/noNetwork.ts` для всех файлов тестов:
    // забытая подмена `fetch` должна падать с внятным текстом, а не уходить
    // к настоящему провайдеру.
    await expect(fetch('http://provider.invalid/v1/chat/completions')).rejects.toThrow(
      /обратился в сеть/,
    );
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

  it('не показывает в сообщении об ошибке учётные данные и query адреса', () => {
    // Ключ доступа нередко живёт прямо в адресе, а имя переменной `*_BASE_URL`
    // под шаблон секретов не подходит: сообщение уходит в консоль и в лог.
    const url = 'https://user:sk-secret-token@proxy.example.com:порт/v1?api_key=sk-another-secret';

    try {
      parseEnv({ LLM_BASE_URL: url, STT_BASE_URL: url });
      expect.unreachable('parseEnv обязан бросить EnvValidationError');
    } catch (error) {
      const { message } = error as EnvValidationError;

      expect(message).toContain('LLM_BASE_URL');
      expect(message).not.toContain('sk-secret-token');
      expect(message).not.toContain('sk-another-secret');
      expect(message).not.toContain('api_key');
      // Хост и путь остаются: без них подсказка бесполезна.
      expect(message).toContain('proxy.example.com');
    }
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
