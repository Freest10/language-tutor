/**
 * Типизированный клиент HTTP API.
 *
 * ПРАВИЛО ПАКЕТОВ: фичевый пакет пользуется этим модулем и не меняет его —
 * набор методов зафиксирован здесь целиком, чтобы параллельная работа
 * не пересекалась в общем файле.
 *
 * Любой неуспешный ответ сервера приходит в конверте `{ error: { code, message, details? } }`
 * (см. `@lt/shared`) и превращается в `ApiError` с полями `code`, `message`, `details`, `status`.
 * Обрыв связи и таймаут тоже дают `ApiError` (`status: 0`) — вызывающему коду
 * не нужно различать источники отказа.
 *
 * Отмена вызывающей стороной (`options.signal`) пробрасывается как есть:
 * TanStack Query отличает отменённый запрос от неудачного по `AbortError`.
 */
import { API_ERROR_STATUS, apiErrorResponseSchema, type ApiErrorCode } from '@lt/shared';

import { buildApiUrl, DEFAULT_TIMEOUT_MS, UPLOAD_TIMEOUT_MS, type QueryParams } from './config';

/** Причина отказа на стороне клиента; `null` — ошибку прислал сервер. */
export type ClientErrorReason = 'network' | 'timeout' | 'invalid_response';

/** Поля, из которых собирается `ApiError`. */
export interface ApiErrorInit {
  code: ApiErrorCode;
  message: string;
  /** HTTP-статус ответа; `0` — ответа не было (обрыв связи, таймаут). */
  status: number;
  details?: unknown;
  clientReason?: ClientErrorReason;
}

/** Ошибка обращения к API: и ответ сервера, и отказ на стороне клиента. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  /** Машиночитаемый код из `API_ERROR_CODES`. */
  readonly code: ApiErrorCode;

  /** HTTP-статус; `0`, если ответа не было. */
  readonly status: number;

  /** Диагностика из конверта ошибки: структура зависит от кода. */
  readonly details: unknown;

  /** Причина отказа на стороне клиента; `null` — ошибку прислал сервер. */
  readonly clientReason: ClientErrorReason | null;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.clientReason = init.clientReason ?? null;
  }

  /** Сервер недоступен: запрос не дошёл или соединение оборвалось. */
  get isNetworkError(): boolean {
    return this.clientReason === 'network';
  }

  /** Сервер не ответил за отведённое время. */
  get isTimeout(): boolean {
    return this.clientReason === 'timeout';
  }

  /** Ответ пришёл, но не разобрался в ожидаемую структуру. */
  get isInvalidResponse(): boolean {
    return this.clientReason === 'invalid_response';
  }

  /** Возможность не настроена (501) — типичный ответ ещё не реализованного маршрута. */
  get isNotConfigured(): boolean {
    return this.code === 'not_configured';
  }

  /** Ресурс не найден (404). */
  get isNotFound(): boolean {
    return this.code === 'not_found';
  }

  /** Запрос не прошёл проверку схемы на сервере (400). */
  get isValidationError(): boolean {
    return this.code === 'validation_error';
  }

  /** Приводит произвольное исключение к `ApiError`. */
  static from(error: unknown): ApiError {
    if (error instanceof ApiError) {
      return error;
    }

    return new ApiError({
      code: 'internal_error',
      message: error instanceof Error ? error.message : String(error),
      status: 0,
      details: { reason: 'unexpected_client_error' },
    });
  }
}

/** Является ли значение ошибкой обращения к API. */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Разборщик ответа: подходит любая Zod-схема из `@lt/shared`. */
export interface ResponseParser<T> {
  parse: (input: unknown) => T;
}

/** Параметры запроса. */
export interface RequestOptions<T = unknown> {
  /** Query-параметры; `null` и `undefined` не отправляются. */
  query?: QueryParams;
  /** Отмена вызывающей стороной; пробрасывается как `AbortError`. */
  signal?: AbortSignal;
  /** Таймаут запроса в миллисекундах; `0` отключает его. */
  timeoutMs?: number;
  /** Дополнительные заголовки запроса. */
  headers?: Record<string, string>;
  /** Схема ответа; при указании тип результата выводится из неё. */
  schema?: ResponseParser<T>;
}

/** Параметры запроса за бинарным содержимым (схемы у него нет). */
export type BinaryRequestOptions = Omit<RequestOptions, 'schema'>;

/** Бинарный ответ: аудио синтеза речи, выгрузка файла материала. */
export interface BinaryResponse {
  blob: Blob;
  /** Content-Type ответа; пустая строка, если сервер его не прислал. */
  contentType: string;
  /** Имя файла из Content-Disposition, если сервер его прислал. */
  fileName: string | null;
}

