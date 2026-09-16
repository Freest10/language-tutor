import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createLlmProvider } from '../src/providers/llmProvider.js';
import { createSttProvider } from '../src/providers/sttProvider.js';
import { createTtsProvider } from '../src/providers/ttsProvider.js';
import {
  extractJsonText,
  parseStructuredJson,
  requestStructuredJson,
} from '../src/providers/structuredJson.js';
import { isProviderError, type ProviderLogger } from '../src/providers/types.js';

/** Ключ, который не должен попасть ни в ошибку, ни в лог. */
const SECRET_KEY = 'sk-test-super-secret-key';

const LLM_OPTIONS = {
  baseUrl: 'http://llm.test/v1',
  model: 'qwen3:8b',
  retry: { attempts: 1 },
};

/** Мок `fetch`: тип совпадает с тем, как его вызывают провайдеры. */
type FetchMock = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;

/** Ставит мок `fetch` вместо глобального. */
function stubFetch(mock: FetchMock): void {
  vi.stubGlobal('fetch', mock);
}

/** Запись лога провайдера. */
interface LogEntry {
  payload: object;
  message: string;
}

/** Логгер, запоминающий всё, что в него написали. */
function createLogger(): ProviderLogger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];

  return {
    entries,
    debug(payload: object, message: string): void {
      entries.push({ payload, message });
    },
    warn(payload: object, message: string): void {
      entries.push({ payload, message });
    },
  };
}

