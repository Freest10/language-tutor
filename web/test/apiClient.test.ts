/**
 * HTTP-клиент приложения: сборка запроса, разбор ответа и все виды отказов.
 *
 * Сеть подменена: `fetch` заменён заглушкой, которая записывает уходящие запросы
 * и отдаёт заранее подготовленный `Response`. Проверяется наблюдаемое поведение —
 * что уходит на сервер и что получает вызывающий код, — а не внутреннее устройство клиента.
 *
 * Таймауты проверяются фейковыми таймерами: ждать 15 или 60 секунд в тесте незачем.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_PREFIX, type ApiErrorResponse } from '@lt/shared';

import { api, ApiError, isApiError, type ResponseParser } from '../src/api/client';
import { DEFAULT_TIMEOUT_MS, UPLOAD_TIMEOUT_MS } from '../src/api/config';

/** Реализация `fetch`, которую подставляет конкретный тест. */
type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;

/** Запрос, ушедший в сеть. */
interface RecordedRequest {
  url: string;
  init: RequestInit;
}

const requests: RecordedRequest[] = [];

let handler: FetchHandler = () => Promise.reject(new Error('Заглушка fetch не настроена'));

beforeEach(() => {
  requests.length = 0;
  handler = () => Promise.reject(new Error('Заглушка fetch не настроена'));
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    requests.push({ url: String(url), init });

    return handler(String(url), init);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Последний ушедший запрос. */
function lastRequest(): RecordedRequest {
  const request = requests.at(-1);

  if (request === undefined) {
    throw new Error('Ни одного запроса не ушло');
  }

  return request;
}

/** Заголовки последнего запроса. */
function lastHeaders(): Record<string, string> {
  return (lastRequest().init.headers ?? {}) as Record<string, string>;
}

/** Отвечает один и тот же ответ на любой запрос. */
function respondWith(build: () => Response): void {
  handler = () => Promise.resolve(build());
}

/** Ответ с телом-JSON. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Ответ-конверт ошибки сервера. */
function errorResponse(error: ApiErrorResponse['error'], status: number): Response {
  return jsonResponse({ error }, status);
}

/** Запрос, который не завершается сам и падает только при отмене. */
function pendingUntilAbort(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });
}

/** Причина отказа промиса; успех считается ошибкой теста. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => {
      throw new Error(`Ожидался отказ, получен успех: ${JSON.stringify(value)}`);
    },
    (error: unknown) => error,
  );
}

/** Отказ промиса, приведённый к `ApiError`. */
async function apiFailure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await rejection(promise);

  if (!isApiError(error)) {
    throw new Error(`Ожидалась ApiError, получено: ${String(error)}`);
  }

  return error;
}

