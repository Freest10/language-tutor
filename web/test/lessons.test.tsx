/**
 * Раздел уроков: список, диалог создания с генерацией плана и страница плана.
 *
 * Сервер подменяется мок-`fetch`: бэкенд уроков пишется параллельно, поэтому
 * тест проверяет интерфейс против контракта `@lt/shared`, а не против маршрутов.
 */
import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  type CreateLessonRequest,
  type Lesson,
  type LessonPlanStep,
  type Material,
  type RegenerateLessonPlanRequest,
} from '@lt/shared';

import { App } from '../src/App';
import { i18n } from '../src/i18n';
import { createQueryClient } from '../src/lib/queryClient';
import { lessonPlanPath, lessonRoomPath, routes } from '../src/router';

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

/** Шаг плана с заполненными по умолчанию полями схемы. */
function step(
  overrides: Partial<LessonPlanStep> & Pick<LessonPlanStep, 'id' | 'order' | 'title'>,
): LessonPlanStep {
  return {
    lessonId: 'l-1',
    type: 'speaking',
    objectives: ['Ask for directions'],
    targetItems: ['turn left', 'go straight'],
    instructions: 'Play a short dialogue with the learner.',
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
    status: 'draft',
    learningLanguage: 'en',
    explanationLanguage: 'ru',
    level: 'B1',
    topic: 'Travelling',
    goals: ['travel'],
    materialIds: [],
    plan: [],
    currentStepId: null,
    plannedMinutes: 30,
    summary: null,
    startedAt: null,
    completedAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

/** Материал с заполненными по умолчанию полями схемы. */
function material(overrides: Partial<Material> & Pick<Material, 'id' | 'title'>): Material {
  return {
    sourceType: 'txt',
    status: 'ready',
    statusMessage: null,
    originalFileName: 'notes.txt',
    mimeType: 'text/plain',
    sizeBytes: 2048,
    language: 'en',
    level: 'B1',
    charCount: 1200,
    chunkCount: 3,
    pageCount: null,
    topics: [],
    summary: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

/** Страница списочного ответа. */
function listPage<Item>(items: Item[]) {
  return { items, total: items.length, limit: 20, offset: 0, hasMore: false };
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

/** Прокручивает фейковые таймеры и даёт ответам подменённого `fetch` долететь. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Ждёт выполнения проверки, прокручивая фейковые таймеры мелким шагом.
 *
 * `waitFor` из testing-library распознаёт фейковые таймеры по глобальному
 * `jest`, а в проекте `globals: false` и такого глобала нет.
 */
async function settle(check: () => void, attempts = 60): Promise<void> {
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    try {
      check();

      return;
    } catch {
      await tick(10);
    }
  }

  check();
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

/**
 * Поднимает приложение на нужном адресе, без истории браузера.
 *
 * @param path начальный адрес.
 * @param queryClient клиент запросов; по умолчанию — без повторов и без
 *   времени свежести, чтобы тест не зависел от таймингов кэша.
 */
function renderApp(
  path: string,
  queryClient: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });

  return {
    user: userEvent.setup(),
    ...render(<App router={router} queryClient={queryClient} />),
  };
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

describe('список уроков', () => {
  it('показывает урок и ведёт в комнату урока и в его план', async () => {
    const lessons = [
      lesson({
        id: 'l-1',
        title: 'Small talk at the airport',
        status: 'in_progress',
        plan: [step({ id: 's-1', order: 0, title: 'Warm-up' })],
      }),
    ];

    stubFetch((record) => {
      if (record.path.endsWith('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      return jsonResponse(listPage(lessons));
    });

    renderApp('/lessons');

    const heading = await screen.findByRole('heading', {
      level: 3,
      name: 'Small talk at the airport',
    });
    const row = heading.closest('li');

    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).getByRole('link', {
        name: i18n.t('lessons:list.actions.continue'),
      }),
    ).toHaveAttribute('href', lessonRoomPath('l-1'));
    expect(
      within(row as HTMLElement).getByRole('link', {
        name: i18n.t('lessons:list.actions.openPlan'),
      }),
    ).toHaveAttribute('href', lessonPlanPath('l-1'));
  });

  it('в пустом списке предлагает создать первый урок', async () => {
    stubFetch((record) => {
      if (record.path.endsWith('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      return jsonResponse(listPage<Lesson>([]));
    });

    const { user } = renderApp('/lessons');

    const create = await screen.findByRole('button', { name: i18n.t('lessons:list.empty.action') });

    expect(screen.getByText(i18n.t('lessons:list.empty.description'))).toBeInTheDocument();

    await user.click(create);

    expect(await screen.findByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });
});

describe('создание урока', () => {
  /** Материалы выбора: обработанный и скан PDF без текстового слоя. */
  const MATERIALS = [
    material({ id: 'm-1', title: 'Weekly news' }),
    material({
      id: 'm-2',
      title: 'Scanned textbook',
      sourceType: 'pdf',
      status: 'error_no_text_layer',
      statusMessage: 'No text layer found on 12 pages.',
    }),
  ];

  /** Урок, который присылает сервер в ответ на создание. */
  const CREATED = lesson({
    id: 'l-10',
    title: 'Talking about the news',
    materialIds: ['m-1'],
    plannedMinutes: 45,
    plan: [
      step({ id: 's-1', lessonId: 'l-10', order: 0, title: 'Warm-up', type: 'warmup' }),
      step({ id: 's-2', lessonId: 'l-10', order: 1, title: 'Discussion', type: 'speaking' }),
    ],
  });

  /** Обработчик запросов раздела: список пуст, создание отдаёт `CREATED`. */
  function stubCreate(createResponse: (record: FetchRecord) => Response | Promise<Response>): void {
    stubFetch((record) => {
      if (record.path.endsWith('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      if (record.path === `${API_PREFIX}/materials`) {
        return jsonResponse(listPage(MATERIALS));
      }

      if (record.path === `${API_PREFIX}/lessons` && record.method === 'POST') {
        return createResponse(record);
      }

      if (record.path === `${API_PREFIX}/lessons/l-10`) {
        return jsonResponse({ lesson: CREATED, exercises: [], attempts: [] });
      }

      return jsonResponse(listPage<Lesson>([]));
    });
  }

  /** Открывает диалог и заполняет форму: материал, акцент и длительность. */
  async function fillForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole('button', { name: i18n.t('lessons:create.open') }));
    await user.click(await screen.findByRole('checkbox', { name: 'Weekly news' }));
    await user.click(
      screen.getByRole('checkbox', { name: i18n.t('lessons:stepTypes.speaking.label') }),
    );
    await user.click(
      screen.getByRole('radio', { name: i18n.t('common:units.minutes', { count: 45 }) }),
    );
  }

  it('отправляет выбранные материалы, акценты и длительность и открывает план', async () => {
    stubCreate(() => jsonResponse(CREATED, 201));

    const { user } = renderApp('/lessons');

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: i18n.t('lessons:create.submit') }));

    expect(
      await screen.findByRole('heading', { level: 1, name: i18n.t('lessons:plan.title') }),
    ).toBeInTheDocument();

    const sent = bodyOf<CreateLessonRequest>(lastCall('POST', '/lessons'));

    expect(sent.materialIds).toEqual(['m-1']);
    expect(sent.focus).toEqual(['speaking']);
    expect(sent.durationMinutes).toBe(45);

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Talking about the news' }),
    ).toBeInTheDocument();
  });

  it('не перечитывает только что созданный урок при открытии плана', async () => {
    stubCreate(() => jsonResponse(CREATED, 201));

    // Клиент приложения, а не «без кэша»: именно на нём видно лишний запрос.
    const { user } = renderApp('/lessons', createQueryClient());

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: i18n.t('lessons:create.submit') }));

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Talking about the news' }),
    ).toBeInTheDocument();

    // Урок пришёл в ответе на создание и лежит в кэше целиком: страница плана
    // обязана открыться без `GET /api/lessons/:id`. Инвалидация всего namespace
    // `['lessons']` пометила бы и его — и запрос ушёл бы при монтировании.
    expect(callsTo('GET', '/lessons/l-10')).toHaveLength(0);
    // Список при этом перечитывается: в нём появился новый урок.
    expect(callsTo('GET', '/lessons').length).toBeGreaterThan(1);
  });

  it('пока модель думает, показывает ожидание и блокирует повторную отправку', async () => {
    const pending = deferred<Response>();

    stubCreate(() => pending.promise);

    const { user } = renderApp('/lessons');

    await fillForm(user);

    const submit = screen.getByRole('button', { name: i18n.t('lessons:create.submit') });

    await user.click(submit);

    const status = await screen.findByText(i18n.t('lessons:create.generating.title'));

    expect(status).toHaveAttribute('role', 'status');
    expect(screen.getByText(i18n.t('lessons:create.generating.description'))).toBeInTheDocument();
    expect(submit).toBeDisabled();

    pending.resolve(jsonResponse(CREATED, 201));

    expect(
      await screen.findByRole('heading', { level: 1, name: i18n.t('lessons:plan.title') }),
    ).toBeInTheDocument();
  });

  it('на 501 объясняет, что модель не настроена, а не показывает общий текст', async () => {
    stubCreate(() => errorResponse('not_configured', 501));

    const { user } = renderApp('/lessons');

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: i18n.t('lessons:create.submit') }));

    expect(await screen.findByText(i18n.t('lessons:errors.notConfigured'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('lessons:errors.setupHint'))).toBeInTheDocument();
    expect(
      screen.queryByText(i18n.t('common:errors.byCode.not_configured')),
    ).not.toBeInTheDocument();
    // Отказ модели не уводит со списка уроков: форма остаётся заполненной.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('на 503 советует запустить модель, а не править конфигурацию', async () => {
    // Регрессия: на все отказы модели показывалась одна подсказка «задайте в .env
    // LLM_PROVIDER» — переменной с таким именем в проекте нет вовсе, а при 503
    // конфигурация обычно в порядке и модель просто не запущена. Пользователь шёл
    // искать несуществующий ключ вместо того, чтобы поднять Ollama.
    stubCreate(() => errorResponse('upstream_unavailable', 503));

    const { user } = renderApp('/lessons');

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: i18n.t('lessons:create.submit') }));

    expect(
      await screen.findByText(i18n.t('lessons:errors.upstreamUnavailable')),
    ).toBeInTheDocument();
    expect(screen.getByText(i18n.t('lessons:errors.startHint'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('lessons:errors.setupHint'))).not.toBeInTheDocument();
  });

  it('ни одна подсказка не отправляет к несуществующей переменной окружения', () => {
    // Подсказка обязана называть только те переменные, которые есть в .env.example.
    for (const locale of ['ru', 'en'] as const) {
      for (const key of ['setupHint', 'startHint', 'retryHint'] as const) {
        const text = i18n.getFixedT(locale, 'lessons')(`errors.${key}`);

        expect(text).not.toMatch(/LLM_PROVIDER/);
      }
    }
  });

  it('на 400 перечисляет материалы, у которых ещё нет текста', async () => {
    stubCreate(() =>
      jsonResponse(
        {
          error: {
            code: 'bad_request',
            message: 'Materials are not ready',
            details: {
              reason: 'materials_not_ready',
              materials: [
                {
                  id: 'm-2',
                  title: 'Scanned textbook',
                  status: 'error_no_text_layer',
                  statusMessage: 'No text layer found on 12 pages.',
                  chunkCount: 0,
                },
              ],
            },
          },
        } satisfies ApiErrorResponse,
        400,
      ),
    );

    const { user } = renderApp('/lessons');

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: i18n.t('lessons:create.submit') }));

    const failure = await screen.findByText(i18n.t('lessons:errors.materialsNotReady'));
    const banner = failure.closest('div');

    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('Scanned textbook');
    expect(banner?.textContent).toContain(
      i18n.t('lessons:materials.status.error_no_text_layer.label'),
    );
    expect(banner?.textContent).toContain('No text layer found on 12 pages.');
    // Урок не создан: диалог остаётся открытым, а выбор материалов — заполненным.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Weekly news' })).toBeChecked();
  });

  it('закрывается по Escape и возвращает фокус на кнопку открытия', async () => {
    stubCreate(() => jsonResponse(CREATED, 201));

    const { user } = renderApp('/lessons');
    const open = await screen.findByRole('button', { name: i18n.t('lessons:create.open') });

    await user.click(open);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(open).toHaveFocus();
  });
});