/** Ответ с телом JSON. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Ответ OpenAI-совместимого `/chat/completions`. */
function chatResponse(content: string): Response {
  return jsonResponse({
    model: 'qwen3:8b',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
}

/** Аргументы вызова мока `fetch` по номеру. */
function callAt(mock: FetchMock, index: number): { url: string; init: RequestInit } {
  const call = mock.mock.calls[index];

  if (call === undefined) {
    throw new Error(`fetch не вызывался ${index + 1}-й раз`);
  }

  return { url: call[0], init: call[1] };
}

/** Тело запроса как объект. */
function requestBody(mock: FetchMock, index: number): Record<string, unknown> {
  const { init } = callAt(mock, index);

  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

/** Заголовки запроса. */
function requestHeaders(mock: FetchMock, index: number): Record<string, string> {
  return (callAt(mock, index).init.headers ?? {}) as Record<string, string>;
}

/** Ошибка отмены запроса, как её бросает `fetch`. */
function abortError(): Error {
  const error = new Error('This operation was aborted');

  error.name = 'AbortError';

  return error;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('провайдер языковой модели', () => {
  it('отправляет диалог и разбирает ответ', async () => {
    const fetchMock: FetchMock = vi.fn(async () => chatResponse('Guten Morgen!'));

    stubFetch(fetchMock);

    const provider = createLlmProvider({ ...LLM_OPTIONS, temperature: 0.3 });
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Поздоровайся по-немецки' }],
      maxTokens: 64,
    });

    expect(result).toMatchObject({
      text: 'Guten Morgen!',
      model: 'qwen3:8b',
      finishReason: 'stop',
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
    });
    expect(callAt(fetchMock, 0).url).toBe('http://llm.test/v1/chat/completions');
    expect(callAt(fetchMock, 0).init.method).toBe('POST');
    expect(requestBody(fetchMock, 0)).toMatchObject({
      model: 'qwen3:8b',
      temperature: 0.3,
      max_tokens: 64,
      stream: false,
      messages: [{ role: 'user', content: 'Поздоровайся по-немецки' }],
    });
    expect(requestBody(fetchMock, 0).response_format).toBeUndefined();
  });

  it('не отправляет Authorization, если ключ не задан', async () => {
    const fetchMock: FetchMock = vi.fn(async () => chatResponse('ok'));

    stubFetch(fetchMock);

    await createLlmProvider(LLM_OPTIONS).chat({ messages: [{ role: 'user', content: 'привет' }] });

    expect(requestHeaders(fetchMock, 0).authorization).toBeUndefined();
    expect(requestHeaders(fetchMock, 0)['content-type']).toBe('application/json');
  });

  it('добавляет Authorization, если ключ задан', async () => {
    const fetchMock: FetchMock = vi.fn(async () => chatResponse('ok'));

    stubFetch(fetchMock);

    await createLlmProvider({ ...LLM_OPTIONS, apiKey: SECRET_KEY }).chat({
      messages: [{ role: 'user', content: 'привет' }],
    });

    expect(requestHeaders(fetchMock, 0).authorization).toBe(`Bearer ${SECRET_KEY}`);
  });

  it('убирает из ответа блок рассуждений', async () => {
    const fetchMock: FetchMock = vi.fn(async () =>
      chatResponse('<think>сначала подумаю</think>\nGuten Tag!'),
    );

    stubFetch(fetchMock);

    const result = await createLlmProvider(LLM_OPTIONS).chat({
      messages: [{ role: 'user', content: 'привет' }],
    });

    expect(result.text).toBe('Guten Tag!');
  });

  it('добавляет response_format в режиме JSON', async () => {
    const fetchMock: FetchMock = vi.fn(async () => chatResponse('{"ok":true}'));

    stubFetch(fetchMock);

    await createLlmProvider(LLM_OPTIONS).chat({
      messages: [{ role: 'user', content: 'дай json' }],
      jsonMode: true,
    });

    expect(requestBody(fetchMock, 0).response_format).toEqual({ type: 'json_object' });
  });

  it('повторяет запрос после 503 и возвращает успешный ответ', async () => {
    const fetchMock: FetchMock = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ error: 'service unavailable' }, 503))
      .mockResolvedValueOnce(chatResponse('Готово'));
    const logger = createLogger();

    stubFetch(fetchMock);

    const provider = createLlmProvider({
      ...LLM_OPTIONS,
      retry: { attempts: 3, initialDelayMs: 0 },
      logger,
    });
    const result = await provider.chat({ messages: [{ role: 'user', content: 'привет' }] });

    expect(result.text).toBe('Готово');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logger.entries.some((entry) => entry.message.includes('повтор'))).toBe(true);
  });

  it('повторяет запрос после обрыва соединения', async () => {
    const fetchMock: FetchMock = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(chatResponse('Готово'));

    stubFetch(fetchMock);

    const provider = createLlmProvider({
      ...LLM_OPTIONS,
      retry: { attempts: 2, initialDelayMs: 0 },
    });

    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'привет' }] }),
    ).resolves.toMatchObject({ text: 'Готово' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('не повторяет запрос после 400', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse({ error: 'bad request' }, 400));

    stubFetch(fetchMock);

    const provider = createLlmProvider({
      ...LLM_OPTIONS,
      retry: { attempts: 3, initialDelayMs: 0 },
    });
    const error = await provider
      .chat({ messages: [{ role: 'user', content: 'привет' }] })
      .catch((reason: unknown) => reason);

    expect(isProviderError(error) && error.kind).toBe('http');
    expect(isProviderError(error) && error.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('прерывает запрос по таймауту и не повторяет его', async () => {
    vi.useFakeTimers();

    const fetchMock: FetchMock = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(abortError());
          });
        }),
    );

    stubFetch(fetchMock);

    const provider = createLlmProvider({
      ...LLM_OPTIONS,
      timeoutMs: 5000,
      retry: { attempts: 3, initialDelayMs: 0 },
    });
    const pending = provider.chat({ messages: [{ role: 'user', content: 'привет' }] });
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'timeout',
    });

    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('сообщает о неразбираемом ответе провайдера', async () => {
    const fetchMock: FetchMock = vi.fn(
      async () =>
        new Response('не json', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );

    stubFetch(fetchMock);

    const error = await createLlmProvider(LLM_OPTIONS)
      .chat({ messages: [{ role: 'user', content: 'привет' }] })
      .catch((reason: unknown) => reason);

    expect(isProviderError(error) && error.kind).toBe('invalid_response');
  });

  it('сообщает об ответе без единого варианта', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse({ choices: [] }));

    stubFetch(fetchMock);

    const error = await createLlmProvider(LLM_OPTIONS)
      .chat({ messages: [{ role: 'user', content: 'привет' }] })
      .catch((reason: unknown) => reason);

    expect(isProviderError(error) && error.kind).toBe('invalid_response');
  });

  it('не раскрывает ключ API ни в ошибке, ни в логе', async () => {
    const fetchMock: FetchMock = vi.fn(
      async () => new Response(`invalid api key: ${SECRET_KEY}`, { status: 500 }),
    );
    const logger = createLogger();

    stubFetch(fetchMock);

    const provider = createLlmProvider({
      ...LLM_OPTIONS,
      apiKey: SECRET_KEY,
      retry: { attempts: 1 },
      logger,
    });
    const error = await provider
      .chat({ messages: [{ role: 'user', content: 'привет' }] })
      .catch((reason: unknown) => reason);

    expect(isProviderError(error) && error.status).toBe(500);
    expect(isProviderError(error) && error.message).not.toContain(SECRET_KEY);
    expect(isProviderError(error) && (error.detail ?? '')).not.toContain(SECRET_KEY);
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET_KEY);
  });
});

