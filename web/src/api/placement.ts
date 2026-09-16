/**
 * Обращения к `/api/placement/*`: создание сессии, ответ на вопрос, завершение
 * и восстановление незаконченного теста.
 *
 * Модуль — единственное место, где мастер определения уровня знает про HTTP:
 * схемы `@lt/shared` проверяют и тело запроса перед отправкой, и ответ сервера,
 * поэтому в интерфейс не попадут данные, не соответствующие контракту.
 *
 * За созданием сессии, ответом на вопрос и завершением стоит языковая модель:
 * локальная 8B отвечает 5–20 секунд, поэтому у них таймаут `LONG_TIMEOUT_MS`,
 * а не обычные 15 секунд. Восстановление сессии модель не трогает — там
 * таймаут по умолчанию.
 *
 * Отдельного DTO у `GET /api/placement/sessions/:id` в контракте нет: сервер
 * переиспользует `createPlacementSessionResponseSchema` — `{ session, nextTurn? }`,
 * где `session.turns` содержит уже заданные вопросы, а `nextTurn` — тот,
 * на который ещё ждут ответа.
 */
import {
  createPlacementSessionRequestSchema,
  createPlacementSessionResponseSchema,
  finishPlacementSessionRequestSchema,
  finishPlacementSessionResponseSchema,
  submitPlacementTurnRequestSchema,
  submitPlacementTurnResponseSchema,
  type CreatePlacementSessionRequest,
  type CreatePlacementSessionResponse,
  type FinishPlacementSessionRequest,
  type FinishPlacementSessionResponse,
  type MessageSource,
  type SubmitPlacementTurnRequest,
  type SubmitPlacementTurnResponse,
} from '@lt/shared';

import { api, clientValidationError } from './client';
import { LONG_TIMEOUT_MS } from './config';

/** Путь коллекции сессий (без префикса `/api` — его добавляет клиент). */
export const PLACEMENT_SESSIONS_PATH = '/placement/sessions';

/** Путь конкретной сессии определения уровня. */
export function placementSessionPath(sessionId: string): string {
  return `${PLACEMENT_SESSIONS_PATH}/${encodeURIComponent(sessionId)}`;
}

/** Путь отправки ответа на вопрос сессии. */
export function placementTurnsPath(sessionId: string): string {
  return `${placementSessionPath(sessionId)}/turns`;
}

/** Путь завершения сессии и получения итогового уровня. */
export function placementFinishPath(sessionId: string): string {
  return `${placementSessionPath(sessionId)}/finish`;
}

/** Предел длины ответа ученика; повторяет `submitPlacementTurnRequestSchema`. */
export const PLACEMENT_ANSWER_MAX_LENGTH = 4000;

/** Ответ ученика до проверки схемой: `source` и `durationMs` необязательны. */
export interface PlacementAnswerInput {
  /** Вопрос, на который отвечают. */
  turnId: string;
  /** Текст ответа; пустой ответ схема не пропустит. */
  answer: string;
  /** Откуда взялся текст: набран руками или распознан из речи. */
  source?: MessageSource;
  /** Сколько времени ушло на ответ, миллисекунды. */
  durationMs?: number;
}

/**
 * Проверяет тело `POST /api/placement/sessions` схемой `@lt/shared`.
 *
 * @throws ApiError если параметры сессии не соответствуют контракту.
 */
export function parsePlacementSessionRequest(
  body: CreatePlacementSessionRequest = {},
): CreatePlacementSessionRequest {
  const result = createPlacementSessionRequestSchema.safeParse(body);

  if (!result.success) {
    throw clientValidationError(
      'Параметры сессии определения уровня не прошли проверку схемы на клиенте',
      result.error.issues,
    );
  }

  return result.data;
}

/**
 * Проверяет ответ ученика схемой `@lt/shared` и подставляет умолчания
 * (`source: 'text'`), обрезая пробелы по краям.
 *
 * @throws ApiError если ответ пустой или длиннее предела схемы.
 */
export function parsePlacementAnswer(input: PlacementAnswerInput): SubmitPlacementTurnRequest {
  const result = submitPlacementTurnRequestSchema.safeParse(input);

  if (!result.success) {
    throw clientValidationError(
      'Ответ на вопрос определения уровня не прошёл проверку схемы на клиенте',
      result.error.issues,
    );
  }

  return result.data;
}

/** Проверяет тело `POST /api/placement/sessions/:id/finish` схемой `@lt/shared`. */
export function parsePlacementFinishRequest(
  body: Partial<FinishPlacementSessionRequest> = {},
): FinishPlacementSessionRequest {
  const result = finishPlacementSessionRequestSchema.safeParse(body);

  if (!result.success) {
    throw clientValidationError(
      'Параметры завершения сессии не прошли проверку схемы на клиенте',
      result.error.issues,
    );
  }

  return result.data;
}

/**
 * `POST /api/placement/sessions` — новая сессия и первый вопрос.
 *
 * Пустое тело допустимо: язык изучения, язык объяснений и число вопросов
 * сервер берёт из профиля.
 */
export function createPlacementSession(
  body: CreatePlacementSessionRequest = {},
  signal?: AbortSignal,
): Promise<CreatePlacementSessionResponse> {
  return api.post(PLACEMENT_SESSIONS_PATH, parsePlacementSessionRequest(body), {
    schema: createPlacementSessionResponseSchema,
    timeoutMs: LONG_TIMEOUT_MS,
    signal,
  });
}

/**
 * `GET /api/placement/sessions/:id` — восстановление начатого теста.
 *
 * Ответ той же формы, что у создания сессии: история ходов лежит
 * в `session.turns`, незаданный вопрос — в `nextTurn`.
 */
export function getPlacementSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<CreatePlacementSessionResponse> {
  return api.get(placementSessionPath(sessionId), {
    schema: createPlacementSessionResponseSchema,
    signal,
  });
}

/** `POST /api/placement/sessions/:id/turns` — ответ на вопрос и следующий вопрос. */
export function submitPlacementTurn(
  sessionId: string,
  input: PlacementAnswerInput,
  signal?: AbortSignal,
): Promise<SubmitPlacementTurnResponse> {
  return api.post(placementTurnsPath(sessionId), parsePlacementAnswer(input), {
    schema: submitPlacementTurnResponseSchema,
    timeoutMs: LONG_TIMEOUT_MS,
    signal,
  });
}

/**
 * `POST /api/placement/sessions/:id/finish` — итоговый уровень.
 *
 * `applyToProfile: true` записывает уровень в профиль и в историю уровня;
 * обновлённый профиль приходит в ответе.
 */
export function finishPlacementSession(
  sessionId: string,
  body: Partial<FinishPlacementSessionRequest> = {},
  signal?: AbortSignal,
): Promise<FinishPlacementSessionResponse> {
  return api.post(placementFinishPath(sessionId), parsePlacementFinishRequest(body), {
    schema: finishPlacementSessionResponseSchema,
    timeoutMs: LONG_TIMEOUT_MS,
    signal,
  });
}
