/**
 * Обращения к ходу урока: тела запросов, пути и разбор отказов.
 *
 * Модуль `api/lessonSession` — граница между комнатой урока и HTTP, поэтому
 * проверяется он сам по себе, без интерфейса: тела до отправки, адреса запросов
 * и превращение любого отказа в `ApiError`. Сеть подменена мок-`fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_PREFIX,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ApiErrorResponse,
  type CompleteLessonResponse,
  type CreateExerciseAttemptResponse,
  type Exercise,
  type ExerciseAttempt,
  type Lesson,
  type LessonMessage,
  type LessonSummary,
  type LessonTurnResponse,
  type ListLessonMessagesResponse,
  type StartLessonResponse,
} from '@lt/shared';

import { ApiError, isApiError } from '../src/api/client';
import {
  advanceLessonStep,
  completeLesson,
  createExerciseAttempt,
  EXERCISE_ANSWER_MAX_LENGTH,
  LESSON_MESSAGES_PAGE_SIZE,
  LESSON_NOTES_MAX_LENGTH,
  LESSON_TURN_MAX_LENGTH,
  lessonCompletePath,
  lessonExerciseAttemptsPath,
  lessonMessagesPath,
  lessonStartPath,
  lessonStepAdvancePath,
  lessonTurnsPath,
  listLessonMessages,
  parseAdvanceLessonStepRequest,
  parseCompleteLessonRequest,
  parseExerciseAttemptRequest,
  parseLessonTurnRequest,
  startLesson,
  submitLessonTurn,
} from '../src/api/lessonSession';

/** Запрос, дошедший до подменённого `fetch`. */
interface FetchRecord {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
  /** Путь запроса без query-параметров. */
  path: string;
  /** Query-параметры запроса. */
  query: URLSearchParams;
}

/** Все запросы текущего теста в порядке отправки. */
let calls: FetchRecord[] = [];

/** Ответ с телом-JSON. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Конверт ошибки сервера. */
function errorResponse(
  code: ApiErrorResponse['error']['code'],
  status: number,
  details?: unknown,
): Response {
  return jsonResponse({ error: { code, message: `HTTP ${status}`, details } }, status);
}

/** Подменяет `fetch` обработчиком, который отвечает по адресу и методу запроса. */
function stubFetch(handler: (record: FetchRecord) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const record: FetchRecord = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body,
        path: url.pathname,
        query: url.searchParams,
      };

      calls.push(record);

      return Promise.resolve(handler(record));
    }),
  );
}

/** Тело последнего запроса, разобранное как JSON. */
function lastBody<T>(): T {
  const body = calls.at(-1)?.body;

  if (typeof body !== 'string') {
    throw new Error('У последнего запроса нет тела-JSON');
  }

  return JSON.parse(body) as T;
}

/** Отказ вызова: и синхронный (проверка тела), и отложенный (ответ сервера). */
async function captureError(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }

  throw new Error('Вызов завершился успешно, хотя ожидался отказ');
}

/** Отказ вызова, приведённый к `ApiError`. */
async function captureApiError(run: () => unknown): Promise<ApiError> {
  const error = await captureError(run);

  if (!isApiError(error)) {
    throw new Error(`Ожидался ApiError, получено: ${String(error)}`);
  }

  return error;
}

/** Строка заданной длины: короче предела схемы или длиннее него. */
function text(length: number): string {
  return 'a'.repeat(length);
}

/** Урок с заполненными по умолчанию полями схемы. */
function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    id: 'l-1',
    title: 'Weekend stories',
    status: 'in_progress',
    learningLanguage: 'en',
    explanationLanguage: 'ru',
    level: 'B1',
    topic: 'Weekend',
    goals: ['travel'],
    materialIds: [],
    plan: [],
    currentStepId: null,
    plannedMinutes: 30,
    summary: null,
    startedAt: '2026-09-01T10:00:00.000Z',
    completedAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

