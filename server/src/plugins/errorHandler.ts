/**
 * Единый обработчик ошибок и ответ на несуществующий маршрут.
 *
 * Любой неуспешный ответ API имеет форму `{ error: { code, message, details? } }`
 * из `@lt/shared`, статус берётся из `API_ERROR_STATUS`.
 *
 * Разбор источников ошибки:
 * - `AppError` (см. `lib/httpErrors.ts`) — код и статус заданы явно;
 * - `ZodError` — 400 `validation_error` со списком проблемных полей;
 * - ошибка Fastify со `statusCode` (невалидный JSON, слишком большой файл,
 *   неподдерживаемый Content-Type) — код по статусу;
 * - всё остальное — 500 `internal_error`; наружу уходит только общая фраза,
 *   стек и исходное сообщение остаются в логе.
 *
 * Регистрируется функцией, а не плагином: `setErrorHandler` внутри `register()`
 * действовал бы только в своём контексте инкапсуляции.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { API_ERROR_STATUS, type ApiErrorCode, type ApiErrorResponse } from '@lt/shared';

import { isAppError, toApiErrorResponse } from '../lib/httpErrors.js';
import { validationErrorFromZod } from '../lib/validate.js';

/** Текст ответа 500: подробности наружу не отдаём. */
const INTERNAL_ERROR_MESSAGE = 'Внутренняя ошибка сервера';

/**
 * Сообщения для ошибок самого Fastify (неразбираемый JSON, слишком большой файл,
 * неподдерживаемый Content-Type). Собственный текст — чтобы клиент не получал
 * английские фразы фреймворка; исходное сообщение остаётся в логе.
 */
const FRAMEWORK_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  bad_request: 'Некорректный запрос',
  not_found: 'Ресурс не найден',
  conflict: 'Конфликт состояния ресурса',
  payload_too_large: 'Запрос или файл превышает допустимый размер',
  unsupported_media_type: 'Неподдерживаемый тип содержимого',
  rate_limited: 'Слишком много запросов',
  not_configured: 'Возможность не настроена',
};

/**
 * Код ошибки по HTTP-статусу — обратное отображение `API_ERROR_STATUS`.
 * При совпадении статусов выигрывает первый код из `API_ERROR_CODES`
 * (400 → `bad_request`, а не `validation_error`).
 */
const CODE_BY_STATUS: Record<number, ApiErrorCode> = Object.entries(API_ERROR_STATUS).reduce<
  Record<number, ApiErrorCode>
>((accumulator, [code, status]) => {
  accumulator[status] ??= code as ApiErrorCode;

  return accumulator;
}, {});

/** Ответ, который получит клиент, и статус. */
interface ErrorOutcome {
  status: number;
  body: ApiErrorResponse;
}

/** Статус ошибки Fastify, если он задан. */
function statusOf(error: unknown): number | undefined {
  const status = (error as Partial<FastifyError>).statusCode;

  return typeof status === 'number' && status >= 400 && status <= 599 ? status : undefined;
}

/** Определяет ответ по ошибке. */
function toOutcome(error: unknown): ErrorOutcome {
  if (isAppError(error)) {
    return { status: error.statusCode, body: error.toResponse() };
  }

  if (error instanceof z.ZodError) {
    const appError = validationErrorFromZod(error);

    return { status: appError.statusCode, body: appError.toResponse() };
  }

  const status = statusOf(error);

  if (status !== undefined && status < 500) {
    const code = CODE_BY_STATUS[status] ?? 'bad_request';

    return {
      status,
      body: toApiErrorResponse(code, FRAMEWORK_MESSAGES[code] ?? 'Некорректный запрос'),
    };
  }

  return {
    status: API_ERROR_STATUS.internal_error,
    body: toApiErrorResponse('internal_error', INTERNAL_ERROR_MESSAGE),
  };
}

/**
 * Пишет ошибку в лог целиком, включая стек и первопричину.
 *
 * Уровень `error` — только для настоящих отказов (5xx). 501 `not_configured` —
 * это состояние конфигурации (провайдер `browser`, маршрут-заглушка), а не сбой,
 * поэтому он логируется так же, как отклонённые запросы клиента.
 */
function logError(request: FastifyRequest, error: unknown, outcome: ErrorOutcome): void {
  const payload = { err: error, status: outcome.status, code: outcome.body.error.code };
  const isFailure = outcome.status >= 500 && outcome.status !== API_ERROR_STATUS.not_configured;

  if (isFailure) {
    request.log.error(payload, `${request.method} ${request.url}: ошибка обработки запроса`);

    return;
  }

  request.log.warn(payload, `${request.method} ${request.url}: запрос отклонён`);
}

/** Обработчик ошибок: превращает исключение в конверт ошибки API. */
export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  const outcome = toOutcome(error);

  logError(request, error, outcome);

  void reply.status(outcome.status).send(outcome.body);
}

/** Ответ на обращение к несуществующему маршруту. */
export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  void reply
    .status(API_ERROR_STATUS.not_found)
    .send(toApiErrorResponse('not_found', `Маршрут ${request.method} ${request.url} не найден`));
}

/** Настройки подключения обработчиков. */
export interface RegisterErrorHandlerOptions {
  /**
   * Чем отвечать на неизвестный маршрут вместо `notFoundHandler`.
   *
   * Нужно раздаче собранного интерфейса: у одностраничного приложения адреса
   * вроде `/lessons/42` существуют только в браузере, и сервер обязан отдать
   * на них `index.html`. Обработчик ставится один раз, потому что Fastify
   * разрешает `setNotFoundHandler` только однажды на контекст.
   */
  notFound?: (request: FastifyRequest, reply: FastifyReply) => void;
}

/** Подключает обработчики к инстансу Fastify. */
export function registerErrorHandler(
  app: FastifyInstance,
  options: RegisterErrorHandlerOptions = {},
): void {
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(options.notFound ?? notFoundHandler);
}
