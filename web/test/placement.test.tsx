/**
 * Мастер определения уровня: интро, диалог с вопросами, восстановление
 * незавершённого теста, отказы языковой модели и слот голосового ввода.
 *
 * Сервер подменяется мок-`fetch`: бэкенд определения уровня пишется параллельно,
 * поэтому тест проверяет интерфейс против контракта `@lt/shared`, а не против
 * маршрутов. Форма ответа `GET /api/placement/sessions/:id` — та же, что у
 * создания сессии (`{ session, nextTurn }`).
 */
import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  PLACEMENT_DEFAULT_MAX_TURNS,
  type ApiErrorResponse,
  type AppConfig,
  type LearnerProfile,
  type PlacementResult as PlacementResultData,
  type PlacementSession,
  type PlacementTurn,
} from '@lt/shared';

import { App } from '../src/App';
import { PlacementChat } from '../src/features/placement/PlacementChat';
import { PLACEMENT_SESSION_STORAGE_KEY } from '../src/features/placement/usePlacement';
import { i18n } from '../src/i18n';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { routes } from '../src/router';

/** Конфигурация сервера: языковая модель настроена. */
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

/** Конфигурация сервера без настроенной языковой модели. */
const CONFIG_WITHOUT_LLM: AppConfig = {
  ...CONFIG_FIXTURE,
  llm: { available: false, model: null, reason: 'LLM_BASE_URL is empty' },
};

/** Профиль, который возвращает `/finish` вместе с новым уровнем. */
const PROFILE_FIXTURE: LearnerProfile = {
  id: 'learner-1',
  learningLanguage: 'en',
  interfaceLanguage: 'en',
  explanationLanguage: 'ru',
  level: 'B1',
  levelConfidence: 0.8,
  goals: ['Travel'],
  interests: [],
  dailyMinutes: 20,
  placementCompletedAt: '2026-09-16T10:00:00.000Z',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-09-16T10:00:00.000Z',
};

/** Идентификатор сессии, которую отдаёт мок-сервер. */
const SESSION_ID = 'placement-1';

/** Вопросы теста: третий ответ завершает сессию. */
const QUESTIONS = [
  'What did you do last weekend?',
  'Describe your favourite place in three sentences.',
  'What would you change about your job if you could?',
] as const;

/** Вопрос сессии с заполненными по умолчанию полями схемы. */
function turn(order: number, overrides: Partial<PlacementTurn> = {}): PlacementTurn {
  return {
    id: `turn-${order}`,
    sessionId: SESSION_ID,
    order,
    question: QUESTIONS[order] ?? `Question number ${order}`,
    questionLanguage: 'en',
    targetLevel: 'B1',
    skill: 'grammar',
    answer: null,
    source: null,
    score: null,
    feedback: null,
    estimatedLevel: null,
    askedAt: '2026-09-16T10:00:00.000Z',
    answeredAt: null,
    ...overrides,
  };
}

/** Отвеченный вопрос с разбором тьютора. */
function answeredTurn(order: number, answer: string): PlacementTurn {
  return turn(order, {
    answer,
    source: 'text',
    score: 0.8,
    feedback: `Feedback for answer ${order}`,
    estimatedLevel: 'B1',
    answeredAt: '2026-09-16T10:05:00.000Z',
  });
}

/** Сессия определения уровня. */
function session(overrides: Partial<PlacementSession> = {}): PlacementSession {
  return {
    id: SESSION_ID,
    status: 'in_progress',
    learningLanguage: 'en',
    explanationLanguage: 'ru',
    maxTurns: 3,
    turns: [],
    result: null,
    startedAt: '2026-09-16T10:00:00.000Z',
    completedAt: null,
    createdAt: '2026-09-16T10:00:00.000Z',
    updatedAt: '2026-09-16T10:00:00.000Z',
    ...overrides,
  };
}

/** Итог определения уровня. */
const RESULT_FIXTURE: PlacementResultData = {
  level: 'B1',
  confidence: 0.8,
  rationale: 'Confident with everyday topics, struggles with past tenses.',
  strengths: ['Everyday vocabulary'],
  weaknesses: ['Past tenses'],
  recommendedGoals: ['Talk about travel plans'],
  turnsEvaluated: 3,
  accuracy: 0.75,
};