describe('структурированный JSON', () => {
  const schema = z.object({ level: z.string(), score: z.number().int() });

  it('достаёт JSON из ```-блока и пояснений вокруг него', () => {
    const raw = 'Вот ответ:\n```json\n{ "level": "A2", "score": 7 }\n```\nГотово.';

    expect(extractJsonText(raw)).toBe('{ "level": "A2", "score": 7 }');
    expect(parseStructuredJson(schema, raw)).toMatchObject({
      ok: true,
      data: { level: 'A2', score: 7 },
    });
  });

  it('достаёт JSON из ответа без обрамления', () => {
    expect(extractJsonText('Ответ: {"level":"B1","score":9} — всё')).toBe(
      '{"level":"B1","score":9}',
    );
  });

  it('сообщает, что JSON в ответе нет', () => {
    expect(extractJsonText('никакого json тут нет')).toBeNull();
    expect(parseStructuredJson(schema, 'никакого json тут нет')).toMatchObject({ ok: false });
  });

  it('разбирает ответ модели и передаёт схему в системной инструкции', async () => {
    const fetchMock: FetchMock = vi.fn(async () => chatResponse('{"level":"B1","score":9}'));

    stubFetch(fetchMock);

    const result = await requestStructuredJson({
      schema,
      schemaName: 'placement_result',
      provider: createLlmProvider(LLM_OPTIONS),
      messages: [{ role: 'user', content: 'оцени уровень' }],
    });

    expect(result.data).toEqual({ level: 'B1', score: 9 });
    expect(result.attempts).toBe(1);
    expect(result.format).toBe('json_schema');

    const messages = requestBody(fetchMock, 0).messages as { role: string; content: string }[];

    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('placement_result');
    expect(messages[0]?.content).toContain('"level"');
    expect(requestBody(fetchMock, 0).response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'placement_result',
        schema: {
          type: 'object',
          properties: { level: { type: 'string' }, score: { type: 'integer' } },
          required: ['level', 'score'],
          additionalProperties: false,
        },
      },
    });
  });

  it('просит модель исправить ответ, не прошедший схему', async () => {
    const fetchMock: FetchMock = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(chatResponse('{"level":"B1"}'))
      .mockResolvedValueOnce(chatResponse('{"level":"B1","score":9}'));
    const logger = createLogger();

    stubFetch(fetchMock);

    const result = await requestStructuredJson({
      schema,
      logger,
      provider: createLlmProvider(LLM_OPTIONS),
      messages: [{ role: 'user', content: 'оцени уровень' }],
    });

    expect(result.data).toEqual({ level: 'B1', score: 9 });
    expect(result.attempts).toBe(2);
    expect(result.usage).toEqual({ promptTokens: 22, completionTokens: 14, totalTokens: 36 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const messages = requestBody(fetchMock, 1).messages as { role: string; content: string }[];

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[2]?.content).toBe('{"level":"B1"}');
    expect(messages[3]?.content).toContain('score');
  });

  it('сдаётся после единственного ремонтного захода', async () => {
    const fetchMock: FetchMock = vi.fn(async () => chatResponse('{"level":"B1"}'));

    stubFetch(fetchMock);

    const error = await requestStructuredJson({
      schema,
      provider: createLlmProvider(LLM_OPTIONS),
      messages: [{ role: 'user', content: 'оцени уровень' }],
    }).catch((reason: unknown) => reason);

    expect(isProviderError(error) && error.kind).toBe('invalid_response');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('не просит исправлений, если ремонт запрещён', async () => {
    const fetchMock: FetchMock = vi.fn(async () => chatResponse('{"level":"B1"}'));

    stubFetch(fetchMock);

    await expect(
      requestStructuredJson({
        schema,
        repairAttempts: 0,
        provider: createLlmProvider(LLM_OPTIONS),
        messages: [{ role: 'user', content: 'оцени уровень' }],
      }),
    ).rejects.toMatchObject({ name: 'ProviderError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('отступает на json_object, если сервер не знает строгой схемы', async () => {
    const fetchMock: FetchMock = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ error: 'unknown response_format type' }, 400))
      .mockResolvedValueOnce(chatResponse('{"level":"A2","score":4}'));

    stubFetch(fetchMock);

    const result = await requestStructuredJson({
      schema,
      provider: createLlmProvider(LLM_OPTIONS),
      messages: [{ role: 'user', content: 'оцени уровень' }],
    });

    expect(result.data).toEqual({ level: 'A2', score: 4 });
    expect(result.format).toBe('json_object');
    expect(requestBody(fetchMock, 0).response_format).toMatchObject({ type: 'json_schema' });
    expect(requestBody(fetchMock, 1).response_format).toEqual({ type: 'json_object' });
  });

  it('доходит по лестнице до запроса без response_format', async () => {
    const fetchMock: FetchMock = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ error: 'unknown response_format type' }, 400))
      .mockResolvedValueOnce(jsonResponse({ error: 'unknown field response_format' }, 400))
      .mockResolvedValueOnce(chatResponse('{"level":"A2","score":4}'));
    const logger = createLogger();

    stubFetch(fetchMock);

    const result = await requestStructuredJson({
      schema,
      logger,
      provider: createLlmProvider(LLM_OPTIONS),
      messages: [{ role: 'user', content: 'оцени уровень' }],
    });

    expect(result.data).toEqual({ level: 'A2', score: 4 });
    expect(result.format).toBe('text');
    expect(requestBody(fetchMock, 2).response_format).toBeUndefined();
    expect(logger.entries).toHaveLength(2);
  });

  it('не принимает 404 за неподдержанный режим: это ненайденная модель', async () => {
    const fetchMock: FetchMock = vi.fn(async () =>
      jsonResponse({ error: { message: "model 'qwen3:8b' not found" } }, 404),
    );

    stubFetch(fetchMock);

    const error = await requestStructuredJson({
      schema,
      provider: createLlmProvider(LLM_OPTIONS),
      messages: [{ role: 'user', content: 'оцени уровень' }],
    }).catch((reason: unknown) => reason);

    expect(isProviderError(error) && error.kind).toBe('model_not_found');
    expect(isProviderError(error) && error.message).toContain('qwen3:8b');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('берёт провайдер из переменных окружения, если он не передан', async () => {
    const fetchMock: FetchMock = vi.fn(async () => chatResponse('{"level":"C1","score":12}'));

    stubFetch(fetchMock);

    const result = await requestStructuredJson({
      schema,
      messages: [{ role: 'user', content: 'оцени уровень' }],
    });

    expect(result.data).toEqual({ level: 'C1', score: 12 });
    expect(callAt(fetchMock, 0).url).toBe('http://localhost:11434/v1/chat/completions');
    expect(requestBody(fetchMock, 0).model).toBe('qwen3:8b');
  });

  it('пробрасывает отказ провайдера как есть', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse({ error: 'boom' }, 502));

    stubFetch(fetchMock);

    const error = await requestStructuredJson({
      schema,
      provider: createLlmProvider(LLM_OPTIONS),
      messages: [{ role: 'user', content: 'оцени уровень' }],
    }).catch((reason: unknown) => reason);

    expect(isProviderError(error) && error.kind).toBe('http');
    expect(isProviderError(error) && error.status).toBe(502);
  });
});

