/**
 * Комната урока: диалог голосом и текстом, задания, восстановление и отказы.
 *
 * Сервер подменяется мок-`fetch`: бэкенд хода урока пишется параллельно,
 * поэтому тест проверяет интерфейс против контракта `@lt/shared`, а не против
 * маршрутов. Голосовой слой подменён целиком: браузерных `SpeechRecognition`
 * и `speechSynthesis` в jsdom нет, а проверять нужно не их, а то, что уходит
 * на сервер и что происходит с озвучиванием.
 */
import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_PREFIX,
  APP_NAME,
  DEFAULT_CEFR_LEVEL,
  DEFAULT_DAILY_MINUTES,
  KNOWN_LANGUAGE_CODES,
  LANGUAGE_LABELS,
  type AdvanceLessonStepResponse,
  type ApiErrorResponse,
  type AppConfig,
  type CompleteLessonResponse,
  type Correction,
  type CreateExerciseAttemptRequest,
  type CreateExerciseAttemptResponse,
  type ErrorLogEntry,
  type Exercise,
  type ExerciseAttempt,
  type GetLessonResponse,
  type Lesson,
  type LessonMessage,
  type LessonPlanStep,
  type LessonSummary,
  type LessonTurnRequest,
  type LessonTurnResponse,
  type LevelHistoryEntry,
  type StartLessonResponse,
  type VocabularyItem,
} from '@lt/shared';

import { App } from '../src/App';
import { LESSON_TURN_MAX_LENGTH } from '../src/api/lessonSession';
import { i18n } from '../src/i18n';
import { lessonRoomPath, routes } from '../src/router';

/** Подменённый голосовой ввод: расшифровка отдаётся по отпусканию кнопки. */
const voiceStub = vi.hoisted(() => {
  const state = {
    result: {
      text: 'i go to school yesterday',
      provider: 'browser' as const,
      language: 'en' as const,
      durationMs: 2400 as number | null,
    },
  };

  return {
    state,
    input: {
      status: 'idle' as const,
      available: true,
      provider: 'browser' as const,
      runsInBrowser: true,
      isListening: false,
      isProcessing: false,
      interimText: '',
      text: '',
      level: 0,
      failure: null,
      start: vi.fn(() => Promise.resolve(true)),
      stop: vi.fn(() => Promise.resolve(state.result)),
      cancel: vi.fn(),
      reset: vi.fn(),
    },
  };
});

