import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_PREFIX,
  apiErrorResponseSchema,
  getConfigResponseSchema,
  MAX_TTS_TEXT_LENGTH,
  STT_AUDIO_FIELD_NAME,
  sttResponseSchema,
  ttsResponseSchema,
} from '@lt/shared';

import type { Env } from '../src/config/env.js';

/** Подмена переменных окружения: маршруты читают `env` на каждом запросе. */
const envState = vi.hoisted(() => ({ overrides: {} as Partial<Env> }));

vi.mock('../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env.js')>();

  return {
    ...actual,
    get env(): Env {
      return { ...actual.env, ...envState.overrides };
    },
  };
});

const { buildApp } = await import('../src/app.js');
const { IN_MEMORY_DB_PATH, openDatabase, setDb } = await import('../src/db/connection.js');
const { migrate } = await import('../src/db/migrate.js');

/** Ключи, которые не должны попасть ни в ответ, ни в лог. */
const SECRET_KEYS = { llm: 'sk-llm-secret-value', stt: 'sk-stt-secret-value' };

/** Настроенный серверный STT. */
const STT_ENV: Partial<Env> = {
  sttProvider: 'openai',
  sttBaseUrl: 'http://stt.test/v1',
  sttModel: 'Systran/faster-whisper-small',
  sttApiKey: SECRET_KEYS.stt,
};

/** Настроенный серверный TTS. */
const TTS_ENV: Partial<Env> = {
  ttsProvider: 'openai',
  ttsBaseUrl: 'http://tts.test/v1',
  ttsModel: 'kokoro',
  ttsVoice: 'af_bella',
};

/** Двоичное «аудио», которым отвечает мок синтеза. */
const SYNTHESIZED_AUDIO = new Uint8Array([0xff, 0xf3, 0x44, 0x00, 0x11]);

type FetchMock = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;

/** Ответ с телом JSON. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Собирает multipart-тело так, как его отправил бы браузер. */
async function multipart(parts: {
  fields?: Record<string, string>;
  file?: { field: string; bytes: Uint8Array; filename: string; type: string };
}): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const form = new FormData();

  for (const [name, value] of Object.entries(parts.fields ?? {})) {
    form.append(name, value);
  }

  if (parts.file !== undefined) {
    form.append(
      parts.file.field,
      new File([parts.file.bytes], parts.file.filename, { type: parts.file.type }),
    );
  }

  const request = new Request('http://localhost/', { method: 'POST', body: form });

  return {
    payload: Buffer.from(await request.arrayBuffer()),
    headers: { 'content-type': request.headers.get('content-type') ?? '' },
  };
}

/** Запрос распознавания с записью по умолчанию. */
async function postStt(
  fields: Record<string, string> = {},
): Promise<ReturnType<FastifyInstance['inject']>> {
  const { payload, headers } = await multipart({
    fields,
    file: {
      field: STT_AUDIO_FIELD_NAME,
      bytes: new Uint8Array([1, 2, 3, 4, 5]),
      filename: 'speech.webm',
      type: 'audio/webm;codecs=opus',
    },
  });

  return app.inject({ method: 'POST', url: `${API_PREFIX}/voice/stt`, payload, headers });
}

/** Строки, записанные логгером приложения. */
const logLines: string[] = [];

let app: FastifyInstance;