describe('сборка запроса', () => {
  beforeEach(() => {
    respondWith(() => jsonResponse({ ok: true }));
  });

  it('добавляет префикс API и метод', async () => {
    await api.get('/health');

    expect(lastRequest().url).toBe(`${API_PREFIX}/health`);
    expect(lastRequest().init.method).toBe('GET');
    expect(lastHeaders().Accept).toBe('application/json');
  });

  it('дописывает недостающий ведущий слэш пути', async () => {
    await api.get('health');

    expect(lastRequest().url).toBe(`${API_PREFIX}/health`);
  });

  it('не отправляет query-параметры со значениями null и undefined', async () => {
    await api.get('/lessons', { query: { status: 'active', level: null, topic: undefined } });

    expect(lastRequest().url).toBe(`${API_PREFIX}/lessons?status=active`);
  });

  it('разворачивает массив в повторяющийся ключ и пропускает в нём пустые значения', async () => {
    await api.get('/materials', { query: { id: ['a', null, 'b', undefined] } });

    expect(lastRequest().url).toBe(`${API_PREFIX}/materials?id=a&id=b`);
  });

  it('приводит числа и логические значения query к строкам', async () => {
    await api.get('/vocabulary', { query: { limit: 20, offset: 0, onlyNew: false } });

    expect(lastRequest().url).toBe(`${API_PREFIX}/vocabulary?limit=20&offset=0&onlyNew=false`);
  });

  it('не добавляет знак вопроса, когда отправлять нечего', async () => {
    await api.get('/lessons', { query: { status: undefined } });

    expect(lastRequest().url).toBe(`${API_PREFIX}/lessons`);
  });

  it('строит адрес эндпоинта без запроса', () => {
    expect(api.url('/materials/42/file')).toBe(`${API_PREFIX}/materials/42/file`);
    expect(api.url('/voice/tts', { text: 'привет', voice: null })).toBe(
      `${API_PREFIX}/voice/tts?text=${encodeURIComponent('привет')}`,
    );
  });

  it('сериализует тело POST в JSON и проставляет Content-Type', async () => {
    await api.post('/lessons', { title: 'Кафе' });

    expect(lastRequest().init.method).toBe('POST');
    expect(lastRequest().init.body).toBe(JSON.stringify({ title: 'Кафе' }));
    expect(lastHeaders()['Content-Type']).toBe('application/json');
  });

  it('отправляет пустой объект, когда тела нет', async () => {
    await api.post('/placement/sessions');

    expect(lastRequest().init.body).toBe('{}');
  });

  it('поддерживает PUT, PATCH и DELETE', async () => {
    await api.put('/profile', { level: 'A2' });
    expect(lastRequest().init.method).toBe('PUT');
    expect(lastRequest().init.body).toBe(JSON.stringify({ level: 'A2' }));

    await api.patch('/lessons/1', { status: 'completed' });
    expect(lastRequest().init.method).toBe('PATCH');

    await api.delete('/materials/1');
    expect(lastRequest().init.method).toBe('DELETE');
    expect(lastRequest().init.body).toBeUndefined();
  });

  it('добавляет заголовки вызывающего кода и не затирает его Content-Type', async () => {
    await api.post('/voice/stt', 'raw-text', {
      headers: { 'Content-Type': 'text/plain', 'X-Request-Id': 'req-1' },
    });

    expect(lastHeaders()['Content-Type']).toBe('text/plain');
    expect(lastHeaders()['X-Request-Id']).toBe('req-1');
    expect(lastHeaders().Accept).toBe('application/json');
  });
});

describe('разбор успешного ответа', () => {
  it('отдаёт тело как JSON', async () => {
    respondWith(() => jsonResponse({ items: [1, 2, 3] }));

    await expect(api.get('/progress/summary')).resolves.toEqual({ items: [1, 2, 3] });
  });

  it('пропускает тело через схему', async () => {
    respondWith(() => jsonResponse({ title: 'кафе' }));

    const schema: ResponseParser<string> = {
      parse: (input) => (input as { title: string }).title.toUpperCase(),
    };

    await expect(api.get('/lessons/1', { schema })).resolves.toBe('КАФЕ');
  });

  it('отдаёт undefined на ответ 204 без тела', async () => {
    respondWith(() => new Response(null, { status: 204 }));

    await expect(api.delete('/lessons/1')).resolves.toBeUndefined();
  });

  it('на пустое тело зовёт схему с undefined', async () => {
    respondWith(() => new Response('', { status: 200, headers: { 'content-length': '0' } }));

    const schema: ResponseParser<string> = {
      parse: (input) => (input === undefined ? 'пусто' : 'что-то'),
    };

    await expect(api.get('/lessons/1', { schema })).resolves.toBe('пусто');
  });

  it('снимает подписку на внешнюю отмену после успешного ответа', async () => {
    respondWith(() => jsonResponse({ ok: true }));

    const controller = new AbortController();

    await expect(api.get('/health', { signal: controller.signal })).resolves.toEqual({ ok: true });

    // Отмена после завершения запроса ничего не ломает.
    expect(() => {
      controller.abort();
    }).not.toThrow();
  });
});

