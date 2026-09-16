/**
 * Обращения к `/api/lessons`: список уроков, создание урока с планом, просмотр
 * урока и пересборка плана.
 *
 * Модуль знает только про HTTP и схемы `@lt/shared`; кэш, состояния интерфейса
 * и тексты живут в `features/lessons/useLessons.ts`.
 *
 * За созданием урока и пересборкой плана стоит языковая модель: локальная 8B
 * думает десятки секунд, поэтому у них таймаут `LONG_TIMEOUT_MS`, а не обычные
 * 15 секунд. Список и просмотр урока модель не трогают — там таймаут по умолчанию.
 *
 * Здесь же лежит чтение списка материалов для выбора их в урок: раздел материалов —
 * соседний пакет, и брать его модуль `api/materials.ts` в зависимости нельзя,
 * поэтому запрос описан своим вызовом против тех же схем `@lt/shared`.
 */
import {
  createLessonRequestSchema,
  createLessonResponseSchema,
  getLessonResponseSchema,
  listLessonsResponseSchema,
  listMaterialsResponseSchema,
  MATERIAL_STATUSES,
  regenerateLessonPlanRequestSchema,
  regenerateLessonPlanResponseSchema,
  type CreateLessonRequest,
  type GetLessonResponse,
  type LanguageCode,
  type Lesson,
  type LessonStatus,
  type ListLessonsResponse,
  type ListMaterialsResponse,
  type MaterialStatus,
  type RegenerateLessonPlanRequest,
} from '@lt/shared';

import { ApiError, api, isApiError } from './client';
import { LONG_TIMEOUT_MS } from './config';

/** Путь коллекции уроков (без префикса `/api` — его добавляет клиент). */
export const LESSONS_PATH = '/lessons';

/** Путь коллекции материалов: нужен для выбора материалов в урок. */
export const LESSON_MATERIALS_PATH = '/materials';

/** Путь конкретного урока. */
export function lessonPath(lessonId: string): string {
  return `${LESSONS_PATH}/${encodeURIComponent(lessonId)}`;
}

/** Путь пересборки плана урока. */
export function lessonPlanRegeneratePath(lessonId: string): string {
  return `${lessonPath(lessonId)}/plan/regenerate`;
}

/** Предел длины пожелания к новому плану; повторяет `regenerateLessonPlanRequestSchema`. */
export const LESSON_FEEDBACK_MAX_LENGTH = 1000;

/** Предел длины темы урока; повторяет `createLessonRequestSchema`. */
export const LESSON_TOPIC_MAX_LENGTH = 200;

/**
 * Материал, из-за которого сервер отказался планировать урок.
 *
 * Сервер отвечает 400 `bad_request` с `details.reason = 'materials_not_ready'`
 * и перечнем материалов: урок при этом не создаётся. Показать перечень —
 * единственный способ объяснить, почему загруженный скан PDF не годится.
 */
export interface NotReadyMaterial {
  id: string;
  /** Название материала; `null`, если сервер его не прислал. */
  title: string | null;
  /** Статус обработки; `null`, если сервер прислал незнакомое значение. */
  status: MaterialStatus | null;
  /** Пояснение сервера к статусу. */
  statusMessage: string | null;
  /** Сколько фрагментов извлечено: `0` — читать в материале нечего. */
  chunkCount: number | null;
}

/** Поле `details` отказа как объект; `null` — диагностики нет. */
function errorDetails(error: unknown): Record<string, unknown> | null {
  if (!isApiError(error) || typeof error.details !== 'object' || error.details === null) {
    return null;
  }

  return error.details as Record<string, unknown>;
}

/** Машиночитаемая причина отказа из `details.reason`; `null` — её не прислали. */
export function lessonErrorReason(error: unknown): string | null {
  const reason = errorDetails(error)?.reason;

  return typeof reason === 'string' && reason.length > 0 ? reason : null;
}

/**
 * Материалы из отказа 400 `materials_not_ready`.
 *
 * @returns перечень проблемных материалов; пустой массив — отказ был про другое.
 */
export function notReadyMaterials(error: unknown): NotReadyMaterial[] {
  const details = errorDetails(error);

  if (!details || details.reason !== 'materials_not_ready' || !Array.isArray(details.materials)) {
    return [];
  }

  return details.materials
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : '',
      title: typeof item.title === 'string' && item.title.length > 0 ? item.title : null,
      status: MATERIAL_STATUSES.includes(item.status as MaterialStatus)
        ? (item.status as MaterialStatus)
        : null,
      statusMessage:
        typeof item.statusMessage === 'string' && item.statusMessage.length > 0
          ? item.statusMessage
          : null,
      chunkCount: typeof item.chunkCount === 'number' ? item.chunkCount : null,
    }))
    .filter((item) => item.id.length > 0);
}

