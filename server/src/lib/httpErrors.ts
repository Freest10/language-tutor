/**
 * Доменные ошибки HTTP-слоя.
 *
 * Обработчики бросают `AppError` (или ошибку из фабрик ниже), а `plugins/errorHandler.ts`
 * превращает её в конверт `{ error: { code, message, details? } }` из `@lt/shared`
 * со статусом из `API_ERROR_STATUS`. Изобретать собственные статусы не нужно:
 * код ошибки однозначно задаёт статус.
 *
 * `message` попадает в ответ клиенту — он должен быть человекочитаемым и без
 * внутренних подробностей. Первопричину кладите в `cause`: она уходит в лог целиком.
 */
import { API_ERROR_STATUS, type ApiErrorCode, type ApiErrorResponse } from '@lt/shared';

/** Дополнительные сведения об ошибке. */
export interface AppErrorOptions {
  /** Машиночитаемая диагностика для клиента (например, список проблемных полей). */
  details?: unknown;
  /** Первопричина: логируется, но клиенту не отдаётся. */
  cause?: unknown;
}

/**
 * Ошибка прикладного уровня с кодом из `API_ERROR_CODES`.
 *
 * `statusCode` — обычное поле (а не геттер) намеренно: Fastify присваивает его
 * собственным ошибкам валидации, и свойство должно быть записываемым.
 */
export class AppError extends Error {
  /** Машиночитаемый код ошибки API. */
  readonly code: ApiErrorCode;
  /** HTTP-статус, соответствующий коду. */
  readonly statusCode: number;
  /** Диагностика для клиента. */
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = API_ERROR_STATUS[code];
    this.details = options.details;
  }

  /** Тело ответа: конверт ошибки из `@lt/shared`. */
  toResponse(): ApiErrorResponse {
    return toApiErrorResponse(this.code, this.message, this.details);
  }
}

/** Проверяет, что ошибка — прикладная (а не системная). */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Собирает конверт ошибки; `details` опускается, если его нет. */
export function toApiErrorResponse(
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): ApiErrorResponse {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/** 400: запрос синтаксически верен, но неприемлем. */
export function badRequest(message: string, options?: AppErrorOptions): AppError {
  return new AppError('bad_request', message, options);
}

/** 400: тело, query или параметры не прошли проверку схемой. */
export function validationError(message: string, options?: AppErrorOptions): AppError {
  return new AppError('validation_error', message, options);
}

/** 404: сущность не найдена. */
export function notFound(message: string, options?: AppErrorOptions): AppError {
  return new AppError('not_found', message, options);
}

/** 409: состояние сущности не позволяет выполнить операцию. */
export function conflict(message: string, options?: AppErrorOptions): AppError {
  return new AppError('conflict', message, options);
}

/** 413: тело запроса или файл превышают допустимый размер. */
export function payloadTooLarge(message: string, options?: AppErrorOptions): AppError {
  return new AppError('payload_too_large', message, options);
}

/** 415: тип содержимого не поддерживается. */
export function unsupportedMediaType(message: string, options?: AppErrorOptions): AppError {
  return new AppError('unsupported_media_type', message, options);
}

/** 429: слишком частые обращения. */
export function rateLimited(message: string, options?: AppErrorOptions): AppError {
  return new AppError('rate_limited', message, options);
}

/** 501: возможность не настроена (нет ключа, провайдер `browser`). */
export function notConfigured(message: string, options?: AppErrorOptions): AppError {
  return new AppError('not_configured', message, options);
}

/** 503: внешний сервис недоступен (нет соединения, таймаут). */
export function upstreamUnavailable(message: string, options?: AppErrorOptions): AppError {
  return new AppError('upstream_unavailable', message, options);
}

/** 502: внешний сервис ответил ошибкой или неразбираемым результатом. */
export function upstreamError(message: string, options?: AppErrorOptions): AppError {
  return new AppError('upstream_error', message, options);
}

/** 500: внутренняя ошибка; клиенту уходит только `message`, без подробностей. */
export function internalError(message: string, options?: AppErrorOptions): AppError {
  return new AppError('internal_error', message, options);
}
