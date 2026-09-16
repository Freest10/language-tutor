/**
 * Раздача собранного интерфейса самим сервером (`WEB_DIST_DIR`).
 *
 * Режим нужен десктопной сборке: окно приложения открывает этот же сервер,
 * поэтому фронт обязан приходить с того же источника, что и API. Проверяется
 * граница между «страницей» и «ошибкой API»: одностраничное приложение должно
 * получать `index.html` на свои внутренние адреса, а клиент API — обычный
 * конверт `{ error }`, а не HTML, на котором разбор JSON падает.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_PREFIX, apiErrorResponseSchema } from '@lt/shared';

import { buildApp } from '../src/app.js';
import { IN_MEMORY_DB_PATH, openDatabase, setDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';

/** Содержимое подменного `index.html`: по нему узнаём страницу в ответе. */
const INDEX_HTML = '<!doctype html><title>language-tutor</title><div id="root"></div>';

/** Содержимое подменного файла сборки. */
const ASSET_JS = 'console.log("bundle");';

let app: FastifyInstance;
let webDistDir: string;

beforeAll(async () => {
  const db = openDatabase(IN_MEMORY_DB_PATH);

  migrate(db);
  setDb(db);

  webDistDir = mkdtempSync(join(tmpdir(), 'lt-web-dist-'));
  writeFileSync(join(webDistDir, 'index.html'), INDEX_HTML, 'utf8');
  mkdirSync(join(webDistDir, 'assets'));
  writeFileSync(join(webDistDir, 'assets', 'app.js'), ASSET_JS, 'utf8');

  app = await buildApp({ webDistDir });

  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(webDistDir, { recursive: true, force: true });
});

describe('WEB_DIST_DIR', () => {
  it('отдаёт index.html на корень', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('id="root"');
  });

  it('отдаёт файлы сборки как есть', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/app.js' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(ASSET_JS);
  });

  it('отдаёт index.html на адрес маршрутизатора браузера', async () => {
    // Файла `/lessons/42` не существует: такой адрес знает только маршрутизатор
    // в браузере, и открытие ссылки напрямую обязано вернуть страницу.
    const response = await app.inject({ method: 'GET', url: '/lessons/42' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('id="root"');
  });

  it('на несуществующий маршрут API отвечает ошибкой в конверте, а не страницей', async () => {
    const response = await app.inject({ method: 'GET', url: `${API_PREFIX}/nope` });

    expect(response.statusCode).toBe(404);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('not_found');
  });

  it('на неизвестный метод отвечает ошибкой в конверте', async () => {
    // Страницу отдаём только чтению: POST на несуществующий адрес — это клиент
    // API, которому нужен разбираемый ответ.
    const response = await app.inject({ method: 'POST', url: '/lessons/42' });

    expect(response.statusCode).toBe(404);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('продолжает отвечать по API', async () => {
    const response = await app.inject({ method: 'GET', url: `${API_PREFIX}/health` });

    expect(response.statusCode).toBe(200);
  });
});

describe('каталог без index.html', () => {
  it('роняет сборку приложения с понятным сообщением', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'lt-web-empty-'));

    await expect(buildApp({ webDistDir: emptyDir })).rejects.toThrow(/index\.html/);

    rmSync(emptyDir, { recursive: true, force: true });
  });
});