/**
 * Отказ клиентской проверки: тело до сервера не дошло.
 *
 * Оформлен как `ApiError` с кодом `validation_error` и `status: 0` — интерфейсу
 * не нужно различать, кто отверг данные, клиент или сервер.
 */
function clientValidationError(message: string, issues: unknown): ApiError {
  return new ApiError({
    code: 'validation_error',
    message,
    status: 0,
    details: { reason: 'client_validation', issues },
  });
}

/**
 * Проверяет тело `POST /api/lessons` схемой `@lt/shared`.
 *
 * @throws ApiError если параметры урока не соответствуют контракту.
 */
export function parseCreateLessonRequest(body: CreateLessonRequest = {}): CreateLessonRequest {
  const result = createLessonRequestSchema.safeParse(body);

  if (!result.success) {
    throw clientValidationError(
      'Параметры нового урока не прошли проверку схемы на клиенте',
      result.error.issues,
    );
  }

  return result.data;
}

/** Проверяет тело `POST /api/lessons/:id/plan/regenerate` схемой `@lt/shared`. */
export function parseRegenerateLessonPlanRequest(
  body: Partial<RegenerateLessonPlanRequest> = {},
): RegenerateLessonPlanRequest {
  const result = regenerateLessonPlanRequestSchema.safeParse(body);

  if (!result.success) {
    throw clientValidationError(
      'Пожелание к новому плану не прошло проверку схемы на клиенте',
      result.error.issues,
    );
  }

  return result.data;
}

/** Параметры списка уроков; пустые значения в query не уходят. */
export interface ListLessonsParams {
  limit?: number;
  offset?: number;
  status?: LessonStatus;
  language?: LanguageCode;
  search?: string;
}

/** `GET /api/lessons` — страница списка уроков, от новых к старым. */
export function listLessons(
  params: ListLessonsParams = {},
  signal?: AbortSignal,
): Promise<ListLessonsResponse> {
  return api.get(LESSONS_PATH, {
    query: {
      limit: params.limit,
      offset: params.offset,
      status: params.status,
      language: params.language,
      search: params.search,
    },
    schema: listLessonsResponseSchema,
    signal,
  });
}

/** `GET /api/lessons/:id` — урок вместе с заданиями и попытками. */
export function getLesson(lessonId: string, signal?: AbortSignal): Promise<GetLessonResponse> {
  return api.get(lessonPath(lessonId), {
    schema: getLessonResponseSchema,
    signal,
  });
}

/**
 * `POST /api/lessons` — новый урок со сгенерированным планом (201).
 *
 * Пустое тело допустимо: уровень, цели и длительность сервер берёт из профиля.
 * Необработанный материал в `materialIds` — отказ 400 `materials_not_ready`,
 * урок при этом не создаётся (см. `notReadyMaterials`).
 */
export function createLesson(
  body: CreateLessonRequest = {},
  signal?: AbortSignal,
): Promise<Lesson> {
  return api.post(LESSONS_PATH, parseCreateLessonRequest(body), {
    schema: createLessonResponseSchema,
    timeoutMs: LONG_TIMEOUT_MS,
    signal,
  });
}

/**
 * `POST /api/lessons/:id/plan/regenerate` — план, пересобранный с учётом пожелания.
 *
 * Завершённый урок пересобрать нельзя: сервер отвечает 409 `conflict`
 * с `details.reason = 'lesson_completed'` или `'lesson_plan_full'`.
 */
export function regenerateLessonPlan(
  lessonId: string,
  body: Partial<RegenerateLessonPlanRequest> = {},
  signal?: AbortSignal,
): Promise<Lesson> {
  return api.post(lessonPlanRegeneratePath(lessonId), parseRegenerateLessonPlanRequest(body), {
    schema: regenerateLessonPlanResponseSchema,
    timeoutMs: LONG_TIMEOUT_MS,
    signal,
  });
}

/** Параметры списка материалов для выбора их в урок. */
export interface ListLessonMaterialsParams {
  limit?: number;
  offset?: number;
  status?: MaterialStatus;
  search?: string;
}

/** `GET /api/materials` — материалы, из которых выбирают основу урока. */
export function listLessonMaterials(
  params: ListLessonMaterialsParams = {},
  signal?: AbortSignal,
): Promise<ListMaterialsResponse> {
  return api.get(LESSON_MATERIALS_PATH, {
    query: {
      limit: params.limit,
      offset: params.offset,
      status: params.status,
      search: params.search,
    },
    schema: listMaterialsResponseSchema,
    signal,
  });
}
