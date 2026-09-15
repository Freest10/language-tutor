/**
 * Общие типы провайдеров ИИ-функций и их модель отказа.
 *
 * Все три функции (текст, распознавание, синтез) ходят по OpenAI-совместимому HTTP
 * через один клиент `openaiCompatible.ts`, поэтому и ошибка у них одна —
 * `ProviderError`. HTTP-слой не разбирается в устройстве провайдера: маршрут
 * переводит `ProviderError` в `AppError` функцией `providerErrorToAppError()`
 * и отдаёт клиенту обычный конверт `{ error }`.
 *
 * Провайдеры ничего не знают о переменных окружения: конфигурацию им передаёт
 * `factory.ts`. Так их можно собрать в тесте с произвольными параметрами.
 */
import type { AudioFormat, LanguageCode, VoiceProvider } from '@lt/shared';

import {
  notConfigured,
  upstreamError,
  upstreamUnavailable,
  internalError,
  isAppError,
  type AppError,
} from '../lib/httpErrors.js';

/** Какую ИИ-функцию обслуживает провайдер. */
export const PROVIDER_TARGETS = ['llm', 'stt', 'tts'] as const;

/** Какую ИИ-функцию обслуживает провайдер. */
export type ProviderTarget = (typeof PROVIDER_TARGETS)[number];

/**
 * Вид отказа провайдера:
 * - `not_configured` — не задан адрес или модель (или выбран `browser`);
 * - `timeout` — провайдер не ответил за отведённое время;
 * - `network` — соединение не установлено или разорвано;
 * - `http` — провайдер ответил статусом 4xx/5xx;
 * - `invalid_response` — ответ разобрать не удалось (не JSON, нет нужных полей).
 */
export const PROVIDER_ERROR_KINDS = [
  'not_configured',
  'timeout',
  'network',
  'http',
  'invalid_response',
] as const;

/** Вид отказа провайдера. */
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/** Дополнительные сведения об отказе провайдера. */
export interface ProviderErrorOptions {
  /** HTTP-статус ответа провайдера (для `kind: 'http'`). */
  status?: number;
  /** Фрагмент ответа провайдера: уходит только в лог, клиенту не отдаётся. */
  detail?: string;
  /** Номер попытки, на которой запрос окончательно не удался. */
  attempt?: number;
  /** Задержка из заголовка `Retry-After`, мс. */
  retryAfterMs?: number;
  cause?: unknown;
}

/**
 * Отказ внешнего провайдера. Сообщение рассчитано на лог: наружу уходит текст,
 * который подставляет `providerErrorToAppError()`.
 */
export class ProviderError extends Error {
  /** Какая функция отказала. */
  readonly target: ProviderTarget;
  /** Вид отказа. */
  readonly kind: ProviderErrorKind;
  /** HTTP-статус ответа провайдера, если он был. */
  readonly status: number | undefined;
  /** Фрагмент ответа провайдера для лога. */
  readonly detail: string | undefined;
  /** Номер попытки, на которой запрос окончательно не удался. */
  readonly attempt: number | undefined;
  /** Задержка из заголовка `Retry-After`, мс. */
  readonly retryAfterMs: number | undefined;