/** Запрос, дошедший до подменённого `fetch`. */
interface FetchRecord {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
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
function stubFetch(handler: (record: FetchRecord) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const record: FetchRecord = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body,
      };

      calls.push(record);

      return Promise.resolve(handler(record));
    }),
  );
}

/** Тело запроса как объект: тесту важно, что именно ушло на сервер. */
function bodyOf(record: FetchRecord | undefined): Record<string, unknown> {
  return record && typeof record.body === 'string'
    ? (JSON.parse(record.body) as Record<string, unknown>)
    : {};
}

/** Запрос к конкретному пути определения уровня. */
function callTo(path: string, method = 'POST'): FetchRecord | undefined {
  return calls.find((call) => call.method === method && call.url.endsWith(path));
}

/** Поднимает приложение на странице определения уровня, без истории браузера. */
function renderPlacement() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: ['/placement'] });

  return {
    user: userEvent.setup(),
    ...render(<App router={router} queryClient={queryClient} />),
  };
}

/** Перевод ключа namespace `placement`. */
function tp(key: string, params?: Record<string, unknown>): string {
  return i18n.t(`placement:${key}`, params ?? {});
}

/** Отвечает на текущий вопрос текстом ответа. */
async function answerWith(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.type(screen.getByLabelText(tp('chat.input.label')), text);
  await user.click(screen.getByRole('button', { name: tp('chat.input.submit') }));
}

beforeEach(async () => {
  calls = [];
  window.localStorage.clear();
  await i18n.changeLanguage('en');
});

afterEach(() => {
  // При `globals: false` автоматической очистки DOM нет — убираем её вручную.
  cleanup();
  vi.unstubAllGlobals();
});

describe('сквозной прогон теста', () => {
  it('ведёт от интро через три ответа к уровню и записывает его в профиль', async () => {
    const answers = ['I went hiking.', 'It is a quiet park near my home.', 'I would work less.'];
    let answered = 0;

    stubFetch((record) => {
      if (record.url.includes('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      if (record.url.endsWith('/placement/sessions')) {
        return jsonResponse({ session: session({ turns: [turn(0)] }), nextTurn: turn(0) });
      }

      if (record.url.endsWith('/turns')) {
        const order = answered;

        answered += 1;

        const evaluated = answeredTurn(order, answers[order] ?? '');
        const history = answers.slice(0, answered).map((text, index) => answeredTurn(index, text));
        const nextTurn = answered < answers.length ? turn(answered) : null;

        return jsonResponse({
          session: session({ turns: nextTurn ? [...history, nextTurn] : history }),
          evaluatedTurn: evaluated,
          nextTurn,
          finished: nextTurn === null,
        });
      }

      if (record.url.endsWith('/finish')) {
        return jsonResponse({
          session: session({
            status: 'completed',
            turns: answers.map((text, index) => answeredTurn(index, text)),
            result: RESULT_FIXTURE,
            completedAt: '2026-09-16T10:20:00.000Z',
          }),
          result: RESULT_FIXTURE,
          profile: PROFILE_FIXTURE,
        });
      }

      return errorResponse('not_found', 404);
    });

    const { user } = renderPlacement();

    await user.click(await screen.findByRole('button', { name: tp('intro.start') }));

    expect(await screen.findByText(QUESTIONS[0])).toBeInTheDocument();
    expect(screen.getByText(tp('chat.progress', { current: 1, total: 3 }))).toBeInTheDocument();

    await answerWith(user, answers[0]!);
    expect(await screen.findByText(QUESTIONS[1])).toBeInTheDocument();

    await answerWith(user, answers[1]!);
    expect(await screen.findByText(QUESTIONS[2])).toBeInTheDocument();

    await answerWith(user, answers[2]!);

    // Вопросы кончились — итог запрашивается сам, отдельной кнопки ждать незачем.
    const levelBadge = await screen.findByText(
      tp('result.level', { level: 'B1', name: i18n.t('profile:level.names.B1') }),
    );

    expect(levelBadge).toBeInTheDocument();
    expect(screen.getByText(RESULT_FIXTURE.rationale)).toBeInTheDocument();
    expect(screen.getByText(RESULT_FIXTURE.strengths[0]!)).toBeInTheDocument();
    expect(screen.getByText(RESULT_FIXTURE.weaknesses[0]!)).toBeInTheDocument();

    // Уровень ушёл в профиль: запрос завершения просил его применить.
    const finish = callTo('/finish');

    expect(finish).toBeDefined();
    expect(bodyOf(finish)).toEqual({ applyToProfile: true });
    expect(screen.getByText(tp('result.savedToProfile', { level: 'B1' }))).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: tp('result.saveToProfile') }),
    ).not.toBeInTheDocument();

    // Ответы ушли ровно те, что ввёл ученик, и с пометкой «текст».
    const turnCalls = calls.filter((call) => call.url.endsWith('/turns'));

    expect(turnCalls).toHaveLength(3);
    expect(bodyOf(turnCalls[0])).toEqual({
      turnId: 'turn-0',
      answer: answers[0],
      source: 'text',
    });

    // Кнопка первого урока ведёт в раздел уроков.
    expect(screen.getByRole('link', { name: tp('result.createLesson') })).toHaveAttribute(
      'href',
      '/lessons',
    );
  });
});