/** Реплика диалога с заполненными по умолчанию полями схемы. */
function message(
  overrides: Partial<LessonMessage> & Pick<LessonMessage, 'id' | 'role' | 'content'>,
): LessonMessage {
  return {
    lessonId: 'l-1',
    stepId: 's-1',
    source: 'text',
    language: 'en',
    corrections: [],
    audioPath: null,
    durationMs: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

/** Задание с заполненными по умолчанию полями схемы. */
function exercise(overrides: Partial<Exercise> = {}): Exercise {
  return {
    id: 'e-1',
    lessonId: 'l-1',
    stepId: 's-1',
    order: 0,
    type: 'translate',
    prompt: 'Вчера я ходил в школу.',
    instructions: 'Translate the sentence into English.',
    options: [],
    expectedAnswer: 'I went to school yesterday',
    acceptableAnswers: [],
    hints: [],
    targetItems: ['past simple'],
    level: 'B1',
    createdAt: '2026-09-01T10:05:00.000Z',
    ...overrides,
  };
}

/** Попытка выполнения задания с заполненными по умолчанию полями схемы. */
function attempt(overrides: Partial<ExerciseAttempt> = {}): ExerciseAttempt {
  return {
    id: 'a-1',
    exerciseId: 'e-1',
    lessonId: 'l-1',
    stepId: 's-1',
    answer: 'I went to school yesterday',
    source: 'text',
    isCorrect: true,
    score: 1,
    corrections: [],
    feedback: 'Точно так.',
    durationMs: null,
    createdAt: '2026-09-01T10:06:00.000Z',
    ...overrides,
  };
}

/** Итог урока с заполненными по умолчанию полями схемы. */
function summary(overrides: Partial<LessonSummary> = {}): LessonSummary {
  return {
    text: 'Good work with the past simple.',
    strengths: [],
    weaknesses: [],
    recommendations: [],
    newVocabulary: [],
    exercisesTotal: 4,
    exercisesCorrect: 3,
    accuracy: 0.75,
    durationMinutes: 21,
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('пути хода урока', () => {
  it('собирает адреса всех обращений и экранирует идентификаторы', () => {
    expect(lessonStartPath('l-1')).toBe('/lessons/l-1/start');
    expect(lessonTurnsPath('l-1')).toBe('/lessons/l-1/turns');
    expect(lessonCompletePath('l-1')).toBe('/lessons/l-1/complete');
    expect(lessonMessagesPath('l-1')).toBe('/lessons/l-1/messages');
    expect(lessonStepAdvancePath('l-1', 's-2')).toBe('/lessons/l-1/steps/s-2/advance');
    expect(lessonExerciseAttemptsPath('l-1', 'e-1')).toBe('/lessons/l-1/exercises/e-1/attempts');

    // Идентификатор из адресной строки может содержать что угодно: путь не должен разъезжаться.
    expect(lessonStartPath('l 1/x')).toBe('/lessons/l%201%2Fx/start');
    expect(lessonStepAdvancePath('l/1', 's 2')).toBe('/lessons/l%2F1/steps/s%202/advance');
    expect(lessonExerciseAttemptsPath('l/1', 'e 2')).toBe(
      '/lessons/l%2F1/exercises/e%202/attempts',
    );
  });
});

describe('тела запросов до отправки', () => {
  it('реплика ученика обрезается по краям и получает умолчания', () => {
    expect(parseLessonTurnRequest({ text: '  We went to the lake  ' })).toEqual({
      text: 'We went to the lake',
      source: 'text',
    });

    expect(
      parseLessonTurnRequest({
        text: 'We went to the lake',
        source: 'voice',
        stepId: 's-1',
        durationMs: 2400,
      }),
    ).toEqual({
      text: 'We went to the lake',
      source: 'voice',
      stepId: 's-1',
      durationMs: 2400,
    });
  });

  it('пустая реплика отвергается на клиенте', async () => {
    const error = await captureApiError(() => parseLessonTurnRequest({ text: '   ' }));

    expect(error.code).toBe('validation_error');
    expect(error.isValidationError).toBe(true);
    // Ответа не было: отказ придумал клиент.
    expect(error.status).toBe(0);
    expect(error.details).toMatchObject({ reason: 'client_validation' });
  });

  it('слишком длинная реплика не уходит на сервер', async () => {
    stubFetch(() => jsonResponse({}));

    const error = await captureApiError(() =>
      submitLessonTurn('l-1', { text: text(LESSON_TURN_MAX_LENGTH + 1) }),
    );

    expect(error.code).toBe('validation_error');
    expect(calls).toHaveLength(0);
  });

  it('реплика длиной ровно в предел схемы уходит на сервер', () => {
    expect(parseLessonTurnRequest({ text: text(LESSON_TURN_MAX_LENGTH) }).text).toHaveLength(
      LESSON_TURN_MAX_LENGTH,
    );
  });

  it('переход по шагу по умолчанию закрывает шаг', () => {
    expect(parseAdvanceLessonStepRequest()).toEqual({ status: 'completed' });
    expect(parseAdvanceLessonStepRequest({ status: 'skipped' })).toEqual({ status: 'skipped' });
  });

  it('неизвестный исход шага отвергается на клиенте', async () => {
    const error = await captureApiError(() =>
      parseAdvanceLessonStepRequest({ status: 'done' } as never),
    );

    expect(error.code).toBe('validation_error');
    expect(error.status).toBe(0);
  });

  it('ответ на задание обрезается по краям и получает умолчания', () => {
    expect(parseExerciseAttemptRequest({ answer: '  I went  ' })).toEqual({
      answer: 'I went',
      source: 'text',
    });
    expect(
      parseExerciseAttemptRequest({ answer: 'I went', source: 'voice', durationMs: 900 }),
    ).toEqual({ answer: 'I went', source: 'voice', durationMs: 900 });
  });

  it('пустой и слишком длинный ответ на задание отвергаются на клиенте', async () => {
    const empty = await captureApiError(() => parseExerciseAttemptRequest({ answer: ' \n ' }));
    const long = await captureApiError(() =>
      parseExerciseAttemptRequest({ answer: text(EXERCISE_ANSWER_MAX_LENGTH + 1) }),
    );

    expect(empty.code).toBe('validation_error');
    expect(long.code).toBe('validation_error');
  });

  it('отрицательная длительность записи отвергается на клиенте', async () => {
    const error = await captureApiError(() =>
      parseExerciseAttemptRequest({ answer: 'I went', durationMs: -1 }),
    );

    expect(error.code).toBe('validation_error');
  });

  it('завершение урока допускает пустое тело и заметку', () => {
    expect(parseCompleteLessonRequest()).toEqual({});
    expect(parseCompleteLessonRequest({ notes: '  Было тяжело  ', durationMinutes: 25 })).toEqual({
      notes: 'Было тяжело',
      durationMinutes: 25,
    });
  });

  it('слишком длинная заметка к уроку отвергается на клиенте', async () => {
    const error = await captureApiError(() =>
      parseCompleteLessonRequest({ notes: text(LESSON_NOTES_MAX_LENGTH + 1) }),
    );

    expect(error.code).toBe('validation_error');
    expect(error.details).toMatchObject({ reason: 'client_validation' });
  });
});

describe('обращения к серверу', () => {
  it('запускает урок пустым телом и разбирает ответ', async () => {
    const started: StartLessonResponse = {
      lesson: lesson({ status: 'in_progress', currentStepId: null }),
      messages: [message({ id: 'm-1', role: 'tutor', content: 'Hi! How was your weekend?' })],
      currentStep: null,
    };

    stubFetch(() => jsonResponse(started));

    const response = await startLesson('l-1');

    expect(response.messages[0]?.content).toBe('Hi! How was your weekend?');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe(`${API_PREFIX}/lessons/l-1/start`);
    expect(lastBody()).toEqual({});
  });

  it('отправляет реплику ученика по адресу хода урока', async () => {
    const turn: LessonTurnResponse = {
      userMessage: message({ id: 'm-2', role: 'user', content: 'We went to the lake' }),
      tutorMessage: message({ id: 'm-3', role: 'tutor', content: 'Sounds nice!' }),
      corrections: [],
      lesson: lesson(),
      currentStep: null,
      exercises: [],
    };

    stubFetch(() => jsonResponse(turn));

    const response = await submitLessonTurn('l-1', {
      text: '  We went to the lake ',
      source: 'voice',
      durationMs: 2400,
    });

    expect(response.tutorMessage.content).toBe('Sounds nice!');
    expect(calls[0]?.path).toBe(`${API_PREFIX}/lessons/l-1/turns`);
    expect(lastBody()).toEqual({
      text: 'We went to the lake',
      source: 'voice',
      durationMs: 2400,
    });
  });

  it('закрывает шаг плана по адресу шага', async () => {
    stubFetch(() =>
      jsonResponse({ lesson: lesson(), currentStep: null, messages: [], exercises: [] }),
    );

    await advanceLessonStep('l-1', 's-2', { status: 'skipped' });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe(`${API_PREFIX}/lessons/l-1/steps/s-2/advance`);
    expect(lastBody()).toEqual({ status: 'skipped' });
  });

  it('отправляет ответ на задание по адресу задания', async () => {
    const checked: CreateExerciseAttemptResponse = {
      attempt: attempt(),
      exercise: exercise(),
      lesson: lesson(),
      nextExercise: null,
      messages: [],
    };

    stubFetch(() => jsonResponse(checked, 201));

    const response = await createExerciseAttempt('l-1', 'e-1', {
      answer: 'I went to school yesterday',
    });

    expect(response.attempt.isCorrect).toBe(true);
    expect(calls[0]?.path).toBe(`${API_PREFIX}/lessons/l-1/exercises/e-1/attempts`);
    expect(lastBody()).toEqual({ answer: 'I went to school yesterday', source: 'text' });
  });

  it('завершает урок и разбирает итог вместе с изменением уровня', async () => {
    const completed: CompleteLessonResponse = {
      lesson: lesson({ status: 'completed', completedAt: '2026-09-01T11:00:00.000Z' }),
      summary: summary(),
      levelChange: null,
      vocabularyAdded: [],
      errorsLogged: [],
    };

    stubFetch(() => jsonResponse(completed));

    const response = await completeLesson('l-1');

    expect(response.summary.accuracy).toBe(0.75);
    expect(calls[0]?.path).toBe(`${API_PREFIX}/lessons/l-1/complete`);
    expect(lastBody()).toEqual({});
  });

  it('читает ленту реплик с умолчаниями пагинации', async () => {
    const page: ListLessonMessagesResponse = {
      items: [message({ id: 'm-1', role: 'tutor', content: 'Hi!' })],
      total: 1,
      limit: DEFAULT_PAGE_SIZE,
      offset: 0,
      hasMore: false,
    };

    stubFetch(() => jsonResponse(page));

    const response = await listLessonMessages('l-1');

    expect(response.items).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe(`${API_PREFIX}/lessons/l-1/messages`);
    expect(calls[0]?.query.get('limit')).toBe(String(DEFAULT_PAGE_SIZE));
    expect(calls[0]?.query.get('offset')).toBe('0');
    expect(calls[0]?.query.get('order')).toBe('asc');
    // Пустые фильтры в query не уходят.
    expect(calls[0]?.query.has('stepId')).toBe(false);
    expect(calls[0]?.query.has('role')).toBe(false);
  });

  it('читает хвост ленты страницей комнаты урока', async () => {
    stubFetch(() =>
      jsonResponse({ items: [], total: 0, limit: MAX_PAGE_SIZE, offset: 0, hasMore: true }),
    );

    await listLessonMessages('l-1', {
      limit: LESSON_MESSAGES_PAGE_SIZE,
      order: 'desc',
      role: 'tutor',
      stepId: 's-1',
    });

    expect(LESSON_MESSAGES_PAGE_SIZE).toBe(MAX_PAGE_SIZE);
    expect(calls[0]?.query.get('limit')).toBe(String(MAX_PAGE_SIZE));
    expect(calls[0]?.query.get('order')).toBe('desc');
    expect(calls[0]?.query.get('role')).toBe('tutor');
    expect(calls[0]?.query.get('stepId')).toBe('s-1');
  });
});

describe('отказы сервера', () => {
  it('разбирает конверт ошибки в ApiError с кодом и диагностикой', async () => {
    stubFetch(() => errorResponse('conflict', 409, { reason: 'lesson_already_completed' }));

    const error = await captureApiError(() => submitLessonTurn('l-1', { text: 'Hello' }));

    expect(error.code).toBe('conflict');
    expect(error.status).toBe(409);
    expect(error.details).toMatchObject({ reason: 'lesson_already_completed' });
  });

  it('отказ модели приходит кодом upstream_error', async () => {
    stubFetch(() => errorResponse('upstream_error', 502));

    const error = await captureApiError(() => completeLesson('l-1'));

    expect(error.code).toBe('upstream_error');
    expect(error.status).toBe(502);
  });

  it('ошибка без конверта разбирается по HTTP-статусу', async () => {
    stubFetch(
      () =>
        new Response('<html>502 Bad Gateway</html>', { status: 502, headers: {} as HeadersInit }),
    );

    const error = await captureApiError(() => startLesson('l-1'));

    expect(error.code).toBe('upstream_error');
    expect(error.status).toBe(502);
    expect(error.details).toMatchObject({ reason: 'unparsed_error_body' });
  });

  it('ответ не по схеме отбраковывается клиентом', async () => {
    // Урок без обязательных полей: такому ответу доверять нельзя.
    stubFetch(() => jsonResponse({ lesson: { id: 'l-1' }, messages: [] }));

    const error = await captureApiError(() => startLesson('l-1'));

    expect(error.isInvalidResponse).toBe(true);
    expect(error.code).toBe('internal_error');
    expect(error.details).toMatchObject({ reason: 'schema_mismatch' });
  });

  it('обрыв связи превращается в ApiError без статуса', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    const error = await captureApiError(() => createExerciseAttempt('l-1', 'e-1', { answer: 'I' }));

    expect(error.isNetworkError).toBe(true);
    expect(error.code).toBe('upstream_unavailable');
    expect(error.status).toBe(0);
  });
});