/** HTTP-метод, который умеет клиент. */
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Внутреннее описание запроса до отправки. */
interface FetchPlan {
  method: HttpMethod;
  query?: QueryParams | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  headers?: Record<string, string> | undefined;
  body?: BodyInit | undefined;
  /** Тело-JSON; сериализуется и добавляет заголовок Content-Type. */
  json?: unknown;
  accept: 'application/json' | '*/*';
}

/**
 * Код ошибки по HTTP-статусу — обратное отображение `API_ERROR_STATUS`.
 * Нужен, когда сервер ответил ошибкой без конверта (например, упал прокси).
 */
const CODE_BY_STATUS: Record<number, ApiErrorCode> = Object.entries(API_ERROR_STATUS).reduce<
  Record<number, ApiErrorCode>
>((accumulator, [code, status]) => {
  accumulator[status] ??= code as ApiErrorCode;

  return accumulator;
}, {});

/** Код ошибки для статуса вне таблицы: клиентский или серверный отказ. */
function codeByStatus(status: number): ApiErrorCode {
  return CODE_BY_STATUS[status] ?? (status >= 500 ? 'internal_error' : 'bad_request');
}

/** Имя файла из заголовка Content-Disposition. */
function fileNameFromDisposition(disposition: string | null): string | null {
  if (!disposition) {
    return null;
  }

  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];

  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }

  return /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? null;
}

/** Разбирает тело неуспешного ответа в `ApiError`. */
async function toApiError(response: Response): Promise<ApiError> {
  const raw: unknown = await response.json().catch(() => undefined);
  const parsed = apiErrorResponseSchema.safeParse(raw);

  if (parsed.success) {
    return new ApiError({
      code: parsed.data.error.code,
      message: parsed.data.error.message,
      details: parsed.data.error.details,
      status: response.status,
    });
  }

  return new ApiError({
    code: codeByStatus(response.status),
    message: `HTTP ${response.status} ${response.statusText}`.trim(),
    status: response.status,
    details: { reason: 'unparsed_error_body', body: raw },
  });
}

/** Отправляет запрос, отдаёт успешный ответ и превращает любой отказ в `ApiError`. */
async function fetchApi(path: string, plan: FetchPlan): Promise<Response> {
  const url = buildApiUrl(path, plan.query);
  const headers: Record<string, string> = { Accept: plan.accept, ...plan.headers };
  let body = plan.body;

  if (plan.json !== undefined) {
    body = JSON.stringify(plan.json);
    headers['Content-Type'] ??= 'application/json';
  }

  const controller = new AbortController();
  const timeoutMs = plan.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;

  const abortFromCaller = (): void => {
    controller.abort();
  };

  plan.signal?.addEventListener('abort', abortFromCaller, { once: true });

  let response: Response;

  try {
    response = await fetch(url, {
      method: plan.method,
      headers,
      body,
      signal: controller.signal,
      credentials: 'same-origin',
    });
  } catch (error) {
    // Отмена вызывающей стороной — не ошибка API: пробрасываем как есть.
    if (plan.signal?.aborted) {
      throw error;
    }

    if (timedOut) {
      throw new ApiError({
        code: 'upstream_unavailable',
        message: `Запрос ${plan.method} ${url} не завершился за ${timeoutMs} мс`,
        status: 0,
        details: { reason: 'timeout', timeoutMs, url },
        clientReason: 'timeout',
      });
    }

    throw new ApiError({
      code: 'upstream_unavailable',
      message: `Не удалось выполнить запрос ${plan.method} ${url}`,
      status: 0,
      details: { reason: 'network_error', url, cause: String(error) },
      clientReason: 'network',
    });
  } finally {
    clearTimeout(timer);
    plan.signal?.removeEventListener('abort', abortFromCaller);
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  return response;
}

/** Выполняет запрос и разбирает ответ как JSON. */
async function requestJson<T>(
  path: string,
  plan: FetchPlan,
  schema?: ResponseParser<T>,
): Promise<T> {
  const response = await fetchApi(path, plan);

  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return schema ? parseWithSchema(schema, undefined, response.status) : (undefined as T);
  }

  let data: unknown;

  try {
    data = await response.json();
  } catch (error) {
    throw new ApiError({
      code: 'internal_error',
      message: 'Ответ сервера не является корректным JSON',
      status: response.status,
      details: { reason: 'invalid_json', cause: String(error) },
      clientReason: 'invalid_response',
    });
  }

  if (!schema) {
    return data as T;
  }

  return parseWithSchema(schema, data, response.status);
}