describe('восстановление незавершённого теста', () => {
  it('подтягивает историю ходов по сохранённому идентификатору сессии', async () => {
    window.localStorage.setItem(PLACEMENT_SESSION_STORAGE_KEY, SESSION_ID);

    const history = [answeredTurn(0, 'I went hiking.'), answeredTurn(1, 'A quiet park.')];

    stubFetch((record) => {
      if (record.url.includes('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      if (record.method === 'GET' && record.url.endsWith(`/placement/sessions/${SESSION_ID}`)) {
        return jsonResponse({
          session: session({ maxTurns: 8, turns: [...history, turn(2)] }),
          nextTurn: turn(2),
        });
      }

      return errorResponse('not_found', 404);
    });

    renderPlacement();

    // Прошлые вопросы и ответы на месте, а не начинается новый тест.
    expect(await screen.findByText(QUESTIONS[0])).toBeInTheDocument();
    expect(screen.getByText('I went hiking.')).toBeInTheDocument();
    expect(screen.getByText(QUESTIONS[1])).toBeInTheDocument();
    expect(screen.getByText('A quiet park.')).toBeInTheDocument();
    expect(screen.getByText(QUESTIONS[2])).toBeInTheDocument();
    expect(screen.getByText(tp('chat.progress', { current: 3, total: 8 }))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: tp('intro.start') })).not.toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('возвращает к интро, когда сервер не знает сохранённую сессию', async () => {
    window.localStorage.setItem(PLACEMENT_SESSION_STORAGE_KEY, 'stale-session');

    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(CONFIG_FIXTURE)
        : errorResponse('not_found', 404),
    );

    renderPlacement();

    expect(await screen.findByRole('button', { name: tp('intro.start') })).toBeInTheDocument();
    expect(window.localStorage.getItem(PLACEMENT_SESSION_STORAGE_KEY)).toBeNull();
  });
});