describe('провайдер распознавания речи', () => {
  const STT_OPTIONS = {
    baseUrl: 'http://stt.test/v1',
    model: 'Systran/faster-whisper-small',
    retry: { attempts: 1 },
  };

  it('собирает multipart-запрос с файлом и полями', async () => {
    const fetchMock: FetchMock = vi.fn(async () =>
      jsonResponse({ text: ' Guten Morgen ', language: 'de', duration: 2.5 }),
    );

    stubFetch(fetchMock);

    const result = await createSttProvider(STT_OPTIONS).transcribe({
      audio: new Uint8Array([1, 2, 3, 4]),
      filename: 'speech.webm',
      contentType: 'audio/webm',
      language: 'de',
      prompt: 'урок про кофе',
    });

    expect(result).toEqual({
      text: 'Guten Morgen',
      language: 'de',
      durationMs: 2500,
      model: 'Systran/faster-whisper-small',
    });

    const { url, init } = callAt(fetchMock, 0);

    expect(url).toBe('http://stt.test/v1/audio/transcriptions');
    expect(init.body).toBeInstanceOf(FormData);

    const form = init.body as FormData;
    const file = form.get('file');

    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('speech.webm');
    expect((file as File).type).toBe('audio/webm');
    expect(await (file as File).arrayBuffer()).toEqual(new Uint8Array([1, 2, 3, 4]).buffer);
    expect(form.get('model')).toBe('Systran/faster-whisper-small');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('language')).toBe('de');
    expect(form.get('prompt')).toBe('урок про кофе');
    // Content-Type с boundary проставляет сам fetch.
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('не передаёт необязательные поля, если их нет', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse({ text: 'hello' }));

    stubFetch(fetchMock);

    const result = await createSttProvider(STT_OPTIONS).transcribe({
      audio: new Uint8Array([1]),
      filename: 'speech.wav',
      contentType: 'audio/wav',
    });

    expect(result).toMatchObject({ text: 'hello', language: null, durationMs: null });

    const form = callAt(fetchMock, 0).init.body as FormData;

    expect(form.get('language')).toBeNull();
    expect(form.get('prompt')).toBeNull();
  });

  it('не выдаёт название языка за код BCP-47', async () => {
    const fetchMock: FetchMock = vi.fn(async () =>
      jsonResponse({ text: 'hi', language: 'english' }),
    );

    stubFetch(fetchMock);

    const result = await createSttProvider(STT_OPTIONS).transcribe({
      audio: new Uint8Array([1]),
      filename: 'speech.wav',
      contentType: 'audio/wav',
    });

    expect(result.language).toBeNull();
  });

  it('сообщает о ответе без расшифровки', async () => {
    const fetchMock: FetchMock = vi.fn(async () => jsonResponse({ segments: [] }));

    stubFetch(fetchMock);

    const error = await createSttProvider(STT_OPTIONS)
      .transcribe({ audio: new Uint8Array([1]), filename: 'a.wav', contentType: 'audio/wav' })
      .catch((reason: unknown) => reason);

    expect(isProviderError(error) && error.kind).toBe('invalid_response');
  });
});