/** Подменённое озвучивание: проверяем вызовы, а не звук. */
const ttsStub = vi.hoisted(() => ({
  status: 'idle' as const,
  isSpeaking: false,
  available: true,
  provider: 'browser' as const,
  runsInBrowser: true,
  queueLength: 0,
  rate: 1,
  failure: null,
  speak: vi.fn(() => Promise.resolve()),
  enqueue: vi.fn(() => Promise.resolve()),
  stop: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('../src/features/voice/useVoiceInput', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/features/voice/useVoiceInput')>();

  return { ...actual, useVoiceInput: () => voiceStub.input };
});

vi.mock('../src/features/voice/useTextToSpeech', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/features/voice/useTextToSpeech')>();

  return { ...actual, useTextToSpeech: () => ttsStub };
});

/** Конфигурация сервера: модель, распознавание и синтез доступны. */
const CONFIG_FIXTURE: AppConfig = {
  appName: APP_NAME,
  apiPrefix: API_PREFIX,
  version: '0.1.0',
  llm: { available: true, model: 'qwen2.5', reason: null },
  stt: { provider: 'browser', available: true, model: null, reason: null },
  tts: {
    provider: 'browser',
    available: true,
    model: null,
    voice: null,
    formats: [],
    reason: null,
  },
  supportedLanguages: KNOWN_LANGUAGE_CODES.map((code) => ({ code, ...LANGUAGE_LABELS[code] })),
  defaults: {
    learningLanguage: 'en',
    interfaceLanguage: 'en',
    explanationLanguage: 'ru',
    level: DEFAULT_CEFR_LEVEL,
    dailyMinutes: DEFAULT_DAILY_MINUTES,
  },
  limits: {
    maxMaterialUploadBytes: 10_485_760,
    maxMaterialTextLength: 200_000,
    maxAudioUploadBytes: 26_214_400,
    maxTtsTextLength: 4_000,
    maxPageSize: 100,
  },
};

/** Шаг плана с заполненными по умолчанию полями схемы. */
function step(
  overrides: Partial<LessonPlanStep> & Pick<LessonPlanStep, 'id' | 'order' | 'title'>,
): LessonPlanStep {
  return {
    lessonId: 'l-1',
    type: 'speaking',
    objectives: ['Talk about the weekend'],
    targetItems: ['went', 'visited'],
    instructions: 'Ask the learner about the last weekend.',
    estimatedMinutes: 10,
    status: 'pending',
    materialChunkIds: [],
    exerciseIds: [],
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

/** Урок с заполненными по умолчанию полями схемы. */
function lesson(overrides: Partial<Lesson> & Pick<Lesson, 'id' | 'title'>): Lesson {
  return {
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
function exercise(overrides: Partial<Exercise> & Pick<Exercise, 'id' | 'prompt'>): Exercise {
  return {
    lessonId: 'l-1',
    stepId: 's-1',
    order: 0,
    type: 'translate',
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

/** Исправление с объяснением: главная часть разбора ответа. */
const CORRECTION: Correction = {
  category: 'grammar',
  severity: 'major',
  original: 'I go to school yesterday',
  corrected: 'I went to school yesterday',
  explanation: 'Прошедшее время требует формы went, а не go.',
  targetItem: 'past simple',
};

/** Попытка выполнения задания с заполненными по умолчанию полями схемы. */
function attempt(
  overrides: Partial<ExerciseAttempt> & Pick<ExerciseAttempt, 'id' | 'exerciseId' | 'answer'>,
): ExerciseAttempt {
  return {
    lessonId: 'l-1',
    stepId: 's-1',
    source: 'text',
    isCorrect: false,
    score: 0.4,
    corrections: [CORRECTION],
    feedback: 'Почти получилось: подведёт только время глагола.',
    durationMs: null,
    createdAt: '2026-09-01T10:06:00.000Z',
    ...overrides,
  };
}

/** Страница списочного ответа. */
function listPage<Item>(items: Item[], hasMore = false) {
  return { items, total: items.length, limit: 100, offset: 0, hasMore };
}

/** Запрос, дошедший до подменённого `fetch`. */
interface FetchRecord {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
  /** Путь запроса без query-параметров. */
  path: string;
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
function errorResponse(code: ApiErrorResponse['error']['code'], status: number): Response {
  return jsonResponse(
    { error: { code, message: `HTTP ${status}` } } satisfies ApiErrorResponse,
    status,
  );
}

/** Подменяет `fetch` обработчиком, который отвечает по адресу и методу запроса. */
function stubFetch(handler: (record: FetchRecord) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const record: FetchRecord = {
        url,
        method: init?.method ?? 'GET',
        body: init?.body,
        path: new URL(url, 'http://localhost').pathname,
      };

      calls.push(record);

      return Promise.resolve(handler(record));
    }),
  );
}

/** Тело запроса, разобранное как JSON. */
function bodyOf<T>(record: FetchRecord | undefined): T {
  if (typeof record?.body !== 'string') {
    throw new Error('У запроса нет тела-JSON');
  }

  return JSON.parse(record.body) as T;
}

/** Запросы по методу и пути. */
function callsTo(method: string, path: string): FetchRecord[] {
  return calls.filter((call) => call.method === method && call.path === `${API_PREFIX}${path}`);
}

/** Запрос по методу и пути; последний, если их было несколько. */
function lastCall(method: string, path: string): FetchRecord | undefined {
  return callsTo(method, path).at(-1);
}

/** Обещание, которое тест разрешает сам: имитация долгого ответа модели. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn;
  });

  return { promise, resolve };
}

/** Поднимает приложение на нужном адресе, без истории браузера. */
function renderApp(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });

  return {
    user: userEvent.setup(),
    ...render(<App router={router} queryClient={queryClient} />),
  };
}

/** Урок, который идёт: два шага, первый — текущий. */
const RUNNING_LESSON = lesson({
  id: 'l-1',
  title: 'Weekend stories',
  currentStepId: 's-1',
  plan: [
    step({ id: 's-1', order: 0, title: 'Warm-up', type: 'warmup', status: 'in_progress' }),
    step({ id: 's-2', order: 1, title: 'Role play', type: 'speaking' }),
  ],
});

/** Первая реплика тьютора в ленте. */
const GREETING = message({
  id: 'm-1',
  role: 'tutor',
  content: 'Hi! How was your weekend?',
  createdAt: '2026-09-01T10:00:00.000Z',
});

/** Ответ на реплику ученика: исправление и встречный вопрос тьютора. */
function turnResponse(text: string): LessonTurnResponse {
  return {
    userMessage: message({
      id: 'm-2',
      role: 'user',
      content: text,
      createdAt: '2026-09-01T10:01:00.000Z',
    }),
    tutorMessage: message({
      id: 'm-3',
      role: 'tutor',
      content: 'Sounds nice! What did you do there?',
      createdAt: '2026-09-01T10:01:30.000Z',
    }),
    corrections: [],
    lesson: RUNNING_LESSON,
    currentStep: RUNNING_LESSON.plan[0],
    exercises: [],
  };
}

/** Обработчик запросов комнаты: урок, лента и ход по правилам теста. */
function stubRoom(options: {
  detail?: GetLessonResponse;
  messages?: LessonMessage[];
  hasMore?: boolean;
  onMessages?: (record: FetchRecord) => Response | Promise<Response>;
  onStart?: (record: FetchRecord) => Response | Promise<Response>;
  onTurn?: (record: FetchRecord) => Response | Promise<Response>;
  onAdvance?: (record: FetchRecord) => Response | Promise<Response>;
  onAttempt?: (record: FetchRecord) => Response | Promise<Response>;
  onComplete?: (record: FetchRecord) => Response | Promise<Response>;
}): void {
  const detail = options.detail ?? {
    lesson: RUNNING_LESSON,
    exercises: [],
    attempts: [],
  };

  stubFetch((record) => {
    if (record.path.endsWith('/config')) {
      return jsonResponse(CONFIG_FIXTURE);
    }

    if (record.path === `${API_PREFIX}/lessons/l-1/messages`) {
      return (
        options.onMessages?.(record) ??
        jsonResponse(listPage(options.messages ?? [GREETING], options.hasMore ?? false))
      );
    }

    if (record.path === `${API_PREFIX}/lessons/l-1/start`) {
      return options.onStart?.(record) ?? errorResponse('not_found', 404);
    }

    if (record.path === `${API_PREFIX}/lessons/l-1/turns`) {
      return options.onTurn?.(record) ?? jsonResponse(turnResponse('…'));
    }

    if (record.path === `${API_PREFIX}/lessons/l-1/complete`) {
      return options.onComplete?.(record) ?? errorResponse('not_found', 404);
    }

    if (record.path.endsWith('/advance')) {
      return options.onAdvance?.(record) ?? errorResponse('not_found', 404);
    }

    if (record.path.endsWith('/attempts')) {
      return options.onAttempt?.(record) ?? errorResponse('not_found', 404);
    }

    if (record.path === `${API_PREFIX}/lessons/l-1`) {
      return jsonResponse(detail);
    }

    return errorResponse('not_found', 404);
  });
}

/** Ответ на проверку задания с заполненными по умолчанию полями схемы. */
function checkedAttempt(options: {
  exercise: Exercise;
  answer: string;
  isCorrect?: boolean;
  nextExercise?: Exercise | null;
  lesson?: Lesson;
  messages?: LessonMessage[];
}): CreateExerciseAttemptResponse {
  const isCorrect = options.isCorrect ?? true;

  return {
    attempt: attempt({
      id: `a-${options.exercise.id}`,
      exerciseId: options.exercise.id,
      answer: options.answer,
      isCorrect,
      score: isCorrect ? 1 : 0.4,
      corrections: isCorrect ? [] : [CORRECTION],
      feedback: isCorrect ? 'Верно.' : 'Почти получилось: подведёт только время глагола.',
    }),
    exercise: options.exercise,
    lesson: options.lesson ?? RUNNING_LESSON,
    nextExercise: options.nextExercise ?? null,
    messages: options.messages ?? [],
  };
}

/** Панель задания: внутри неё и ищем поле ответа, кнопки и разбор. */
function exercisePanel(): HTMLElement {
  return screen.getByRole('region', { name: i18n.t('lessonRoom:exercise.title') });
}

/** Поле ввода реплики ученика. */
function composerField(): Promise<HTMLTextAreaElement> {
  return screen.findByLabelText(
    i18n.t('lessonRoom:composer.label'),
  ) as Promise<HTMLTextAreaElement>;
}

beforeEach(async () => {
  calls = [];
  window.localStorage.clear();
  vi.clearAllMocks();
  voiceStub.state.result = {
    text: 'i go to school yesterday',
    provider: 'browser',
    language: 'en',
    durationMs: 2400,
  };
  await i18n.changeLanguage('en');
});

afterEach(() => {
  // При `globals: false` автоматической очистки DOM нет — убираем её вручную.
  cleanup();
  vi.unstubAllGlobals();
});

describe('диалог урока', () => {
  it('отправляет набранную реплику и показывает ответ тьютора', async () => {
    stubRoom({ onTurn: () => jsonResponse(turnResponse('We went to the lake')) });

    const { user } = renderApp(lessonRoomPath('l-1'));

    expect(await screen.findByText(GREETING.content)).toBeInTheDocument();

    await user.type(await composerField(), 'We went to the lake');
    await user.click(screen.getByRole('button', { name: i18n.t('lessonRoom:composer.send') }));

    expect(await screen.findByText('Sounds nice! What did you do there?')).toBeInTheDocument();
    expect(bodyOf<LessonTurnRequest>(lastCall('POST', '/lessons/l-1/turns'))).toMatchObject({
      text: 'We went to the lake',
      source: 'text',
    });
    expect(screen.getByText('We went to the lake')).toBeInTheDocument();
  });

  it('голосовая реплика правится в поле и уходит с source «voice» и длительностью', async () => {
    stubRoom({
      onTurn: () => jsonResponse(turnResponse('i go to school yesterday in the morning')),
    });

    const { user } = renderApp(lessonRoomPath('l-1'));
    const field = await composerField();

    await user.click(screen.getByRole('button', { name: i18n.t('voice:pushToTalk.hold') }));

    // Распознанное сперва попадает в поле: отправлять вслепую нельзя.
    await waitFor(() => {
      expect(field).toHaveValue('i go to school yesterday');
    });

    // Правка распознанного текста перед отправкой: пометка голоса сохраняется.
    await user.type(field, ' in the morning');

    expect(field).toHaveValue('i go to school yesterday in the morning');

    await user.click(screen.getByRole('button', { name: i18n.t('lessonRoom:composer.send') }));

    await waitFor(() => {
      expect(callsTo('POST', '/lessons/l-1/turns')).toHaveLength(1);
    });

    expect(bodyOf<LessonTurnRequest>(lastCall('POST', '/lessons/l-1/turns'))).toMatchObject({
      text: 'i go to school yesterday in the morning',
      source: 'voice',
      durationMs: 2400,
    });
  });

  it('удержание кнопки записи прерывает говорящего тьютора', async () => {
    stubRoom({});

    const { user } = renderApp(lessonRoomPath('l-1'));

    await composerField();
    await user.click(screen.getByRole('button', { name: i18n.t('voice:pushToTalk.hold') }));

    expect(ttsStub.stop).toHaveBeenCalled();
  });

  it('во время ожидания ответа повторная отправка заблокирована', async () => {
    const pending = deferred<Response>();

    stubRoom({ onTurn: () => pending.promise });

    const { user } = renderApp(lessonRoomPath('l-1'));
    const field = await composerField();

    await user.type(field, 'We went to the lake');
    await user.click(screen.getByRole('button', { name: i18n.t('lessonRoom:composer.send') }));

    const sending = await screen.findByRole('button', {
      name: i18n.t('lessonRoom:composer.sending'),
    });

    expect(sending).toBeDisabled();
    expect(screen.getByText(i18n.t('lessonRoom:transcript.thinking'))).toBeInTheDocument();

    await user.type(field, 'And then we came back');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(callsTo('POST', '/lessons/l-1/turns')).toHaveLength(1);

    pending.resolve(jsonResponse(turnResponse('We went to the lake')));

    expect(await screen.findByText('Sounds nice! What did you do there?')).toBeInTheDocument();
    expect(callsTo('POST', '/lessons/l-1/turns')).toHaveLength(1);
  });

  it('после отказа модели реплика остаётся в ленте, а повтор доступен', async () => {
    stubRoom({ onTurn: () => errorResponse('upstream_error', 502) });

    const { user } = renderApp(lessonRoomPath('l-1'));

    await user.type(await composerField(), 'We went to the lake');
    await user.click(screen.getByRole('button', { name: i18n.t('lessonRoom:composer.send') }));

    const alert = await screen.findByRole('alert');

    expect(within(alert).getByText(i18n.t('lessons:errors.upstreamError'))).toBeInTheDocument();
    expect(screen.getByText('We went to the lake')).toBeInTheDocument();
    expect(screen.getByText(i18n.t('lessonRoom:transcript.notDelivered'))).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: i18n.t('lessonRoom:transcript.actions.retryTurn') }),
    );

    await waitFor(() => {
      expect(callsTo('POST', '/lessons/l-1/turns')).toHaveLength(2);
    });
  });

  it('после перезагрузки восстанавливает ленту и текущий шаг', async () => {
    const restored = lesson({
      ...RUNNING_LESSON,
      currentStepId: 's-2',
      plan: [
        step({ id: 's-1', order: 0, title: 'Warm-up', type: 'warmup', status: 'completed' }),
        step({ id: 's-2', order: 1, title: 'Role play', type: 'speaking', status: 'in_progress' }),
      ],
    });

    stubRoom({
      detail: { lesson: restored, exercises: [], attempts: [] },
      messages: [
        GREETING,
        message({
          id: 'm-2',
          role: 'user',
          content: 'We went to the lake',
          source: 'voice',
          createdAt: '2026-09-01T10:01:00.000Z',
        }),
      ],
    });

    renderApp(lessonRoomPath('l-1'));

    expect(await screen.findByText(GREETING.content)).toBeInTheDocument();
    expect(screen.getByText('We went to the lake')).toBeInTheDocument();

    const current = screen.getByText('Role play').closest('li');

    expect(current).not.toBeNull();
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(
      within(current as HTMLElement).getByText(i18n.t('lessonRoom:steps.current')),
    ).toBeInTheDocument();
  });
});