/**
 * Разбор тела по схеме с единым видом отказа.
 *
 * Вынесено в помощник намеренно: пустое тело (204 / content-length: 0) и
 * непустое должны давать одинаковый ApiError, иначе один и тот же класс
 * расхождения со схемой приходил бы вызывающему коду то как ApiError, то как
 * сырой ZodError — в зависимости от того, прислал сервер тело или нет.
 */
function parseWithSchema<T>(schema: ResponseParser<T>, value: unknown, status: number): T {
  try {
    return schema.parse(value);
  } catch (error) {
    throw new ApiError({
      code: 'internal_error',
      message: 'Ответ сервера не соответствует ожидаемой схеме',
      status,
      details: { reason: 'schema_mismatch', cause: String(error) },
      clientReason: 'invalid_response',
    });
  }
}

/** Выполняет запрос и отдаёт бинарное тело ответа. */
async function requestBinary(path: string, plan: FetchPlan): Promise<BinaryResponse> {
  const response = await fetchApi(path, plan);

  return {
    blob: await response.blob(),
    contentType: response.headers.get('content-type') ?? '',
    fileName: fileNameFromDisposition(response.headers.get('content-disposition')),
  };
}

/** Клиент HTTP API: один экземпляр на приложение. */
export const api = {
  /** `GET`, ответ — JSON. */
  get<T>(path: string, options: RequestOptions<T> = {}): Promise<T> {
    return requestJson<T>(
      path,
      {
        method: 'GET',
        query: options.query,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        headers: options.headers,
        accept: 'application/json',
      },
      options.schema,
    );
  },

  /** `POST` с телом-JSON, ответ — JSON. */
  post<T>(path: string, body?: unknown, options: RequestOptions<T> = {}): Promise<T> {
    return requestJson<T>(
      path,
      {
        method: 'POST',
        json: body ?? {},
        query: options.query,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        headers: options.headers,
        accept: 'application/json',
      },
      options.schema,
    );
  },

  /** `PUT` с телом-JSON, ответ — JSON. */
  put<T>(path: string, body?: unknown, options: RequestOptions<T> = {}): Promise<T> {
    return requestJson<T>(
      path,
      {
        method: 'PUT',
        json: body ?? {},
        query: options.query,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        headers: options.headers,
        accept: 'application/json',
      },
      options.schema,
    );
  },

  /** `PATCH` с телом-JSON, ответ — JSON. */
  patch<T>(path: string, body?: unknown, options: RequestOptions<T> = {}): Promise<T> {
    return requestJson<T>(
      path,
      {
        method: 'PATCH',
        json: body ?? {},
        query: options.query,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        headers: options.headers,
        accept: 'application/json',
      },
      options.schema,
    );
  },

  /** `DELETE`, ответ — JSON. */
  delete<T>(path: string, options: RequestOptions<T> = {}): Promise<T> {
    return requestJson<T>(
      path,
      {
        method: 'DELETE',
        query: options.query,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        headers: options.headers,
        accept: 'application/json',
      },
      options.schema,
    );
  },

  /**
   * Multipart-запрос: загрузка файла материала, отправка аудио на распознавание.
   * Content-Type выставляет браузер — вместе с границей частей.
   */
  upload<T>(
    path: string,
    body: FormData,
    options: RequestOptions<T> & { method?: 'POST' | 'PUT' } = {},
  ): Promise<T> {
    return requestJson<T>(
      path,
      {
        method: options.method ?? 'POST',
        body,
        query: options.query,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? UPLOAD_TIMEOUT_MS,
        headers: options.headers,
        accept: 'application/json',
      },
      options.schema,
    );
  },

  /** `GET`, ответ — бинарный (аудио, файл материала). */
  getBinary(path: string, options: BinaryRequestOptions = {}): Promise<BinaryResponse> {
    return requestBinary(path, {
      method: 'GET',
      query: options.query,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      headers: options.headers,
      accept: '*/*',
    });
  },

  /** `POST` с телом-JSON, ответ — бинарный (синтез речи). */
  postBinary(
    path: string,
    body?: unknown,
    options: BinaryRequestOptions = {},
  ): Promise<BinaryResponse> {
    return requestBinary(path, {
      method: 'POST',
      json: body ?? {},
      query: options.query,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      headers: options.headers,
      accept: '*/*',
    });
  },

  /** Полный адрес эндпоинта — для `<audio src>` и ссылок на скачивание. */
  url: buildApiUrl,
};