describe('отказы языковой модели', () => {
  it('не теряет сессию при 502 и отправляет ответ повторно', async () => {
    window.localStorage.setItem(PLACEMENT_SESSION_STORAGE_KEY, SESSION_ID);

    const history = [answeredTurn(0, 'I went hiking.')];
    let failNextTurn = true;

    stubFetch((record) => {
      if (record.url.includes('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      if (record.method === 'GET' && record.url.endsWith(`/placement/sessions/${SESSION_ID}`)) {
        return jsonResponse({
          session: session({ maxTurns: 8, turns: [...history, turn(1)] }),
          nextTurn: turn(1),
        });
      }

      if (record.url.endsWith('/turns')) {
        if (failNextTurn) {
          failNextTurn = false;

          return errorResponse('upstream_error', 502);
        }

        const evaluated = answeredTurn(1, 'A quiet park.');

        return jsonResponse({
          session: session({ maxTurns: 8, turns: [...history, evaluated, turn(2)] }),
          evaluatedTurn: evaluated,
          nextTurn: turn(2),
          finished: false,
        });
      }

      return errorResponse('not_found', 404);
    });

    const { user } = renderPlacement();

    await screen.findByText(QUESTIONS[1]);
    await answerWith(user, 'A quiet park.');

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent(tp('errors.upstreamError'));
    expect(alert).toHaveTextContent(tp('errors.progressKept'));
    // Прогресс на месте: первый ответ виден, сессия по-прежнему запомнена.
    expect(screen.getByText('I went hiking.')).toBeInTheDocument();
    expect(window.localStorage.getItem(PLACEMENT_SESSION_STORAGE_KEY)).toBe(SESSION_ID);

    await user.click(screen.getByRole('button', { name: i18n.t('actions.retry') }));

    expect(await screen.findByText(QUESTIONS[2])).toBeInTheDocument();
    expect(screen.getByText('A quiet park.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(calls.filter((call) => call.url.endsWith('/turns'))).toHaveLength(2);
  });

  it('объясняет 501 ненастроенной моделью, а не общей ошибкой', async () => {
    stubFetch((record) => {
      if (record.url.includes('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      return errorResponse('not_configured', 501);
    });

    const { user } = renderPlacement();

    await user.click(await screen.findByRole('button', { name: tp('intro.start') }));

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent(tp('errors.notConfigured'));
    expect(screen.queryByText(i18n.t('errors.byCode.not_configured'))).not.toBeInTheDocument();
    // Повтор доступен: настройку можно починить и попробовать снова.
    expect(screen.getByRole('button', { name: i18n.t('actions.retry') })).toBeEnabled();
  });

  it('предупреждает о ненастроенной модели до старта теста', async () => {
    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(CONFIG_WITHOUT_LLM)
        : errorResponse('not_configured', 501),
    );

    renderPlacement();

    expect(await screen.findByText(tp('intro.llmUnavailable.title'))).toBeInTheDocument();
    expect(screen.getByText(tp('intro.llmUnavailable.description'))).toBeInTheDocument();
    expect(screen.getByText('LLM_BASE_URL is empty')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: tp('intro.start') })).not.toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('/placement'))).toBe(false);
  });
});

describe('слот ввода', () => {
  it('рендерит переданный ввод вместо текстового поля по умолчанию', async () => {
    const onSubmit = vi.fn();

    render(
      <I18nProvider>
        <PlacementChat
          history={[]}
          currentTurn={turn(0)}
          questionNumber={1}
          maxTurns={PLACEMENT_DEFAULT_MAX_TURNS}
          isAnswering={false}
          isFinishing={false}
          onSubmit={onSubmit}
          onFinish={vi.fn()}
          renderInput={({ onSubmit: submit, disabled }) => (
            <>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  submit('recognised speech');
                }}
              >
                Push to talk
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  submit('recognised speech', { source: 'voice', durationMs: 1200 });
                }}
              >
                Push to talk with metadata
              </button>
            </>
          )}
        />
      </I18nProvider>,
    );

    const user = userEvent.setup();
    const slotButton = screen.getByRole('button', { name: 'Push to talk' });

    expect(slotButton).toBeEnabled();
    expect(screen.queryByLabelText(tp('chat.input.label'))).not.toBeInTheDocument();

    await user.click(slotButton);

    expect(onSubmit).toHaveBeenCalledWith('recognised speech');

    // Голосовому вводу доступен необязательный второй аргумент с пометкой источника.
    await user.click(screen.getByRole('button', { name: 'Push to talk with metadata' }));

    expect(onSubmit).toHaveBeenLastCalledWith('recognised speech', {
      source: 'voice',
      durationMs: 1200,
    });
  });

  it('блокирует слот, пока ответ уходит на сервер', async () => {
    render(
      <I18nProvider>
        <PlacementChat
          history={[]}
          currentTurn={turn(0)}
          questionNumber={1}
          maxTurns={PLACEMENT_DEFAULT_MAX_TURNS}
          isAnswering
          isFinishing={false}
          onSubmit={vi.fn()}
          onFinish={vi.fn()}
          renderInput={({ disabled }) => (
            <button type="button" disabled={disabled}>
              Push to talk
            </button>
          )}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole('button', { name: 'Push to talk' })).toBeDisabled();

    // Состояние «тьютор думает» живёт в ленте с `aria-live`, а не рядом с кнопкой.
    const log = screen.getByRole('log');

    await waitFor(() => {
      expect(log).toHaveTextContent(tp('chat.thinking'));
    });
    expect(log).toHaveAttribute('aria-live', 'polite');
  });
});