describe('задания урока', () => {
  it('отправляет попытку и показывает разбор с исправлениями', async () => {
    const task = exercise({ id: 'e-1', prompt: 'Вчера я ходил в школу.' });
    const checked: CreateExerciseAttemptResponse = {
      attempt: attempt({ id: 'a-1', exerciseId: 'e-1', answer: 'I go to school yesterday' }),
      exercise: task,
      lesson: RUNNING_LESSON,
      nextExercise: null,
      messages: [],
    };

    stubRoom({
      detail: { lesson: RUNNING_LESSON, exercises: [task], attempts: [] },
      onAttempt: () => jsonResponse(checked, 201),
    });

    const { user } = renderApp(lessonRoomPath('l-1'));

    expect(await screen.findByText(task.prompt)).toBeInTheDocument();

    await user.type(
      screen.getByLabelText(i18n.t('lessonRoom:exercise.answer.label')),
      'I go to school yesterday',
    );
    await user.click(
      screen.getByRole('button', { name: i18n.t('lessonRoom:exercise.actions.submit') }),
    );

    expect(await screen.findByText(CORRECTION.explanation)).toBeInTheDocument();
    expect(screen.getByText(i18n.t('lessonRoom:feedback.incorrect'))).toBeInTheDocument();
    expect(screen.getByText(CORRECTION.corrected)).toBeInTheDocument();
    expect(
      bodyOf<{ answer: string; source: string }>(
        lastCall('POST', '/lessons/l-1/exercises/e-1/attempts'),
      ),
    ).toMatchObject({ answer: 'I go to school yesterday', source: 'text' });
  });

  it('множественный выбор не отправляется, пока вариант не выбран', async () => {
    const task = exercise({
      id: 'e-mc',
      type: 'multiple_choice',
      prompt: 'Which sentence is in the past simple?',
      instructions: 'Pick one option.',
      options: ['I go to school yesterday', 'I went to school yesterday'],
      expectedAnswer: 'I went to school yesterday',
    });

    stubRoom({
      detail: { lesson: RUNNING_LESSON, exercises: [task], attempts: [] },
      onAttempt: () =>
        jsonResponse(checkedAttempt({ exercise: task, answer: 'I went to school yesterday' }), 201),
    });

    const { user } = renderApp(lessonRoomPath('l-1'));

    expect(await screen.findByText(task.prompt)).toBeInTheDocument();

    const panel = exercisePanel();

    // Варианты ответа — радиогруппа: свободного поля у такого задания нет.
    expect(
      within(panel).queryByLabelText(i18n.t('lessonRoom:exercise.answer.label')),
    ).not.toBeInTheDocument();
    expect(within(panel).getAllByRole('radio')).toHaveLength(2);

    await user.click(
      within(panel).getByRole('button', { name: i18n.t('lessonRoom:exercise.actions.submit') }),
    );

    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      i18n.t('lessonRoom:exercise.errors.noChoice'),
    );
    expect(callsTo('POST', '/lessons/l-1/exercises/e-mc/attempts')).toHaveLength(0);

    await user.click(within(panel).getByRole('radio', { name: 'I went to school yesterday' }));
    await user.click(
      within(panel).getByRole('button', { name: i18n.t('lessonRoom:exercise.actions.submit') }),
    );

    expect(await screen.findByText(i18n.t('lessonRoom:feedback.correct'))).toBeInTheDocument();
    expect(
      bodyOf<CreateExerciseAttemptRequest>(
        lastCall('POST', '/lessons/l-1/exercises/e-mc/attempts'),
      ),
    ).toMatchObject({ answer: 'I went to school yesterday', source: 'text' });
  });

  it('подстановка показывает вид задания и подсказки', async () => {
    const task = exercise({
      id: 'e-fb',
      type: 'fill_blank',
      prompt: 'Yesterday I ___ to school.',
      instructions: 'Put the verb into the past simple.',
      hints: ['the verb is go'],
      expectedAnswer: 'went',
    });

    stubRoom({
      detail: { lesson: RUNNING_LESSON, exercises: [task], attempts: [] },
      onAttempt: () => jsonResponse(checkedAttempt({ exercise: task, answer: 'went' }), 201),
    });

    const { user } = renderApp(lessonRoomPath('l-1'));

    expect(await screen.findByText(task.prompt)).toBeInTheDocument();

    const panel = exercisePanel();

    expect(
      within(panel).getByText(i18n.t('lessonRoom:exercise.types.fill_blank')),
    ).toBeInTheDocument();
    expect(within(panel).getByText(task.instructions as string)).toBeInTheDocument();

    const hints = within(panel).getByRole('list', { name: i18n.t('lessonRoom:exercise.hints') });

    expect(within(hints).getByText('the verb is go')).toBeInTheDocument();

    await user.type(
      within(panel).getByLabelText(i18n.t('lessonRoom:exercise.answer.label')),
      'went',
    );
    await user.click(
      within(panel).getByRole('button', { name: i18n.t('lessonRoom:exercise.actions.submit') }),
    );

    expect(await screen.findByText(i18n.t('lessonRoom:feedback.correct'))).toBeInTheDocument();
    expect(
      bodyOf<CreateExerciseAttemptRequest>(
        lastCall('POST', '/lessons/l-1/exercises/e-fb/attempts'),
      ),
    ).toMatchObject({ answer: 'went', source: 'text' });
  });

  it('после разбора вопроса-ответа открывается следующее задание', async () => {
    const first = exercise({
      id: 'e-qa',
      type: 'qa',
      prompt: 'What did you do last weekend?',
      instructions: 'Answer in two sentences.',
      expectedAnswer: null,
    });
    const second = exercise({
      id: 'e-qa-2',
      order: 1,
      type: 'translate',
      prompt: 'Вчера мы ходили к озеру.',
    });

    stubRoom({
      detail: { lesson: RUNNING_LESSON, exercises: [first], attempts: [] },
      onAttempt: () =>
        jsonResponse(
          checkedAttempt({
            exercise: first,
            answer: 'We went to the lake and cooked fish.',
            nextExercise: second,
          }),
          201,
        ),
    });

    const { user } = renderApp(lessonRoomPath('l-1'));

    expect(await screen.findByText(first.prompt)).toBeInTheDocument();
    expect(screen.getByText(i18n.t('lessonRoom:exercise.types.qa'))).toBeInTheDocument();

    await user.type(
      screen.getByLabelText(i18n.t('lessonRoom:exercise.answer.label')),
      'We went to the lake and cooked fish.',
    );
    await user.click(
      screen.getByRole('button', { name: i18n.t('lessonRoom:exercise.actions.submit') }),
    );

    expect(await screen.findByText(i18n.t('lessonRoom:feedback.correct'))).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: i18n.t('lessonRoom:exercise.actions.next') }),
    );

    expect(await screen.findByText(second.prompt)).toBeInTheDocument();
    expect(screen.queryByText(first.prompt)).not.toBeInTheDocument();
  });

  it('свободная речь отвечается голосом и уходит с пометкой voice', async () => {
    const task = exercise({
      id: 'e-fs',
      type: 'free_speech',
      prompt: 'Tell me about your weekend.',
      expectedAnswer: null,
    });

    stubRoom({
      detail: { lesson: RUNNING_LESSON, exercises: [task], attempts: [] },
      onAttempt: () =>
        jsonResponse(
          checkedAttempt({ exercise: task, answer: 'i go to school yesterday', isCorrect: false }),
          201,
        ),
    });

    const { user } = renderApp(lessonRoomPath('l-1'));

    expect(await screen.findByText(task.prompt)).toBeInTheDocument();

    const panel = exercisePanel();
    const field = within(panel).getByLabelText(i18n.t('lessonRoom:exercise.answer.label'));

    expect(
      within(panel).getByText(i18n.t('lessonRoom:exercise.answer.voiceHint')),
    ).toBeInTheDocument();

    // У свободной речи своя кнопка удержания — рядом с полем ответа, а не только в диалоге.
    await user.click(within(panel).getByRole('button', { name: i18n.t('voice:pushToTalk.hold') }));

    // Расшифровка сперва попадает в поле: отправлять её вслепую нельзя.
    await waitFor(() => {
      expect(field).toHaveValue('i go to school yesterday');
    });

    await user.click(
      within(panel).getByRole('button', { name: i18n.t('lessonRoom:exercise.actions.submit') }),
    );

    await waitFor(() => {
      expect(callsTo('POST', '/lessons/l-1/exercises/e-fs/attempts')).toHaveLength(1);
    });

    expect(
      bodyOf<CreateExerciseAttemptRequest>(
        lastCall('POST', '/lessons/l-1/exercises/e-fs/attempts'),
      ),
    ).toMatchObject({ answer: 'i go to school yesterday', source: 'voice', durationMs: 2400 });
    expect(await screen.findByText(CORRECTION.explanation)).toBeInTheDocument();
  });

  it('во время проверки ответа повторная отправка заблокирована', async () => {
    const task = exercise({ id: 'e-1', prompt: 'Вчера я ходил в школу.' });
    const pending = deferred<Response>();

    stubRoom({
      detail: { lesson: RUNNING_LESSON, exercises: [task], attempts: [] },
      onAttempt: () => pending.promise,
    });

    const { user } = renderApp(lessonRoomPath('l-1'));

    expect(await screen.findByText(task.prompt)).toBeInTheDocument();

    const field = screen.getByLabelText(i18n.t('lessonRoom:exercise.answer.label'));

    await user.type(field, 'I went to school yesterday');
    await user.click(
      screen.getByRole('button', { name: i18n.t('lessonRoom:exercise.actions.submit') }),
    );

    const checking = await screen.findByRole('button', {
      name: i18n.t('lessonRoom:exercise.actions.checking'),
    });

    expect(checking).toBeDisabled();
    expect(field).toBeDisabled();

    await user.click(checking);

    expect(callsTo('POST', '/lessons/l-1/exercises/e-1/attempts')).toHaveLength(1);

    pending.resolve(
      jsonResponse(checkedAttempt({ exercise: task, answer: 'I went to school yesterday' }), 201),
    );

    expect(await screen.findByText(i18n.t('lessonRoom:feedback.correct'))).toBeInTheDocument();
    expect(callsTo('POST', '/lessons/l-1/exercises/e-1/attempts')).toHaveLength(1);
  });
});