  constructor(
    target: ProviderTarget,
    kind: ProviderErrorKind,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.target = target;
    this.kind = kind;
    this.status = options.status;
    this.detail = options.detail;
    this.attempt = options.attempt;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Проверяет, что ошибка — отказ провайдера. */
export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/** Человекочитаемые названия функций для сообщений клиенту. */
const TARGET_LABELS: Record<ProviderTarget, string> = {
  llm: 'Языковая модель',
  stt: 'Распознавание речи',
  tts: 'Синтез речи',
};

/** Машиночитаемая пометка в `details` ответа для каждого вида отказа. */
const REASON_SUFFIXES: Record<ProviderErrorKind, string> = {
  not_configured: 'not_configured',
  timeout: 'timeout',
  network: 'unavailable',
  http: 'upstream_error',
  invalid_response: 'invalid_response',
};

/**
 * Переводит отказ провайдера в ошибку HTTP-слоя:
 * - не настроен → 501 `not_configured`;
 * - таймаут или нет соединения → 503 `upstream_unavailable`;
 * - провайдер ответил ошибкой или неразбираемым результатом → 502 `upstream_error`.
 *
 * `AppError` пропускается как есть, всё остальное становится 500: подробности
 * неожиданной ошибки клиенту не показываются, но остаются в логе через `cause`.
 */
export function providerErrorToAppError(error: unknown, target: ProviderTarget): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (!isProviderError(error)) {
    return internalError(`${TARGET_LABELS[target]}: неожиданная ошибка`, { cause: error });
  }

  const label = TARGET_LABELS[error.target];
  const details = {
    reason: `${error.target}_${REASON_SUFFIXES[error.kind]}`,
    ...(error.status === undefined ? {} : { status: error.status }),
  };
  const options = { details, cause: error };

  switch (error.kind) {
    case 'not_configured':
      return notConfigured(error.message, options);
    case 'timeout':
      return upstreamUnavailable(`${label} не ответила за отведённое время`, options);
    case 'network':
      return upstreamUnavailable(`${label} недоступна`, options);
    case 'http':
      return upstreamError(`${label} ответила ошибкой`, options);
    case 'invalid_response':
      return upstreamError(
        `Ответ провайдера не удалось разобрать: ${label.toLowerCase()}`,
        options,
      );
  }
}

/** Минимальный логгер: совместим с `request.log` Fastify (pino). */
export interface ProviderLogger {
  debug(payload: object, message: string): void;
  warn(payload: object, message: string): void;
}

/** Роль реплики в диалоге с языковой моделью. */
export const CHAT_ROLES = ['system', 'user', 'assistant'] as const;

/** Роль реплики в диалоге с языковой моделью. */
export type ChatRole = (typeof CHAT_ROLES)[number];

/** Реплика диалога с языковой моделью. */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Расход токенов, если провайдер его сообщает. */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Запрос к языковой модели. */
export interface ChatRequest {
  /** Диалог целиком: системная инструкция, история, текущий запрос. */
  messages: ChatMessage[];
  /** Температура генерации; по умолчанию — заданная при создании провайдера. */
  temperature?: number;
  /** Верхняя граница длины ответа в токенах. */
  maxTokens?: number;
  /** Просить ответ строго JSON-объектом (`response_format: { type: 'json_object' }`). */
  jsonMode?: boolean;
  /** Модель для этого запроса; по умолчанию — модель провайдера. */
  model?: string;
  /** Отмена запроса извне (в дополнение к собственному таймауту). */
  signal?: AbortSignal;
}

/** Ответ языковой модели. */
export interface ChatResult {
  /** Текст ответа без служебных блоков рассуждений. */
  text: string;
  /** Расход токенов; `null` — провайдер его не сообщил. */
  usage: ChatUsage | null;
  /** Модель, которой ответил провайдер. */
  model: string;
  /** Почему генерация завершилась: `stop`, `length`, … */
  finishReason: string | null;
}

/** Провайдер языковой модели. */
export interface LlmProvider {
  /** Модель по умолчанию. */
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResult>;
}

/** Запрос распознавания речи. */
export interface SttRequest {
  /** Содержимое аудиофайла. */
  audio: Uint8Array;
  /** Имя файла: по расширению провайдер определяет контейнер. */
  filename: string;
  /** MIME-тип записи. */
  contentType: string;
  /** Подсказка о языке записи. */
  language?: LanguageCode;
  /** Контекстная подсказка распознавателю (термины урока). */
  prompt?: string;
  signal?: AbortSignal;
}

/** Результат распознавания речи. */
export interface SttResult {
  text: string;
  /** Язык, определённый распознавателем; `null` — не сообщён. */
  language: LanguageCode | null;
  durationMs: number | null;
  model: string | null;
}

/** Провайдер распознавания речи. */
export interface SttProvider {
  /** Чем выполняется распознавание (для ответа API). */
  readonly provider: VoiceProvider;
  readonly model: string | null;
  transcribe(request: SttRequest): Promise<SttResult>;
}

/**
 * Запрос синтеза речи. Язык сюда не передаётся: у OpenAI-совместимого
 * `/audio/speech` такого параметра нет, произношение задаёт голос.
 */
export interface TtsSynthesisRequest {
  text: string;
  /** Голос; по умолчанию — заданный при создании провайдера. */
  voice?: string;
  format: AudioFormat;
  /** Скорость речи: 1 — обычная. */
  speed?: number;
  signal?: AbortSignal;
}

/** Результат синтеза речи. */
export interface TtsResult {
  /** Двоичное аудио как его отдал провайдер. */
  audio: Uint8Array;
  contentType: string;
  format: AudioFormat;
  voice: string | null;
  model: string | null;
}

/** Провайдер синтеза речи. */
export interface TtsProvider {
  /** Чем выполняется синтез (для ответа API). */
  readonly provider: VoiceProvider;
  readonly model: string | null;
  synthesize(request: TtsSynthesisRequest): Promise<TtsResult>;
}
