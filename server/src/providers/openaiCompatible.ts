/**
 * HTTP-клиент OpenAI-совместимого API — общий для LLM, STT и TTS.
 *
 * Зачем один клиент на три функции: адрес каждой задаётся своей переменной
 * окружения, поэтому пользователь может собрать связку из локальных сервисов
 * (Ollama + faster-whisper-server + Kokoro) или из облака, не меняя код.
 * Отличаются они только путём (`/chat/completions`, `/audio/transcriptions`,
 * `/audio/speech`) и формой тела, а таймаут, повторы и разбор ошибок — общие.
 *
 * Повторы: только там, где они осмысленны — 429, 5xx и обрыв соединения.
 * Таймаут не повторяется: модель уже потратила отведённое время, второй заход
 * с тем же результатом лишь удвоит ожидание пользователя.
 *
 * Секреты: ключ уходит только в заголовок `Authorization` и никогда — в лог.
 * Тела запросов не логируются вовсе, из ответа берётся обрезанный фрагмент,
 * в котором значение ключа на всякий случай маскируется.
 */
import { ProviderError, type ProviderLogger, type ProviderTarget } from './types.js';

/** Политика повторов запроса к провайдеру. */
export interface RetryPolicy {
  /** Сколько всего попыток, включая первую. */
  attempts: number;
  /** Задержка перед первым повтором, мс. */
  initialDelayMs: number;
  /** Во сколько раз растёт задержка с каждой попыткой. */
  factor: number;
  /** Верхняя граница задержки, мс. */
  maxDelayMs: number;
}

/** Политика повторов по умолчанию: три попытки, задержки 500 и 1000 мс. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  initialDelayMs: 500,
  factor: 2,
  maxDelayMs: 4000,
};

/** Таймаут запроса по умолчанию, мс (голосовые запросы короче ответов модели). */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Максимальная длина фрагмента ответа провайдера, попадающего в лог. */
export const MAX_DETAIL_LENGTH = 500;

/** Статусы, при которых повтор имеет смысл. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Параметры HTTP-клиента провайдера. */
export interface OpenAiCompatibleOptions {
  /** Базовый URL API, например `http://localhost:11434/v1`. */
  baseUrl: string;
  /** Ключ API; заголовок `Authorization` добавляется, только если ключ задан. */
  apiKey?: string | undefined;
  /** Таймаут одной попытки, мс. */
  timeoutMs?: number;
  /** Политика повторов; незаданные поля берутся из `DEFAULT_RETRY_POLICY`. */
  retry?: Partial<RetryPolicy>;
  /** Какую функцию обслуживает клиент: попадает в ошибки и лог. */
  target: ProviderTarget;
  logger?: ProviderLogger | undefined;
}

/** Параметры одного обращения к провайдеру. */
export interface CallOptions {
  /** Отмена запроса извне. */
  signal?: AbortSignal | undefined;
  /** Таймаут именно этого обращения, мс. */
  timeoutMs?: number | undefined;
}

/** Тело запроса к провайдеру: JSON-строка или multipart-форма. */
type ProviderBody = string | FormData;

/** Двоичный ответ провайдера (аудио). */
export interface BinaryPayload {
  bytes: Uint8Array;
  /** Значение заголовка `Content-Type`, если провайдер его прислал. */
  contentType: string | null;
}

/** Ждёт указанное время; 0 — уступает очередь макрозадач. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Разбирает `Retry-After`: секунды или HTTP-дата. */
function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }

  const seconds = Number(header);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const timestamp = Date.parse(header);

  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

/** Склеивает базовый URL и путь, не плодя и не теряя слэши. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Адрес для лога: только схема, хост и путь.
 *
 * `LLM_BASE_URL` задаёт пользователь, и ключ доступа нередко живёт прямо в адресе —
 * в учётных данных (`https://user:sk-…@host`) или в строке запроса. Маскирование
 * текста ошибки такой ключ не ловит, а строка `warn` видна при `LOG_LEVEL=info`
 * по умолчанию, поэтому адрес урезается до безопасной части.
 */
export function logUrl(url: string): string {
  try {
    const parsed = new URL(url);

    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // Неразбираемый адрес в лог не попадает вовсе: в нём может быть что угодно.
    return '<invalid url>';
  }
}

/** Клиент OpenAI-совместимого API: таймаут, повторы, единый разбор ошибок. */
export class OpenAiCompatibleClient {
  /** Базовый URL API. */
  readonly baseUrl: string;
  /** Какую функцию обслуживает клиент. */
  readonly target: ProviderTarget;

  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly logger: ProviderLogger | undefined;

  constructor(options: OpenAiCompatibleOptions) {
    this.baseUrl = options.baseUrl;
    this.target = options.target;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };

    // Попытка всегда хотя бы одна: иначе запрос не был бы отправлен вовсе.
    this.retry = { ...retry, attempts: Math.max(1, retry.attempts) };
    this.logger = options.logger;
  }

  /** POST с телом JSON; ответ разбирается как JSON. */
  async postJson(path: string, body: unknown, options: CallOptions = {}): Promise<unknown> {
    const response = await this.send(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      options,
    );

    return this.readJson(response);
  }

  /** POST с телом multipart/form-data; ответ разбирается как JSON. */
  async postForm(path: string, form: FormData, options: CallOptions = {}): Promise<unknown> {
    // Content-Type с boundary проставляет сам fetch — задавать его вручную нельзя.
    const response = await this.send(path, { method: 'POST', body: form }, options);

    return this.readJson(response);
  }

  /** POST с телом JSON; ответ читается как двоичные данные (аудио). */
  async postForBytes(
    path: string,
    body: unknown,
    options: CallOptions = {},
  ): Promise<BinaryPayload> {
    const response = await this.send(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      options,
    );
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (bytes.byteLength === 0) {
      throw new ProviderError(this.target, 'invalid_response', 'Провайдер вернул пустой ответ');
    }

    return { bytes, contentType: response.headers.get('content-type') };
  }

  /** Заголовки запроса: ключ добавляется, только если он задан. */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', ...extra };

    if (this.apiKey !== undefined && this.apiKey.length > 0) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  /** Прячет значение ключа, если провайдер вернул его в тексте ошибки. */
  private redact(text: string): string {
    if (this.apiKey === undefined || this.apiKey.length === 0) {
      return text;
    }

    return text.split(this.apiKey).join('***');
  }

  /** Выполняет запрос с повторами; возвращает только успешный ответ. */
  private async send(
    path: string,
    init: { method: string; headers?: Record<string, string>; body: ProviderBody },
    options: CallOptions,
  ): Promise<Response> {
    const url = joinUrl(this.baseUrl, path);
    let lastError: ProviderError | undefined;

    for (let attempt = 1; attempt <= this.retry.attempts; attempt += 1) {
      const startedAt = Date.now();
      let failure: ProviderError;

      try {
        const response = await this.fetchOnce(url, init, options, attempt);

        if (response.ok) {
          this.logger?.debug(
            {
              target: this.target,
              url: logUrl(url),
              status: response.status,
              attempt,
              durationMs: Date.now() - startedAt,
            },
            'провайдер: запрос выполнен',
          );

          return response;
        }

        failure = await this.httpError(response, attempt);
      } catch (error) {
        failure = error instanceof ProviderError ? error : this.transportError(error, attempt);
      }

      lastError = failure;

      const retryable =
        isRetryable(failure) && attempt < this.retry.attempts && options.signal?.aborted !== true;

      if (!retryable) {
        throw failure;
      }

      const wait = this.delayFor(attempt, failure.retryAfterMs);

      this.logger?.warn(
        {
          target: this.target,
          url: logUrl(url),
          attempt,
          kind: failure.kind,
          status: failure.status,
          retryInMs: wait,
        },
        'провайдер: повтор запроса после ошибки',
      );

      await delay(wait);
    }

    throw lastError ?? new ProviderError(this.target, 'network', 'Запрос к провайдеру не выполнен');
  }

  /** Одна попытка запроса: собственный таймаут поверх внешней отмены. */
  private async fetchOnce(
    url: string,
    init: { method: string; headers?: Record<string, string>; body: ProviderBody },
    options: CallOptions,
    attempt: number,
  ): Promise<Response> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortFromCaller = (): void => {
      controller.abort();
    };

    options.signal?.addEventListener('abort', abortFromCaller, { once: true });

    if (options.signal?.aborted === true) {
      abortFromCaller();
    }

    try {
      return await fetch(url, {
        method: init.method,
        headers: this.headers(init.headers),
        body: init.body,
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new ProviderError(this.target, 'timeout', `Провайдер не ответил за ${timeoutMs} мс`, {
          attempt,
          cause: error,
        });
      }

      throw this.transportError(error, attempt);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  /** Ошибка соединения: сюда же попадает отмена запроса вызывающей стороной. */
  private transportError(error: unknown, attempt: number): ProviderError {
    const message = error instanceof Error ? error.message : String(error);

    return new ProviderError(
      this.target,
      'network',
      `Не удалось выполнить запрос к провайдеру: ${this.redact(message)}`,
      { attempt, cause: error },
    );
  }

  /** Ответ провайдера со статусом 4xx/5xx: тело читается только для лога. */
  private async httpError(response: Response, attempt: number): Promise<ProviderError> {
    let detail: string | undefined;

    try {
      const text = await response.text();

      detail = text.length > 0 ? this.redact(text).slice(0, MAX_DETAIL_LENGTH) : undefined;
    } catch {
      // Нечитаемое тело ошибки не должно подменять саму ошибку.
    }

    return new ProviderError(this.target, 'http', `Провайдер ответил статусом ${response.status}`, {
      status: response.status,
      detail,
      attempt,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    });
  }

  /** Разбирает тело успешного ответа как JSON. */
  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ProviderError(
        this.target,
        'invalid_response',
        'Провайдер вернул ответ, не являющийся JSON',
        { detail: this.redact(text).slice(0, MAX_DETAIL_LENGTH), cause: error },
      );
    }
  }

  /** Задержка перед повтором: экспоненциальный рост или значение `Retry-After`. */
  private delayFor(attempt: number, retryAfterMs: number | undefined): number {
    const backoff = this.retry.initialDelayMs * this.retry.factor ** (attempt - 1);

    return Math.min(this.retry.maxDelayMs, Math.max(retryAfterMs ?? 0, backoff));
  }
}

/** Повторять имеет смысл обрыв соединения и ответы 429/5xx. */
function isRetryable(error: ProviderError): boolean {
  if (error.kind === 'network') {
    return true;
  }

  return error.kind === 'http' && error.status !== undefined && isRetryableStatus(error.status);
}