describe('ввод реплики', () => {
  it('пустая реплика не уходит на сервер', async () => {
    stubRoom({});

    const { user } = renderApp(lessonRoomPath('l-1'));
    const field = await composerField();

    await user.click(screen.getByRole('button', { name: i18n.t('lessonRoom:composer.send') }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      i18n.t('lessonRoom:composer.errors.empty'),
    );
    expect(callsTo('POST', '/lessons/l-1/turns')).toHaveLength(0);

    // Одни пробелы — тоже пустая реплика.
    await user.type(field, '   ');
    await user.click(screen.getByRole('button', { name: i18n.t('lessonRoom:composer.send') }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      i18n.t('lessonRoom:composer.errors.empty'),
    );
    expect(callsTo('POST', '/lessons/l-1/turns')).toHaveLength(0);
  });

  it('реплика длиннее предела схемы не уходит на сервер', async () => {
    stubRoom({});

    // Длинная диктовка попадает в поле целиком: расшифровку никто не обрезает.
    voiceStub.state.result = {
      text: 'a'.repeat(LESSON_TURN_MAX_LENGTH + 1),
      provider: 'browser',
      language: 'en',
      durationMs: 60_000,
    };

    const { user } = renderApp(lessonRoomPath('l-1'));
    const field = await composerField();

    await user.click(screen.getByRole('button', { name: i18n.t('voice:pushToTalk.hold') }));

    await waitFor(() => {
      expect(field.value).toHaveLength(LESSON_TURN_MAX_LENGTH + 1);
    });

    await user.click(screen.getByRole('button', { name: i18n.t('lessonRoom:composer.send') }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      i18n.t('lessonRoom:composer.errors.tooLong', { max: LESSON_TURN_MAX_LENGTH }),
    );
    expect(callsTo('POST', '/lessons/l-1/turns')).toHaveLength(0);
    // Набранное не пропадает: ученику есть что сократить.
    expect(field.value).toHaveLength(LESSON_TURN_MAX_LENGTH + 1);
  });

  it('при включённой автоозвучке новый ответ тьютора произносится один раз', async () => {
    stubRoom({ onTurn: () => jsonResponse(turnResponse('We went to the lake')) });

    const { user } = renderApp(lessonRoomPath('l-1'));

    expect(await screen.findByText(GREETING.content)).toBeInTheDocument();
    // Восстановленную ленту не переозвучиваем: голос дают только новые ответы.
    expect(ttsStub.speak).not.toHaveBeenCalled();

    await user.type(await composerField(), 'We went to the lake');
    await user.click(screen.getByRole('button', { name: i18n.t('lessonRoom:composer.send') }));

    await waitFor(() => {
      expect(ttsStub.speak).toHaveBeenCalledTimes(1);
    });

    expect(ttsStub.speak).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Sounds nice! What did you do there?' }),
    );
  });

  it('выключенная автоозвучка молчит и переживает перемонтирование', async () => {
    stubRoom({ onTurn: () => jsonResponse(turnResponse('We went to the lake')) });

    const { user } = renderApp(lessonRoomPath('l-1'));
    const toggle = await screen.findByLabelText(i18n.t('lessonRoom:composer.autoSpeak.label'));

    expect(toggle).toBeChecked();

    await user.click(toggle);

    expect(toggle).not.toBeChecked();

    await user.type(await composerField(), 'We went to the lake');
    await user.click(screen.getByRole('button', { name: i18n.t('lessonRoom:composer.send') }));

    expect(await screen.findByText('Sounds nice! What did you do there?')).toBeInTheDocument();
    expect(ttsStub.speak).not.toHaveBeenCalled();

    // Выбор хранится в браузере: после перезагрузки страницы он тот же.
    cleanup();
    renderApp(lessonRoomPath('l-1'));

    expect(
      await screen.findByLabelText(i18n.t('lessonRoom:composer.autoSpeak.label')),
    ).not.toBeChecked();
  });
});

describe('состояние комнаты', () => {
  it('урок из черновика запускается и открывает диалог', async () => {
    const draft = lesson({
      ...RUNNING_LESSON,
      status: 'draft',
      currentStepId: null,
      startedAt: null,
    });
    const started: StartLessonResponse = {
      lesson: RUNNING_LESSON,
      messages: [GREETING],
      currentStep: RUNNING_LESSON.plan[0],
    };

    stubRoom({
      detail: { lesson: draft, exercises: [], attempts: [] },
      messages: [],
      onStart: () => jsonResponse(started),
    });

    const { user } = renderApp(lessonRoomPath('l-1'));
    const startButton = await screen.findByRole('button', {
      name: i18n.t('lessonRoom:intro.start'),
    });

    // Пока урок не начат, говорить не с кем.
    expect(screen.queryByLabelText(i18n.t('lessonRoom:composer.label'))).not.toBeInTheDocument();

    await user.click(startButton);

    expect(await screen.findByText(GREETING.content)).toBeInTheDocument();
    expect(await composerField()).toBeInTheDocument();
    expect(callsTo('POST', '/lessons/l-1/start')).toHaveLength(1);
  });

  it('свежий урок из ответа применяется без повторного чтения урока', async () => {
    const task = exercise({ id: 'e-new', stepId: 's-2', prompt: 'Вчера мы ходили к озеру.' });
    const moved = lesson({
      ...RUNNING_LESSON,
      currentStepId: 's-2',
      plan: [
        step({ id: 's-1', order: 0, title: 'Warm-up', type: 'warmup', status: 'completed' }),
        step({ id: 's-2', order: 1, title: 'Role play', type: 'speaking', status: 'in_progress' }),
      ],
    });

    stubRoom({
      onTurn: () =>
        jsonResponse({
          ...turnResponse('We went to the lake'),
          lesson: moved,
          currentStep: moved.plan[1],
          exercises: [task],
        } satisfies LessonTurnResponse),
    });

    const { user } = renderApp(lessonRoomPath('l-1'));

    await user.type(await composerField(), 'We went to the lake');
    await user.click(screen.getByRole('button', { name: i18n.t('lessonRoom:composer.send') }));

    // Урок и задания пришли ответом на реплику: перечитывать урок незачем.
    expect(await screen.findByText(task.prompt)).toBeInTheDocument();

    const current = screen.getByText('Role play').closest('li');

    expect(current).not.toBeNull();
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(callsTo('GET', '/lessons/l-1')).toHaveLength(1);
  });

  it('повтор неудавшейся реплики заменяет её сохранённой', async () => {
    stubRoom({
      onTurn: () =>
        callsTo('POST', '/lessons/l-1/turns').length === 1
          ? errorResponse('upstream_error', 502)
          : jsonResponse(turnResponse('We went to the lake')),
    });

    const { user } = renderApp(lessonRoomPath('l-1'));

    await user.type(await composerField(), 'We went to the lake');
    await user.click(screen.getByRole('button', { name: i18n.t('lessonRoom:composer.send') }));

    expect(
      await screen.findByText(i18n.t('lessonRoom:transcript.notDelivered')),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: i18n.t('lessonRoom:transcript.actions.retryTurn') }),
    );

    expect(await screen.findByText('Sounds nice! What did you do there?')).toBeInTheDocument();
    expect(
      screen.queryByText(i18n.t('lessonRoom:transcript.notDelivered')),
    ).not.toBeInTheDocument();
    // Реплика в ленте одна: местная сменилась сохранённой, а не удвоилась.
    expect(screen.getAllByText('We went to the lake')).toHaveLength(1);
  });

  it('переход к следующему шагу открывает его реплики и задание', async () => {
    const task = exercise({ id: 'e-s2', stepId: 's-2', prompt: 'Составьте диалог в магазине.' });
    const moved = lesson({
      ...RUNNING_LESSON,
      currentStepId: 's-2',
      plan: [
        step({ id: 's-1', order: 0, title: 'Warm-up', type: 'warmup', status: 'completed' }),
        step({ id: 's-2', order: 1, title: 'Role play', type: 'speaking', status: 'in_progress' }),
      ],
    });
    const opening = message({
      id: 'm-4',
      role: 'tutor',
      content: 'Now let us play a small scene.',
      stepId: 's-2',
      createdAt: '2026-09-01T10:10:00.000Z',
    });
    const advanced: AdvanceLessonStepResponse = {
      lesson: moved,
      currentStep: moved.plan[1],
      messages: [opening],
      exercises: [task],
    };

    stubRoom({ onAdvance: () => jsonResponse(advanced) });

    const { user } = renderApp(lessonRoomPath('l-1'));

    expect(await screen.findByText(GREETING.content)).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: i18n.t('lessonRoom:steps.actions.advance') }),
    );

    expect(await screen.findByText(opening.content)).toBeInTheDocument();
    expect(screen.getByText(task.prompt)).toBeInTheDocument();
    expect(bodyOf<{ status: string }>(lastCall('POST', '/lessons/l-1/steps/s-1/advance'))).toEqual({
      status: 'completed',
    });

    const current = screen.getByText('Role play').closest('li');

    expect(current).toHaveAttribute('aria-current', 'step');
  });

  it('отказ чтения ленты объясняется отдельно и не рушит комнату', async () => {
    stubRoom({ onMessages: () => errorResponse('internal_error', 500) });

    renderApp(lessonRoomPath('l-1'));
    const alert = await screen.findByRole('alert');

    expect(
      within(alert).getByText(i18n.t('lessonRoom:errors.actions.restore')),
    ).toBeInTheDocument();
    expect(within(alert).getByText(i18n.t('lessonRoom:errors.progressKept'))).toBeInTheDocument();

    // Повторить восстановление ленты предлагается кнопкой рядом с объяснением.
    expect(
      within(alert).getByRole('button', { name: i18n.t('common:actions.retry') }),
    ).toBeEnabled();

    // Отказ ленты не рушит комнату: план урока и поле ввода на месте.
    expect(
      screen.getByRole('navigation', { name: i18n.t('lessonRoom:steps.title') }),
    ).toBeInTheDocument();
    expect(await composerField()).toBeInTheDocument();
  });

  it('повтор после отказа ленты перечитывает её и восстанавливает реплики', async () => {
    // Регрессия: retry() ветвился по состоянию failure, а отказ ленты в него не
    // попадал — ветка 'restore' была недостижима, и кнопка «Повторить» молча
    // ничего не делала. Помогала только перезагрузка страницы: повтор запроса
    // выключен для 500 (ретраятся лишь обрыв связи и 503).
    let failNext = true;

    stubRoom({
      onMessages: () => {
        if (failNext) {
          failNext = false;

          return errorResponse('internal_error', 500);
        }

        return jsonResponse(listPage([GREETING]));
      },
    });

    renderApp(lessonRoomPath('l-1'));

    const alert = await screen.findByRole('alert');
    const retryButton = within(alert).getByRole('button', {
      name: i18n.t('common:actions.retry'),
    });

    await userEvent.click(retryButton);

    // Лента перечитана и показана, объяснение отказа ушло.
    expect(await screen.findByText(GREETING.content)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('завершение урока показывает итог, изменение уровня и записанное в прогресс', async () => {
    const summary: LessonSummary = {
      text: 'You kept the past simple almost everywhere and told a long story.',
      strengths: ['Long sentences without long pauses'],
      weaknesses: ['Irregular verbs'],
      recommendations: ['Retell the same story once more'],
      newVocabulary: [],
      exercisesTotal: 4,
      exercisesCorrect: 3,
      accuracy: 0.75,
      durationMinutes: 21,
    };
    const levelChange: LevelHistoryEntry = {
      id: 'lh-3',
      fromLevel: 'B1',
      toLevel: 'B2',
      direction: 'up',
      source: 'progress',
      confidence: 0.82,
      reason: 'Three lessons in a row above 85 percent of correct answers.',
      metrics: {
        accuracy: 0.88,
        lessonsConsidered: 3,
        lessonsSinceLastChange: 4,
        exercisesEvaluated: 42,
        windowFrom: '2026-08-20T10:00:00.000Z',
        windowTo: '2026-09-01T10:00:00.000Z',
      },
      changedAt: '2026-09-01T11:00:00.000Z',
      createdAt: '2026-09-01T11:00:00.000Z',
    };
    const word: VocabularyItem = {
      id: 'v-1',
      term: 'to hike',
      translation: 'ходить в поход',
      language: 'en',
      translationLanguage: 'ru',
      partOfSpeech: null,
      transcription: null,
      example: null,
      level: 'B1',
      status: 'new',
      timesSeen: 1,
      timesCorrect: 0,
      lessonId: 'l-1',
      materialId: null,
      firstSeenAt: '2026-09-01T10:30:00.000Z',
      lastSeenAt: '2026-09-01T10:30:00.000Z',
      createdAt: '2026-09-01T10:30:00.000Z',
      updatedAt: '2026-09-01T10:30:00.000Z',
    };
    const loggedError: ErrorLogEntry = {
      ...CORRECTION,
      id: 'el-1',
      language: 'en',
      lessonId: 'l-1',
      stepId: 's-1',
      exerciseId: null,
      messageId: 'm-2',
      occurredAt: '2026-09-01T10:20:00.000Z',
      createdAt: '2026-09-01T10:20:00.000Z',
    };
    const completed: CompleteLessonResponse = {
      lesson: lesson({
        ...RUNNING_LESSON,
        status: 'completed',
        currentStepId: null,
        summary,
        completedAt: '2026-09-01T11:00:00.000Z',
      }),
      summary,
      levelChange,
      vocabularyAdded: [word],
      errorsLogged: [loggedError],
    };

    stubRoom({ onComplete: () => jsonResponse(completed) });

    const { user } = renderApp(lessonRoomPath('l-1'));

    expect(await screen.findByText(GREETING.content)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: i18n.t('lessonRoom:actions.complete') }));

    expect(
      await screen.findByRole('heading', { name: i18n.t('lessonRoom:summary.title') }),
    ).toBeInTheDocument();
    expect(screen.getByText(summary.text)).toBeInTheDocument();
    expect(
      screen.getByText(i18n.t('lessonRoom:summary.accuracy', { percent: 75 })),
    ).toBeInTheDocument();
    // Обоснование изменения уровня — часть итога, а не деталь раздела прогресса.
    expect(
      screen.getByText(
        i18n.t('lessonRoom:summary.levelChange.reason', { reason: levelChange.reason }),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(word.term)).toBeInTheDocument();
    expect(screen.getByText(word.translation)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: i18n.t('lessonRoom:summary.errorsLogged', { count: 1 }),
      }),
    ).toBeInTheDocument();

    // Урок закончен: говорить и завершать больше нечего.
    expect(screen.queryByLabelText(i18n.t('lessonRoom:composer.label'))).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: i18n.t('lessonRoom:actions.complete') }),
    ).not.toBeInTheDocument();
  });
});