describe('выбор материалов', () => {
  it('не даёт выбрать скан PDF и объясняет причину', async () => {
    stubFetch((record) => {
      if (record.path.endsWith('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      if (record.path === `${API_PREFIX}/materials`) {
        return jsonResponse(
          listPage([
            material({ id: 'm-1', title: 'Weekly news' }),
            material({
              id: 'm-2',
              title: 'Scanned textbook',
              sourceType: 'pdf',
              status: 'error_no_text_layer',
              statusMessage: 'No text layer found on 12 pages.',
            }),
          ]),
        );
      }

      return jsonResponse(listPage<Lesson>([]));
    });

    const { user } = renderApp('/lessons');

    await user.click(await screen.findByRole('button', { name: i18n.t('lessons:create.open') }));

    const scan = await screen.findByRole('checkbox', { name: 'Scanned textbook' });
    const row = scan.closest('li');

    expect(scan).toBeDisabled();
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).getByText(
        i18n.t('lessons:materials.status.error_no_text_layer.label'),
      ),
    ).toBeInTheDocument();
    // Причина недоступности и пояснение сервера лежат в подписи к полю.
    expect(row?.textContent).toContain(i18n.t('lessons:materials.status.error_no_text_layer.hint'));
    expect(row?.textContent).toContain('No text layer found on 12 pages.');
    // Пояснение связано с чекбоксом: экранная читалка прочитает его вместе с названием.
    const describedBy = scan.getAttribute('aria-describedby');

    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? '')?.textContent).toContain(
      i18n.t('lessons:materials.status.error_no_text_layer.hint'),
    );

    expect(await screen.findByRole('checkbox', { name: 'Weekly news' })).toBeEnabled();
  });

  it('сам перечитывает список, пока скан обрабатывается', async () => {
    // Скан распознаётся в фоне минутами. Без опроса пользователь, загрузивший
    // материал и сразу открывший создание урока, видел бы выключённый чекбокс
    // «обрабатывается» до перезагрузки страницы.
    let status: 'processing' | 'ready' = 'processing';

    stubFetch((record) => {
      if (record.path.endsWith('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      if (record.path === `${API_PREFIX}/materials`) {
        return jsonResponse(
          listPage([
            material({
              id: 'm-9',
              title: 'Scanned textbook',
              sourceType: 'pdf',
              status,
              statusMessage: status === 'processing' ? 'Page 3 of 48.' : null,
              chunkCount: status === 'ready' ? 120 : 0,
            }),
          ]),
        );
      }

      return jsonResponse(listPage([]));
    });

    // Фейковые таймеры включаются ДО монтирования: иначе react-query заведёт
    // интервал опроса на настоящем таймере, и прокрутка фейкового его не тронет.
    // userEvent с фейковыми таймерами зависает, поэтому кликаем fireEvent.
    vi.useFakeTimers();

    try {
      renderApp('/lessons');

      await settle(() =>
        expect(screen.getByRole('button', { name: i18n.t('lessons:create.open') })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole('button', { name: i18n.t('lessons:create.open') }));

      await settle(() =>
        expect(screen.getByRole('checkbox', { name: /Scanned textbook/ })).toBeDisabled(),
      );

      const before = callsTo('GET', '/materials').length;

      status = 'ready';

      await tick(3000);

      // Опрос действительно сходил на сервер и чекбокс стал доступен сам.
      expect(callsTo('GET', '/materials').length).toBeGreaterThan(before);
      await settle(() =>
        expect(screen.getByRole('checkbox', { name: /Scanned textbook/ })).toBeEnabled(),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('план урока', () => {
  /** Урок с планом, присланным в перемешанном порядке. */
  const PLANNED = lesson({
    id: 'l-1',
    title: 'Talking about the news',
    materialIds: ['m-1'],
    plan: [
      step({ id: 's-3', order: 2, title: 'Wrap-up', type: 'wrapup', estimatedMinutes: 5 }),
      step({ id: 's-1', order: 0, title: 'Warm-up', type: 'warmup', estimatedMinutes: 5 }),
      step({
        id: 's-2',
        order: 1,
        title: 'Discussion',
        type: 'speaking',
        targetItems: ['headline', 'to be into something'],
        materialChunkIds: ['c-1', 'c-2'],
      }),
    ],
  });

  /** Заголовки этапов в порядке отрисовки. */
  function stepTitles(): string[] {
    return screen
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent ?? '')
      .filter((title) =>
        title.startsWith(i18n.t('lessons:plan.steps.order', { number: 1 }).slice(0, 4)),
      );
  }

  it('рисует этапы по порядку order с целями, лексикой и минутами', async () => {
    stubFetch((record) => {
      if (record.path.endsWith('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      return jsonResponse({ lesson: PLANNED, exercises: [], attempts: [] });
    });

    renderApp(lessonPlanPath('l-1'));

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Talking about the news' }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(stepTitles()).toEqual([
        `${i18n.t('lessons:plan.steps.order', { number: 1 })} Warm-up`,
        `${i18n.t('lessons:plan.steps.order', { number: 2 })} Discussion`,
        `${i18n.t('lessons:plan.steps.order', { number: 3 })} Wrap-up`,
      ]);
    });

    const discussion = screen
      .getByRole('heading', { level: 3, name: /Discussion/ })
      .closest('li') as HTMLElement;

    expect(within(discussion).getByText('headline')).toBeInTheDocument();
    expect(
      within(discussion).getByText(i18n.t('lessons:stepTypes.speaking.label')),
    ).toBeInTheDocument();
    expect(
      within(discussion).getByText(new RegExp(i18n.t('lessons:plan.steps.chunks', { count: 2 }))),
    ).toBeInTheDocument();
  });

  it('кнопка «начать урок» ведёт в комнату урока', async () => {
    stubFetch((record) => {
      if (record.path.endsWith('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      return jsonResponse({ lesson: PLANNED, exercises: [], attempts: [] });
    });

    renderApp(lessonPlanPath('l-1'));

    expect(
      await screen.findByRole('link', { name: i18n.t('lessons:plan.actions.start') }),
    ).toHaveAttribute('href', lessonRoomPath('l-1'));
  });

  it('перегенерация отправляет комментарий и обновляет план', async () => {
    const regenerated = {
      ...PLANNED,
      plan: [
        step({ id: 's-9', order: 0, title: 'More speaking', type: 'speaking' }),
        step({ id: 's-10', order: 1, title: 'Feedback', type: 'wrapup' }),
      ],
    } satisfies Lesson;
    let current: Lesson = PLANNED;

    stubFetch((record) => {
      if (record.path.endsWith('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      if (record.path === `${API_PREFIX}/lessons/l-1/plan/regenerate`) {
        current = regenerated;

        return jsonResponse(regenerated);
      }

      return jsonResponse({ lesson: current, exercises: [], attempts: [] });
    });

    const { user } = renderApp(lessonPlanPath('l-1'));

    const feedback = await screen.findByLabelText(i18n.t('lessons:plan.regenerate.feedback.label'));

    await user.type(feedback, 'More speaking, less grammar');
    await user.click(
      screen.getByRole('button', { name: i18n.t('lessons:plan.regenerate.submit') }),
    );

    expect(
      await screen.findByRole('heading', { level: 3, name: /More speaking/ }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { level: 3, name: /Discussion/ }),
      ).not.toBeInTheDocument();
    });

    const sent = bodyOf<RegenerateLessonPlanRequest>(
      lastCall('POST', '/lessons/l-1/plan/regenerate'),
    );

    expect(sent.feedback).toBe('More speaking, less grammar');
    expect(sent.keepCompletedSteps).toBe(true);
  });

  it('на 503 сообщает, что модель недоступна', async () => {
    stubFetch((record) => {
      if (record.path.endsWith('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      if (record.path === `${API_PREFIX}/lessons/l-1/plan/regenerate`) {
        return errorResponse('upstream_unavailable', 503);
      }

      return jsonResponse({ lesson: PLANNED, exercises: [], attempts: [] });
    });

    const { user } = renderApp(lessonPlanPath('l-1'));

    await user.click(
      await screen.findByRole('button', { name: i18n.t('lessons:plan.regenerate.submit') }),
    );

    expect(
      await screen.findByText(i18n.t('lessons:errors.upstreamUnavailable')),
    ).toBeInTheDocument();
  });

  it('на 409 говорит, что завершённый урок не пересобрать', async () => {
    stubFetch((record) => {
      if (record.path.endsWith('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      if (record.path === `${API_PREFIX}/lessons/l-1/plan/regenerate`) {
        return jsonResponse(
          {
            error: {
              code: 'conflict',
              message: 'Lesson is completed',
              details: { reason: 'lesson_completed' },
            },
          } satisfies ApiErrorResponse,
          409,
        );
      }

      return jsonResponse({ lesson: PLANNED, exercises: [], attempts: [] });
    });

    const { user } = renderApp(lessonPlanPath('l-1'));

    await user.click(
      await screen.findByRole('button', { name: i18n.t('lessons:plan.regenerate.submit') }),
    );

    expect(await screen.findByText(i18n.t('lessons:errors.lessonCompleted'))).toBeInTheDocument();
  });

  it('у завершённого урока не предлагает пересобрать план', async () => {
    stubFetch((record) => {
      if (record.path.endsWith('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      return jsonResponse({
        lesson: { ...PLANNED, status: 'completed' },
        exercises: [],
        attempts: [],
      });
    });

    renderApp(lessonPlanPath('l-1'));

    expect(await screen.findByText(i18n.t('lessons:errors.lessonCompleted'))).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: i18n.t('lessons:plan.regenerate.submit') }),
    ).not.toBeInTheDocument();
  });

  it('404 объясняет, что урока нет', async () => {
    stubFetch((record) => {
      if (record.path.endsWith('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      return errorResponse('not_found', 404);
    });

    renderApp(lessonPlanPath('l-404'));

    expect(await screen.findByText(i18n.t('lessons:plan.errors.notFound'))).toBeInTheDocument();
  });
});