describe('провайдер синтеза речи', () => {
  const TTS_OPTIONS = {
    baseUrl: 'http://tts.test/v1/',
    model: 'kokoro',
    voice: 'af_bella',
    retry: { attempts: 1 },
  };
  const AUDIO = new Uint8Array([0xff, 0xf3, 0x44, 0x00]);

  it('передаёт текст и возвращает двоичное аудио', async () => {
    const fetchMock: FetchMock = vi.fn(
      async () => new Response(AUDIO, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
    );

    stubFetch(fetchMock);

    const result = await createTtsProvider(TTS_OPTIONS).synthesize({
      text: 'Guten Morgen',
      format: 'mp3',
      speed: 1.2,
    });

    expect(result.contentType).toBe('audio/mpeg');
    expect(result.format).toBe('mp3');
    expect(result.voice).toBe('af_bella');
    expect(result.model).toBe('kokoro');
    expect([...result.audio]).toEqual([...AUDIO]);
    expect(Buffer.from(result.audio).toString('base64')).toBe(
      Buffer.from(AUDIO).toString('base64'),
    );
    expect(callAt(fetchMock, 0).url).toBe('http://tts.test/v1/audio/speech');
    expect(requestBody(fetchMock, 0)).toEqual({
      model: 'kokoro',
      input: 'Guten Morgen',
      response_format: 'mp3',
      voice: 'af_bella',
      speed: 1.2,
    });
  });

  it('называет формат ogg так, как его ждёт OpenAI-совместимый сервер', async () => {
    const fetchMock: FetchMock = vi.fn(async () => new Response(AUDIO, { status: 200 }));

    stubFetch(fetchMock);

    const result = await createTtsProvider(TTS_OPTIONS).synthesize({
      text: 'Guten Morgen',
      format: 'ogg',
      voice: 'af_sky',
    });

    expect(requestBody(fetchMock, 0).response_format).toBe('opus');
    expect(requestBody(fetchMock, 0).voice).toBe('af_sky');
    // Провайдер не прислал Content-Type — берём тип по запрошенному формату.
    expect(result.contentType).toBe('audio/ogg');
    expect(result.voice).toBe('af_sky');
  });

  it('сообщает о пустом ответе провайдера', async () => {
    const fetchMock: FetchMock = vi.fn(async () => new Response(new Uint8Array(), { status: 200 }));

    stubFetch(fetchMock);

    const error = await createTtsProvider(TTS_OPTIONS)
      .synthesize({ text: 'тест', format: 'mp3' })
      .catch((reason: unknown) => reason);

    expect(isProviderError(error) && error.kind).toBe('invalid_response');
  });
});
