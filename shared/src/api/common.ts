/**
 * Базовые примитивы HTTP-слоя: идентификаторы, даты, конверт ошибки, пагинация.
 *
 * Модуль намеренно не зависит от других модулей пакета (кроме `constants.ts`),
 * поэтому его импортируют и доменные модули (`idSchema`, `isoDateTimeSchema`),
 * и остальные модули `api/`.
 *
 * Соглашения пакета:
 * - схема сущности описывает то, что сервер отдаёт клиенту (`*Schema`),
 *   схема запроса — то, что клиент присылает (`*RequestSchema`);
 * - необязательные скалярные поля сущностей объявлены через `.nullish()`
 *   (`T | null | undefined`), чтобы значения `NULL` из БД проходили без маппинга;
 * - коллекции объявлены через `.default([])`: ключ можно не присылать,
 *   в разобранном объекте массив всегда есть;
 * - у эндпоинтов, где тело необязательно, все поля запроса опциональны;
 *   обработчику следует разбирать `request.body ?? {}`;
 * - неизвестные ключи объектов отбрасываются (поведение `z.object` по умолчанию).
 */
import { z } from 'zod';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants.js';

/**
 * Идентификатор сущности. Сервер генерирует UUID v4 (`crypto.randomUUID()`),
 * схема намеренно допускает любую непустую строку до 64 символов.
 */
export const idSchema = z.string().trim().min(1).max(64);

/** Идентификатор сущности. */
export type Id = z.infer<typeof idSchema>;

/** Параметры маршрута вида `/:id`. */
export const idParamSchema = z.object({ id: idSchema });

/** Параметры маршрута вида `/:id`. */
export type IdParam = z.infer<typeof idParamSchema>;

/** Момент времени в ISO-8601 с зоной: `2026-09-15T10:20:30.000Z`. */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/** Календарная дата в формате `YYYY-MM-DD`. */
export const isoDateSchema = z.iso.date();

/** Направление сортировки списочных эндпоинтов. */
export const SORT_ORDERS = ['asc', 'desc'] as const;

/** Направление сортировки списочных эндпоинтов. */
export type SortOrder = (typeof SORT_ORDERS)[number];

/** Направление сортировки списочных эндпоинтов. */
export const sortOrderSchema = z.enum(SORT_ORDERS);

/** Машиночитаемые коды ошибок API. */
export const API_ERROR_CODES = [
  'bad_request',
  'validation_error',
  'not_found',
  'conflict',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
  'not_configured',
  'upstream_unavailable',
  'upstream_error',
  'internal_error',
] as const;

/** Машиночитаемый код ошибки API. */
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Машиночитаемый код ошибки API. */
export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);

/** HTTP-статус, которым сервер отвечает на каждый код ошибки. */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  validation_error: 400,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  not_configured: 501,
  upstream_unavailable: 503,
  upstream_error: 502,
  internal_error: 500,
};

/** Тело ошибки: `message` человекочитаемо, `details` — произвольная диагностика. */
export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string().min(1),
  details: z.unknown().optional(),
});

/** Тело ошибки API. */
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Единый конверт ошибки: любой неуспешный ответ API имеет такую форму. */
export const apiErrorResponseSchema = z.object({ error: apiErrorSchema });

/** Единый конверт ошибки API. */
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/** Ответ эндпоинтов без содержательного результата (например, DELETE). */
export const okResponseSchema = z.object({ ok: z.literal(true) });

/** Ответ эндпоинтов без содержательного результата. */
export type OkResponse = z.infer<typeof okResponseSchema>;

/** Query-параметры пагинации (значения приходят строками и приводятся к числам). */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Query-параметры пагинации. */
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Страница списочного ответа. */
export interface Paginated<Item> {
  items: Item[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** Собирает схему страницы для конкретной схемы элемента. */
export function paginatedResponseSchema<ItemSchema extends z.ZodType>(item: ItemSchema) {
  return z.object({
    items: z.array(item),
    total: z.int().nonnegative(),
    limit: z.int().nonnegative(),
    offset: z.int().nonnegative(),
    hasMore: z.boolean(),
  });
}
