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
  type ApiErrorResponse,
  type AppConfig,
  type Correction,
  type CreateExerciseAttemptResponse,
  type Exercise,
  type ExerciseAttempt,
  type GetLessonResponse,
  type Lesson,
  type LessonMessage,
  type LessonPlanStep,
  type LessonTurnRequest,
  type LessonTurnResponse,
} from '@lt/shared';

import { App } from '../src/App';
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
  onTurn?: (record: FetchRecord) => Response | Promise<Response>;
  onAttempt?: (record: FetchRecord) => Response | Promise<Response>;
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
      return jsonResponse(listPage(options.messages ?? [GREETING], options.hasMore ?? false));
    }

    if (record.path === `${API_PREFIX}/lessons/l-1/turns`) {
      return options.onTurn?.(record) ?? jsonResponse(turnResponse('…'));
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
});