beforeAll(async () => {
  const db = openDatabase(IN_MEMORY_DB_PATH);

  migrate(db);
  setDb(db);

  app = await buildApp({
    logger: {
      level: 'trace',
      stream: {
        write(line: string): void {
          logLines.push(line);
        },
      },
    },
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  envState.overrides = {};
  logLines.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/voice/stt', () => {
  it('отвечает 501 stt_browser_only, когда распознаёт браузер', async () => {
    const response = await postStt();

    expect(response.statusCode).toBe(501);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('not_configured');
    expect(body.error.details).toMatchObject({ reason: 'stt_browser_only' });
  });

  it('отвечает 501 stt_not_configured, когда не заданы адрес и модель', async () => {
    envState.overrides = { sttProvider: 'openai' };

    const response = await postStt();

    expect(response.statusCode).toBe(501);
    expect(apiErrorResponseSchema.parse(response.json()).error.details).toMatchObject({
      reason: 'stt_not_configured',
    });
  });

  it('расшифровывает запись настроенным провайдером', async () => {
    envState.overrides = STT_ENV;

    const fetchMock: FetchMock = vi.fn(async () =>
      jsonResponse({ text: ' Guten Morgen ', language: 'de', duration: 1.5 }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const response = await postStt({ language: 'de', prompt: 'урок про кофе' });

    expect(response.statusCode).toBe(200);
    expect(sttResponseSchema.parse(response.json())).toEqual({
      text: 'Guten Morgen',
      language: 'de',
      durationMs: 1500,
      provider: 'openai',
      model: 'Systran/faster-whisper-small',
    });

    const call = fetchMock.mock.calls[0];

    expect(call?.[0]).toBe('http://stt.test/v1/audio/transcriptions');

    const form = call?.[1].body as FormData;
    const file = form.get('file') as File;

    expect(file.name).toBe('speech.webm');
    expect(file.type).toBe('audio/webm');
    expect(file.size).toBe(5);
    expect(form.get('model')).toBe('Systran/faster-whisper-small');
    expect(form.get('language')).toBe('de');
    expect(form.get('prompt')).toBe('урок про кофе');
  });

  it('отвечает 415 на запрос не в формате multipart', async () => {
    envState.overrides = STT_ENV;

    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/voice/stt`,
      payload: { language: 'de' },
    });

    expect(response.statusCode).toBe(415);
    expect(apiErrorResponseSchema.parse(response.json()).error.details).toMatchObject({
      reason: 'multipart_required',
    });
  });

  it('отвечает 415 на неподдерживаемый формат аудио', async () => {
    envState.overrides = STT_ENV;

    const { payload, headers } = await multipart({
      file: {
        field: STT_AUDIO_FIELD_NAME,
        bytes: new Uint8Array([1, 2, 3]),
        filename: 'speech.aiff',
        type: 'audio/aiff',
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/voice/stt`,
      payload,
      headers,
    });

    expect(response.statusCode).toBe(415);
    expect(apiErrorResponseSchema.parse(response.json()).error.details).toMatchObject({
      reason: 'audio_mime_not_supported',
    });
  });

  it('отвечает 400, если аудиозаписи нет', async () => {
    envState.overrides = STT_ENV;

    const { payload, headers } = await multipart({ fields: { language: 'de' } });
    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/voice/stt`,
      payload,
      headers,
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.details).toMatchObject({
      reason: 'audio_missing',
    });
  });

  it('отвечает 400 на некорректное текстовое поле', async () => {
    envState.overrides = STT_ENV;

    const response = await postStt({ language: 'немецкий' });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });

  it('отвечает 502, когда провайдер вернул ошибку', async () => {
    envState.overrides = STT_ENV;

    const fetchMock: FetchMock = vi.fn(async () => jsonResponse({ error: 'bad model' }, 400));

    vi.stubGlobal('fetch', fetchMock);

    const response = await postStt();

    expect(response.statusCode).toBe(502);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('upstream_error');
    expect(body.error.details).toMatchObject({ reason: 'stt_upstream_error', status: 400 });
  });
});

describe('POST /api/voice/tts', () => {
  it('отвечает 501 tts_browser_only, когда синтезирует браузер', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/voice/tts`,
      payload: { text: 'Guten Morgen' },
    });

    expect(response.statusCode).toBe(501);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('not_configured');
    expect(body.error.details).toMatchObject({ reason: 'tts_browser_only' });
  });

  it('синтезирует речь и отдаёт аудио в base64', async () => {
    envState.overrides = TTS_ENV;

    const fetchMock: FetchMock = vi.fn(
      async () =>
        new Response(SYNTHESIZED_AUDIO, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/voice/tts`,
      payload: { text: 'Guten Morgen', speed: 1.1 },
    });

    expect(response.statusCode).toBe(200);

    const body = ttsResponseSchema.parse(response.json());

    expect(body).toMatchObject({
      contentType: 'audio/mpeg',
      format: 'mp3',
      provider: 'openai',
      voice: 'af_bella',
      model: 'kokoro',
    });
    expect([...Buffer.from(body.audioBase64, 'base64')]).toEqual([...SYNTHESIZED_AUDIO]);

    const call = fetchMock.mock.calls[0];

    expect(call?.[0]).toBe('http://tts.test/v1/audio/speech');
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      model: 'kokoro',
      input: 'Guten Morgen',
      response_format: 'mp3',
      voice: 'af_bella',
      speed: 1.1,
    });
  });

  it('отвечает 400 на пустой текст', async () => {
    envState.overrides = TTS_ENV;

    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/voice/tts`,
      payload: { text: '   ' },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });

  it('отвечает 400 на слишком длинный текст', async () => {
    envState.overrides = TTS_ENV;

    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/voice/tts`,
      payload: { text: 'а'.repeat(MAX_TTS_TEXT_LENGTH + 1) },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });

  it('отвечает 503, когда до провайдера нет связи', async () => {
    envState.overrides = TTS_ENV;

    const fetchMock: FetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    vi.stubGlobal('fetch', fetchMock);

    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/voice/tts`,
      payload: { text: 'Guten Morgen' },
    });

    expect(response.statusCode).toBe(503);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('upstream_unavailable');
    expect(body.error.details).toMatchObject({ reason: 'tts_unavailable' });
    // Обрыв соединения повторяется: три попытки по политике по умолчанию.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('GET /api/config', () => {
  it('сообщает, что голос выполняет браузер', async () => {
    const response = await app.inject({ method: 'GET', url: `${API_PREFIX}/config` });

    expect(response.statusCode).toBe(200);

    const config = getConfigResponseSchema.parse(response.json());

    expect(config.stt).toMatchObject({ provider: 'browser', available: true, model: null });
    expect(config.tts).toMatchObject({ provider: 'browser', available: true, formats: [] });
    expect(config.llm).toMatchObject({ available: true, model: 'qwen3:8b' });
    expect(config.limits.maxTtsTextLength).toBe(MAX_TTS_TEXT_LENGTH);
    expect(config.supportedLanguages.length).toBeGreaterThan(0);
  });

  it('сообщает о настроенных серверных провайдерах', async () => {
    envState.overrides = { ...STT_ENV, ...TTS_ENV };

    const response = await app.inject({ method: 'GET', url: `${API_PREFIX}/config` });
    const config = getConfigResponseSchema.parse(response.json());

    expect(config.stt).toMatchObject({
      provider: 'openai',
      available: true,
      model: 'Systran/faster-whisper-small',
      reason: null,
    });
    expect(config.tts).toMatchObject({
      provider: 'openai',
      available: true,
      model: 'kokoro',
      voice: 'af_bella',
      formats: ['mp3'],
    });
  });

  it('признаёт провайдер ненастроенным без адреса и модели', async () => {
    envState.overrides = { sttProvider: 'openai', ttsProvider: 'openai' };

    const config = getConfigResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `${API_PREFIX}/config` })).json(),
    );

    expect(config.stt.available).toBe(false);
    expect(config.tts.available).toBe(false);
    expect(config.tts.formats).toEqual([]);
  });
});

describe('секреты', () => {
  it('не отдаёт ключи API в конфигурации', async () => {
    envState.overrides = { ...STT_ENV, llmApiKey: SECRET_KEYS.llm };

    const response = await app.inject({ method: 'GET', url: `${API_PREFIX}/config` });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(SECRET_KEYS.llm);
    expect(response.body).not.toContain(SECRET_KEYS.stt);
  });

  it('не показывает ключ ни в ответе об ошибке, ни в логе', async () => {
    envState.overrides = { ...STT_ENV, llmApiKey: SECRET_KEYS.llm };

    const fetchMock: FetchMock = vi.fn(
      async () => new Response(`invalid api key ${SECRET_KEYS.stt}`, { status: 401 }),
    );

    vi.stubGlobal('fetch', fetchMock);

    const response = await postStt();

    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain(SECRET_KEYS.stt);
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join('')).not.toContain(SECRET_KEYS.stt);
    expect(logLines.join('')).not.toContain(SECRET_KEYS.llm);
  });
});