describe('отказ на стороне клиента', () => {
  it('превращает обрыв связи в сетевую ошибку со статусом 0', async () => {
    handler = () => Promise.reject(new TypeError('Failed to fetch'));

    const error = await apiFailure(api.get('/health'));

    expect(error.isNetworkError).toBe(true);
    expect(error.isTimeout).toBe(false);
    expect(error.status).toBe(0);
    expect(error.code).toBe('upstream_unavailable');
    expect(error.clientReason).toBe('network');
  });

  it('превращает истёкший таймаут в ошибку с isTimeout', async () => {
    vi.useFakeTimers();
    handler = pendingUntilAbort;

    const failure = apiFailure(api.get('/lessons'));

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);

    const error = await failure;

    expect(error.isTimeout).toBe(true);
    expect(error.isNetworkError).toBe(false);
    expect(error.status).toBe(0);
    expect(error.clientReason).toBe('timeout');
    expect(error.details).toMatchObject({ reason: 'timeout', timeoutMs: DEFAULT_TIMEOUT_MS });
  });

  it('уважает собственный таймаут запроса', async () => {
    vi.useFakeTimers();
    handler = pendingUntilAbort;

    let settled = false;
    const promise = api.get('/lessons', { timeoutMs: 100 });
    const failure = apiFailure(promise);

    void promise.catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect((await failure).isTimeout).toBe(true);
  });

  it('не ограничивает время при timeoutMs = 0', async () => {
    vi.useFakeTimers();

    let resolveFetch: (response: Response) => void = () => undefined;

    handler = () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });

    const promise = api.get('/lessons', { timeoutMs: 0 });

    await vi.advanceTimersByTimeAsync(10 * DEFAULT_TIMEOUT_MS);

    resolveFetch(jsonResponse({ ok: true }));

    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('пробрасывает отмену вызывающей стороной как AbortError, а не как ApiError', async () => {
    handler = pendingUntilAbort;

    const controller = new AbortController();
    const failure = rejection(api.get('/lessons', { signal: controller.signal }));

    controller.abort();

    const error = await failure;

    expect(isApiError(error)).toBe(false);
    expect((error as Error).name).toBe('AbortError');
  });

  it('таймаут и отмена различимы по типу ошибки', async () => {
    vi.useFakeTimers();
    handler = pendingUntilAbort;

    const controller = new AbortController();
    const cancelled = rejection(api.get('/lessons', { signal: controller.signal }));
    const timedOut = apiFailure(api.get('/lessons', { timeoutMs: 50 }));

    controller.abort();
    await vi.advanceTimersByTimeAsync(50);

    expect(isApiError(await cancelled)).toBe(false);
    expect((await timedOut).isTimeout).toBe(true);
  });
});

