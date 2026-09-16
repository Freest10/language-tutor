/**
 * Обращения к ходу урока: `/api/lessons/:id/start`, `.../turns`,
 * `.../steps/:stepId/advance`, `.../exercises/:exerciseId/attempts`,
 * `.../complete` и `GET /api/lessons/:id/messages`.
 *
 * Модуль знает только про HTTP и схемы `@lt/shared`; кэш, состояния интерфейса
 * и тексты живут в `features/lessonRoom/useLessonSession.ts`.
 *
 * За стартом урока, репликой, переходом по шагам, проверкой ответа и итогом
 * стоит языковая модель: локальная 8B думает 5–20 секунд, поэтому у них таймаут
 * `LONG_TIMEOUT_MS`, а не обычные 15 секунд. Ленту реплик модель не трогает —
 * там таймаут по умолчанию.
 *
 * Отдельного эндпоинта генерации заданий в контракте нет: задания приходят
 * в `exercises[]` ответов на реплику и на переход к следующему шагу.
 */
import {
  advanceLessonStepRequestSchema,
  advanceLessonStepResponseSchema,
  completeLessonRequestSchema,
  completeLessonResponseSchema,
  createExerciseAttemptRequestSchema,
  createExerciseAttemptResponseSchema,
  lessonTurnRequestSchema,
  lessonTurnResponseSchema,
  listLessonMessagesQuerySchema,
  listLessonMessagesResponseSchema,
  MAX_PAGE_SIZE,
  startLessonRequestSchema,
  startLessonResponseSchema,
  type AdvanceLessonStepRequest,
  type AdvanceLessonStepResponse,
  type CompleteLessonRequest,
  type CompleteLessonResponse,
  type CreateExerciseAttemptRequest,
  type CreateExerciseAttemptResponse,
  type LessonMessageRole,
  type LessonTurnRequest,
  type LessonTurnResponse,
  type ListLessonMessagesResponse,
  type MessageSource,
  type StartLessonResponse,
} from '@lt/shared';

import { ApiError, api } from './client';
import { LONG_TIMEOUT_MS } from './config';

/** Путь урока (без префикса `/api` — его добавляет клиент). */
function lessonSessionPath(lessonId: string): string {
  return `/lessons/${encodeURIComponent(lessonId)}`;
}

/** Путь запуска урока. */
export function lessonStartPath(lessonId: string): string {
  return `${lessonSessionPath(lessonId)}/start`;
}

/** Путь отправки реплики ученика. */
export function lessonTurnsPath(lessonId: string): string {
  return `${lessonSessionPath(lessonId)}/turns`;
}

/** Путь перехода по шагу плана. */
export function lessonStepAdvancePath(lessonId: string, stepId: string): string {
  return `${lessonSessionPath(lessonId)}/steps/${encodeURIComponent(stepId)}/advance`;
}

/** Путь попытки выполнения задания. */
export function lessonExerciseAttemptsPath(lessonId: string, exerciseId: string): string {
  return `${lessonSessionPath(lessonId)}/exercises/${encodeURIComponent(exerciseId)}/attempts`;
}

/** Путь завершения урока. */
export function lessonCompletePath(lessonId: string): string {
  return `${lessonSessionPath(lessonId)}/complete`;
}

/** Путь ленты реплик урока. */
export function lessonMessagesPath(lessonId: string): string {
  return `${lessonSessionPath(lessonId)}/messages`;
}

/** Предел длины реплики ученика; повторяет `lessonTurnRequestSchema`. */
export const LESSON_TURN_MAX_LENGTH = 4000;

/** Предел длины ответа на задание; повторяет `createExerciseAttemptRequestSchema`. */
export const EXERCISE_ANSWER_MAX_LENGTH = 4000;

/** Предел длины заметки к уроку; повторяет `completeLessonRequestSchema`. */
export const LESSON_NOTES_MAX_LENGTH = 2000;

/** Сколько реплик читается за один запрос ленты. */
export const LESSON_MESSAGES_PAGE_SIZE = MAX_PAGE_SIZE;

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

/** Реплика ученика до проверки схемой: `source` и `durationMs` необязательны. */
export interface LessonTurnInput {
  /** Текст реплики; для голоса — расшифровка, отредактированная учеником. */
  text: string;
  /** Набрана руками или надиктована; по умолчанию `text`. */
  source?: MessageSource;
  /** Шаг, к которому относится реплика; по умолчанию — текущий шаг урока. */
  stepId?: string;
  /** Длительность надиктованной реплики, миллисекунды. */
  durationMs?: number;
}

/** Ответ на задание до проверки схемой. */
export interface ExerciseAttemptInput {
  answer: string;
  /** Набран руками или надиктован; по умолчанию `text`. */
  source?: MessageSource;
  /** Длительность надиктованного ответа, миллисекунды. */
  durationMs?: number;
}

/**
 * Проверяет тело `POST /api/lessons/:id/turns` схемой `@lt/shared`
 * и подставляет умолчания (`source: 'text'`), обрезая пробелы по краям.
 *
 * @throws ApiError если реплика пустая или длиннее предела схемы.
 */
export function parseLessonTurnRequest(input: LessonTurnInput): LessonTurnRequest {
  const result = lessonTurnRequestSchema.safeParse(input);

  if (!result.success) {
    throw clientValidationError(
      'Реплика ученика не прошла проверку схемы на клиенте',
      result.error.issues,
    );
  }

  return result.data;
}

