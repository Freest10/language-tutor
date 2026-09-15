/**
 * Проверка входных данных Zod-схемами из `@lt/shared`.
 *
 * Два способа, оба приводят к одному ответу 400 `validation_error`:
 *
 * 1. Схема в описании маршрута — `app.post('/x', { schema: { body: xRequestSchema } }, handler)`.
 *    `registerZodValidation()` ставит Zod-совместимые компиляторы, и `request.body`
 *    приходит в обработчик уже разобранным (с применёнными `default` и `coerce`).
 *    Опциональный `schema.response` тем же способом проверяет ответ при сериализации.
 * 2. Явный разбор — `const body = parseBody(request, xRequestSchema)`. Нужен там,
 *    где данные не совпадают с сырым телом: multipart-поля, слияние query и params.
 *
 * Типы `request.body`/`query`/`params` Fastify не выводит из Zod-схемы — используйте
 * результат `parseBody()`/`parseQuery()`/`parseParams()` как источник типов.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { validationError, type AppError } from './httpErrors.js';

/** Часть запроса, к которой относится схема. */
export type ValidationSource = 'body' | 'querystring' | 'params' | 'headers';

/** Человекочитаемые названия частей запроса. */
const SOURCE_LABELS: Record<ValidationSource, string> = {
  body: 'тело запроса',
  querystring: 'query-параметры',
  params: 'параметры пути',
  headers: 'заголовки запроса',
};

/** Одна проблема валидации в `details` ответа. */
export interface ValidationIssue {
  /** Путь до поля: `goals.0`, `limit`; пустая строка — корень. */
  path: string;
  /** Код проблемы из Zod: `invalid_type`, `too_small`, … */
  code: string;
  message: string;
}

/** Приводит ошибку Zod к списку проблем для `details`. */
export function formatZodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    code: issue.code,
    message: issue.message,
  }));
}

/** Превращает ошибку Zod в 400 `validation_error` с перечнем проблемных полей. */
export function validationErrorFromZod(error: z.ZodError, source?: ValidationSource): AppError {
  const label = source === undefined ? 'запрос' : SOURCE_LABELS[source];

  return validationError(`Некорректные данные: ${label}`, {
    details: { source: source ?? null, issues: formatZodIssues(error) },
    cause: error,
  });
}

/** Разбирает значение схемой; при ошибке бросает 400 `validation_error`. */
export function parseWith<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  source?: ValidationSource,
): z.output<Schema> {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw validationErrorFromZod(result.error, source);
  }

  return result.data;
}

/** Разбирает тело запроса; отсутствующее тело равнозначно пустому объекту. */
export function parseBody<Schema extends z.ZodType>(
  request: FastifyRequest,
  schema: Schema,
): z.output<Schema> {
  return parseWith(schema, request.body ?? {}, 'body');
}

/** Разбирает query-параметры запроса. */
export function parseQuery<Schema extends z.ZodType>(
  request: FastifyRequest,
  schema: Schema,
): z.output<Schema> {
  return parseWith(schema, request.query ?? {}, 'querystring');
}

/** Разбирает параметры пути. */
export function parseParams<Schema extends z.ZodType>(
  request: FastifyRequest,
  schema: Schema,
): z.output<Schema> {
  return parseWith(schema, request.params ?? {}, 'params');
}

/** Проверяет, что в описании маршрута действительно Zod-схема. */
function assertZodSchema(schema: unknown, where: string): asserts schema is z.ZodType {
  if (!(schema instanceof z.ZodType)) {
    throw new Error(
      `${where}: ожидается Zod-схема из @lt/shared. JSON Schema в этом приложении не используется.`,
    );
  }
}

/**
 * Ставит компиляторы, понимающие Zod-схемы в описаниях маршрутов.
 * Вызывается один раз из `buildApp()`.
 */
export function registerZodValidation(app: FastifyInstance): void {
  app.setValidatorCompiler(({ schema, method, url, httpPart }) => {
    assertZodSchema(schema, `${method} ${url} (${httpPart ?? 'schema'})`);

    const source = (httpPart ?? 'body') as ValidationSource;

    return (data: unknown) => {
      const result = schema.safeParse(data);

      // Fastify пропускает наш `AppError` в обработчик ошибок как есть.
      return result.success
        ? { value: result.data }
        : { error: validationErrorFromZod(result.error, source) };
    };
  });

  app.setSerializerCompiler(({ schema, method, url }) => {
    assertZodSchema(schema, `${method} ${url} (response)`);

    return (data: unknown) => JSON.stringify(schema.parse(data));
  });
}