describe('ответ не разбирается', () => {
  it('сообщает о некорректном JSON', async () => {
    respondWith(
      () =>
        new Response('<html>502</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );

    const error = await apiFailure(api.get('/lessons'));

    expect(error.isInvalidResponse).toBe(true);
    expect(error.status).toBe(200);
    expect(error.code).toBe('internal_error');
    expect(error.details).toMatchObject({ reason: 'invalid_json' });
  });

  it('не проглатывает ответ, не прошедший схему', async () => {
    respondWith(() => jsonResponse({ unexpected: true }));

    const schema: ResponseParser<{ title: string }> = {
      parse: () => {
        throw new Error('Обязательное поле title отсутствует');
      },
    };

    const error = await apiFailure(api.get('/lessons/1', { schema }));

    expect(error.isInvalidResponse).toBe(true);
    expect(error.status).toBe(200);
    expect(error.details).toMatchObject({ reason: 'schema_mismatch' });
    expect(String((error.details as { cause: string }).cause)).toContain('title');
  });

  it('даёт такой же ApiError, когда схему не прошло ПУСТОЕ тело', async () => {
    // Регрессия: пустое тело разбиралось мимо try/catch, поэтому наружу уходил
    // сырой ZodError вместо ApiError. Один и тот же класс расхождения со схемой
    // обязан приходить вызывающему коду одинаково — иначе обработка ошибок в
    // фичах работает через раз в зависимости от того, прислал сервер тело.
    respondWith(() => new Response(null, { status: 204 }));

    const schema: ResponseParser<{ title: string }> = {
      parse: (input) => {
        if (input === undefined) {
          throw new Error('Обязательное поле title отсутствует');
        }

        return input as { title: string };
      },
    };

    const error = await apiFailure(api.get('/lessons/1', { schema }));

    expect(isApiError(error)).toBe(true);
    expect(error.isInvalidResponse).toBe(true);
    expect(error.status).toBe(204);
    expect(error.details).toMatchObject({ reason: 'schema_mismatch' });
  });
});

describe('ошибка сервера', () => {
  it('разбирает конверт ошибки в поля ApiError', async () => {
    respondWith(() =>
      errorResponse(
        { code: 'not_found', message: 'Урок не найден', details: { lessonId: '42' } },
        404,
      ),
    );

    const error = await apiFailure(api.get('/lessons/42'));

    expect(error.code).toBe('not_found');
    expect(error.message).toBe('Урок не найден');
    expect(error.status).toBe(404);
    expect(error.details).toEqual({ lessonId: '42' });
    expect(error.clientReason).toBeNull();
    expect(error.isNotFound).toBe(true);
    expect(error.isNetworkError).toBe(false);
    expect(error.isInvalidResponse).toBe(false);
  });

  it('распознаёт выключенного провайдера (501)', async () => {
    respondWith(() => errorResponse({ code: 'not_configured', message: 'STT не настроен' }, 501));

    const error = await apiFailure(api.post('/voice/stt'));

    expect(error.isNotConfigured).toBe(true);
    expect(error.isValidationError).toBe(false);
    expect(error.status).toBe(501);
    expect(error.details).toBeUndefined();
  });

  it('распознаёт отказ проверки схемы на сервере (400)', async () => {
    respondWith(() =>
      errorResponse({ code: 'validation_error', message: 'Неверный уровень' }, 400),
    );

    const error = await apiFailure(api.put('/profile', { level: 'Z9' }));

    expect(error.isValidationError).toBe(true);
    expect(error.isNotFound).toBe(false);
  });

  it('переживает ошибку с пустым телом', async () => {
    respondWith(() => new Response(null, { status: 500, statusText: 'Internal Server Error' }));

    const error = await apiFailure(api.get('/lessons'));

    expect(error.code).toBe('internal_error');
    expect(error.status).toBe(500);
    expect(error.message).toBe('HTTP 500 Internal Server Error');
    expect(error.details).toMatchObject({ reason: 'unparsed_error_body' });
  });

  it('переживает ошибку с телом-HTML', async () => {
    respondWith(
      () =>
        new Response('<html>Bad Gateway</html>', {
          status: 502,
          statusText: 'Bad Gateway',
          headers: { 'content-type': 'text/html' },
        }),
    );

    const error = await apiFailure(api.get('/lessons'));

    expect(error.code).toBe('upstream_error');
    expect(error.status).toBe(502);
    expect(error.clientReason).toBeNull();
  });

  it('переживает конверт неизвестной формы, сохраняя тело в details', async () => {
    respondWith(() => jsonResponse({ error: { code: 'нет такого кода' } }, 503));

    const error = await apiFailure(api.get('/lessons'));

    expect(error.code).toBe('upstream_unavailable');
    expect(error.status).toBe(503);
    expect(error.details).toMatchObject({
      reason: 'unparsed_error_body',
      body: { error: { code: 'нет такого кода' } },
    });
  });

  it('подбирает код по статусу вне таблицы', async () => {
    respondWith(() => new Response(null, { status: 418, statusText: "I'm a teapot" }));
    expect((await apiFailure(api.get('/lessons'))).code).toBe('bad_request');

    respondWith(() => new Response(null, { status: 599, statusText: 'Unknown' }));
    expect((await apiFailure(api.get('/lessons'))).code).toBe('internal_error');
  });
});

describe('загрузка файла', () => {
  it('отправляет FormData и не выставляет Content-Type вручную', async () => {
    respondWith(() => jsonResponse({ id: 'material-1' }));

    const form = new FormData();

    form.append('file', new Blob(['текст'], { type: 'text/plain' }), 'note.txt');

    await expect(api.upload('/materials', form)).resolves.toEqual({ id: 'material-1' });

    expect(lastRequest().init.body).toBe(form);
    expect(lastHeaders()['Content-Type']).toBeUndefined();
    expect(lastHeaders().Accept).toBe('application/json');
    expect(lastRequest().init.method).toBe('POST');
  });

  it('умеет отправлять PUT', async () => {
    respondWith(() => jsonResponse({ id: 'material-1' }));

    await api.upload('/materials/1', new FormData(), { method: 'PUT' });

    expect(lastRequest().init.method).toBe('PUT');
  });

  it('даёт файлу больше времени, чем обычному запросу', async () => {
    vi.useFakeTimers();
    handler = pendingUntilAbort;

    let settled = false;
    const promise = api.upload('/materials', new FormData());
    const failure = apiFailure(promise);

    void promise.catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS - DEFAULT_TIMEOUT_MS);

    expect((await failure).isTimeout).toBe(true);
  });
});

describe('бинарный ответ', () => {
  it('отдаёт содержимое, тип и имя файла', async () => {
    respondWith(
      () =>
        new Response('id3-аудио', {
          status: 200,
          headers: {
            'content-type': 'audio/mpeg',
            'content-disposition': 'attachment; filename="lesson.mp3"',
          },
        }),
    );

    const result = await api.getBinary('/voice/tts/1');

    expect(await result.blob.text()).toBe('id3-аудио');
    expect(result.contentType).toBe('audio/mpeg');
    expect(result.fileName).toBe('lesson.mp3');
    expect(lastHeaders().Accept).toBe('*/*');
  });

  it('разбирает имя файла в кодировке UTF-8', async () => {
    respondWith(
      () =>
        new Response('pdf', {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': `attachment; filename="urok.pdf"; filename*=UTF-8''${encodeURIComponent('урок.pdf')}`,
          },
        }),
    );

    expect((await api.getBinary('/materials/1/file')).fileName).toBe('урок.pdf');
  });

  it('отдаёт имя как есть, если его не удалось раскодировать', async () => {
    respondWith(
      () =>
        new Response('pdf', {
          headers: { 'content-disposition': "attachment; filename*=UTF-8''%E0%A4%A" },
        }),
    );

    expect((await api.getBinary('/materials/1/file')).fileName).toBe('%E0%A4%A');
  });

  it('отдаёт null и пустой тип, когда сервер их не прислал', async () => {
    respondWith(() => new Response(null, { status: 200 }));

    const result = await api.getBinary('/materials/1/file');

    expect(result.fileName).toBeNull();
    expect(result.contentType).toBe('');
    expect(result.blob.size).toBe(0);
  });

  it('postBinary отправляет тело-JSON и принимает любой тип ответа', async () => {
    respondWith(() => new Response('аудио', { headers: { 'content-type': 'audio/wav' } }));

    const result = await api.postBinary('/voice/tts', { text: 'Guten Tag' });

    expect(lastRequest().init.method).toBe('POST');
    expect(lastRequest().init.body).toBe(JSON.stringify({ text: 'Guten Tag' }));
    expect(lastHeaders()['Content-Type']).toBe('application/json');
    expect(lastHeaders().Accept).toBe('*/*');
    expect(result.contentType).toBe('audio/wav');
    expect(result.fileName).toBeNull();
  });

  it('postBinary без тела отправляет пустой объект', async () => {
    respondWith(() => new Response('аудио'));

    await api.postBinary('/voice/tts');

    expect(lastRequest().init.body).toBe('{}');
  });

  it('превращает ошибку сервера в ApiError и для бинарного запроса', async () => {
    respondWith(() => errorResponse({ code: 'not_configured', message: 'TTS выключен' }, 501));

    const error = await apiFailure(api.postBinary('/voice/tts', { text: 'Hallo' }));

    expect(error.isNotConfigured).toBe(true);
    expect(error.status).toBe(501);
  });
});

describe('ApiError', () => {
  it('отдаёт уже готовую ошибку без изменений', () => {
    const original = new ApiError({ code: 'not_found', message: 'нет', status: 404 });

    expect(ApiError.from(original)).toBe(original);
  });

  it('заворачивает обычное исключение', () => {
    const error = ApiError.from(new Error('что-то пошло не так'));

    expect(error.code).toBe('internal_error');
    expect(error.message).toBe('что-то пошло не так');
    expect(error.status).toBe(0);
    expect(error.clientReason).toBeNull();
    expect(error.details).toEqual({ reason: 'unexpected_client_error' });
  });

  it('заворачивает значение, которое даже не ошибка', () => {
    expect(ApiError.from('сломалось').message).toBe('сломалось');
    expect(ApiError.from(undefined).message).toBe('undefined');
  });

  it('узнаётся по isApiError и остаётся Error', () => {
    const error = new ApiError({ code: 'conflict', message: 'занято', status: 409 });

    expect(isApiError(error)).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ApiError');
    expect(isApiError(new Error('занято'))).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(isApiError({ code: 'conflict', status: 409 })).toBe(false);
  });
});