/** Проверяет тело `POST /api/lessons/:id/steps/:stepId/advance` схемой `@lt/shared`. */
export function parseAdvanceLessonStepRequest(
  body: Partial<AdvanceLessonStepRequest> = {},
): AdvanceLessonStepRequest {
  const result = advanceLessonStepRequestSchema.safeParse(body);

  if (!result.success) {
    throw clientValidationError(
      'Переход по шагу плана не прошёл проверку схемы на клиенте',
      result.error.issues,
    );
  }

  return result.data;
}

/** Проверяет тело попытки выполнения задания схемой `@lt/shared`. */
export function parseExerciseAttemptRequest(
  input: ExerciseAttemptInput,
): CreateExerciseAttemptRequest {
  const result = createExerciseAttemptRequestSchema.safeParse(input);

  if (!result.success) {
    throw clientValidationError(
      'Ответ на задание не прошёл проверку схемы на клиенте',
      result.error.issues,
    );
  }

  return result.data;
}

/** Проверяет тело `POST /api/lessons/:id/complete` схемой `@lt/shared`. */
export function parseCompleteLessonRequest(
  body: Partial<CompleteLessonRequest> = {},
): CompleteLessonRequest {
  const result = completeLessonRequestSchema.safeParse(body);

  if (!result.success) {
    throw clientValidationError(
      'Параметры завершения урока не прошли проверку схемы на клиенте',
      result.error.issues,
    );
  }

  return result.data;
}

/**
 * `POST /api/lessons/:id/start` — урок переходит в `in_progress`.
 *
 * Параметров у запроса нет: тело пустое по контракту.
 */
export function startLesson(lessonId: string, signal?: AbortSignal): Promise<StartLessonResponse> {
  return api.post(lessonStartPath(lessonId), startLessonRequestSchema.parse({}), {
    schema: startLessonResponseSchema,
    timeoutMs: LONG_TIMEOUT_MS,
    signal,
  });
}

/** `POST /api/lessons/:id/turns` — реплика ученика и ответ тьютора. */
export function submitLessonTurn(
  lessonId: string,
  input: LessonTurnInput,
  signal?: AbortSignal,
): Promise<LessonTurnResponse> {
  return api.post(lessonTurnsPath(lessonId), parseLessonTurnRequest(input), {
    schema: lessonTurnResponseSchema,
    timeoutMs: LONG_TIMEOUT_MS,
    signal,
  });
}

/** `POST /api/lessons/:id/steps/:stepId/advance` — следующий шаг плана. */
export function advanceLessonStep(
  lessonId: string,
  stepId: string,
  body: Partial<AdvanceLessonStepRequest> = {},
  signal?: AbortSignal,
): Promise<AdvanceLessonStepResponse> {
  return api.post(lessonStepAdvancePath(lessonId, stepId), parseAdvanceLessonStepRequest(body), {
    schema: advanceLessonStepResponseSchema,
    timeoutMs: LONG_TIMEOUT_MS,
    signal,
  });
}

/** `POST /api/lessons/:id/exercises/:exerciseId/attempts` — проверка ответа. */
export function createExerciseAttempt(
  lessonId: string,
  exerciseId: string,
  input: ExerciseAttemptInput,
  signal?: AbortSignal,
): Promise<CreateExerciseAttemptResponse> {
  return api.post(
    lessonExerciseAttemptsPath(lessonId, exerciseId),
    parseExerciseAttemptRequest(input),
    {
      schema: createExerciseAttemptResponseSchema,
      timeoutMs: LONG_TIMEOUT_MS,
      signal,
    },
  );
}

/** `POST /api/lessons/:id/complete` — итог урока и пересчёт уровня. */
export function completeLesson(
  lessonId: string,
  body: Partial<CompleteLessonRequest> = {},
  signal?: AbortSignal,
): Promise<CompleteLessonResponse> {
  return api.post(lessonCompletePath(lessonId), parseCompleteLessonRequest(body), {
    schema: completeLessonResponseSchema,
    timeoutMs: LONG_TIMEOUT_MS,
    signal,
  });
}

/** Параметры ленты реплик; пустые значения в query не уходят. */
export interface ListLessonMessagesParams {
  limit?: number;
  offset?: number;
  stepId?: string;
  role?: LessonMessageRole;
  /** Порядок по времени создания; по умолчанию — от старых к новым. */
  order?: 'asc' | 'desc';
}

/**
 * `GET /api/lessons/:id/messages` — страница ленты реплик.
 *
 * Комната читает последние реплики (`order: 'desc'`) и разворачивает их сама:
 * после перезагрузки важен конец диалога, а не его начало.
 */
export function listLessonMessages(
  lessonId: string,
  params: ListLessonMessagesParams = {},
  signal?: AbortSignal,
): Promise<ListLessonMessagesResponse> {
  const query = listLessonMessagesQuerySchema.parse(params);

  return api.get(lessonMessagesPath(lessonId), {
    query: {
      limit: query.limit,
      offset: query.offset,
      stepId: query.stepId,
      role: query.role,
      order: query.order,
    },
    schema: listLessonMessagesResponseSchema,
    signal,
  });
}
