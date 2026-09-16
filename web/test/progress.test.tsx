/**
 * Раздел прогресса: сводка, лексика, журнал ошибок и история уровня.
 *
 * Сервер подменяется мок-`fetch`: тест проверяет интерфейс против контракта
 * `@lt/shared`, а не против живых маршрутов, и умеет отвечать на фильтры —
 * иначе «фильтр применился» нельзя отличить от «фильтр перерисовал то же самое».
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
  ERROR_CATEGORIES,
  KNOWN_LANGUAGE_CODES,
  LANGUAGE_LABELS,
  type AppConfig,
  type ErrorCategory,
  type ErrorLogEntry,
  type LevelHistoryEntry,
  type ProgressSummary,
  type VocabularyItem,
} from '@lt/shared';

import { App } from '../src/App';
import enProgress from '../src/i18n/locales/en/progress.json';
import ruProgress from '../src/i18n/locales/ru/progress.json';
import { i18n } from '../src/i18n';
import { routes } from '../src/router';

/** Конфигурация сервера: её запрашивает каркас приложения при старте. */
const CONFIG_FIXTURE: AppConfig = {
  appName: APP_NAME,
  apiPrefix: API_PREFIX,
  version: '0.1.0',
  configSource: 'env',
  llm: { available: true, model: 'qwen2.5', reason: null },
  stt: { provider: 'browser', available: true, model: null, requiresWav16: false, reason: null },
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

/** Обоснование повышения уровня: его ученик и должен увидеть. */
const PROMOTION_REASON = 'Three lessons in a row above 85 percent of correct answers.';

/** Обоснование первичной установки уровня тестом. */
const PLACEMENT_REASON = 'The placement test put the starting level at A2.';

/** Пояснение сервера, почему уровень сейчас не пересчитывается. */
const ELIGIBILITY_REASON = 'Two more completed lessons are needed before the next recalculation.';

/** Запись истории уровня с заполненными по умолчанию полями схемы. */
function levelChange(overrides: Partial<LevelHistoryEntry> = {}): LevelHistoryEntry {
  return {
    id: 'lh-2',
    fromLevel: 'A2',
    toLevel: 'B1',
    direction: 'up',
    source: 'progress',
    confidence: 0.8,
    reason: PROMOTION_REASON,
    metrics: {
      accuracy: 0.89,
      lessonsConsidered: 3,
      lessonsSinceLastChange: 4,
      exercisesEvaluated: 24,
      windowFrom: '2026-08-20T10:00:00.000Z',
      windowTo: '2026-09-10T10:00:00.000Z',
    },
    changedAt: '2026-09-10T10:00:00.000Z',
    createdAt: '2026-09-10T10:00:00.000Z',
    ...overrides,
  };
}

/** Первичная установка уровня тестом определения. */
const PLACEMENT_CHANGE: LevelHistoryEntry = levelChange({
  id: 'lh-1',
  fromLevel: null,
  toLevel: 'A2',
  direction: 'initial',
  source: 'placement',
  reason: PLACEMENT_REASON,
  metrics: {
    accuracy: 0.6,
    lessonsConsidered: 0,
    lessonsSinceLastChange: 0,
    exercisesEvaluated: 0,
    windowFrom: null,
    windowTo: null,
  },
  changedAt: '2026-08-01T10:00:00.000Z',
  createdAt: '2026-08-01T10:00:00.000Z',
});

/** Счётчики ошибок по всем пяти категориям. */
function counts(values: Partial<Record<ErrorCategory, number>>): Record<ErrorCategory, number> {
  return Object.fromEntries(
    ERROR_CATEGORIES.map((category) => [category, values[category] ?? 0]),
  ) as Record<ErrorCategory, number>;
}

/** Сводка прогресса ученика, который уже позанимался. */
function summaryFixture(overrides: Partial<ProgressSummary> = {}): ProgressSummary {
  return {
    level: 'B1',
    levelConfidence: 0.72,
    learningLanguage: 'en',
    lessonsCompleted: 12,
    lessonsInProgress: 1,
    lessonsSinceLevelChange: 4,
    practiceMinutes: 240,
    exercisesTotal: 80,
    exercisesCorrect: 68,
    accuracyOverall: 0.85,
    accuracyRecent: 0.88,
    streakDays: 3,
    longestStreakDays: 9,
    vocabulary: { total: 42, new: 10, learning: 20, known: 12 },
    errorsByCategory: counts({ grammar: 7, vocabulary: 4, pronunciation: 2, fluency: 1 }),
    recentActivity: [{ date: '2026-09-15', minutes: 20, lessons: 1, exercises: 6 }],
    levelEligibility: { canChange: false, lessonsUntilEligible: 2, reason: ELIGIBILITY_REASON },
    lastLevelChange: levelChange(),
    updatedAt: '2026-09-15T18:00:00.000Z',
    ...overrides,
  };
}

/** Сводка нового ученика: на пустой базе всё по нулям и без истории уровня. */
const EMPTY_SUMMARY: ProgressSummary = summaryFixture({
  level: DEFAULT_CEFR_LEVEL,
  levelConfidence: 0.3,
  lessonsCompleted: 0,
  lessonsInProgress: 0,
  lessonsSinceLevelChange: 0,
  practiceMinutes: 0,
  exercisesTotal: 0,
  exercisesCorrect: 0,
  accuracyOverall: 0,
  accuracyRecent: 0,
  streakDays: 0,
  longestStreakDays: 0,
  vocabulary: { total: 0, new: 0, learning: 0, known: 0 },
  errorsByCategory: counts({}),
  recentActivity: [],
  levelEligibility: {
    canChange: false,
    lessonsUntilEligible: 3,
    reason: 'Finish three lessons and the level will be re-estimated.',
  },
  lastLevelChange: null,
});

/** Слово личного словаря с заполненными по умолчанию полями схемы. */
function vocabularyItem(
  overrides: Partial<VocabularyItem> & Pick<VocabularyItem, 'id' | 'term'>,
): VocabularyItem {
  return {
    translation: 'перевод',
    language: 'en',
    translationLanguage: 'ru',
    partOfSpeech: null,
    transcription: null,
    example: null,
    level: 'B1',
    status: 'learning',
    timesSeen: 5,
    timesCorrect: 3,
    lessonId: 'lesson-1',
    materialId: null,
    firstSeenAt: '2026-09-01T10:00:00.000Z',
    lastSeenAt: '2026-09-12T10:00:00.000Z',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
    ...overrides,
  };
}

/** Запись журнала ошибок с заполненными по умолчанию полями схемы. */
function errorEntry(
  overrides: Partial<ErrorLogEntry> & Pick<ErrorLogEntry, 'id' | 'original'>,
): ErrorLogEntry {
  return {
    category: 'grammar',
    severity: 'minor',
    corrected: 'I have been there',
    explanation: 'Present perfect continuous keeps the auxiliary verb.',
    targetItem: null,
    language: 'en',
    lessonId: 'lesson-1',
    stepId: null,
    exerciseId: null,
    messageId: null,
    occurredAt: '2026-09-12T10:00:00.000Z',
    createdAt: '2026-09-12T10:00:00.000Z',
    ...overrides,
  };
}

/** Словарь из двенадцати слов: хватает на две страницы по десять. */
const VOCABULARY: VocabularyItem[] = [
  vocabularyItem({ id: 'v-1', term: 'bridge', status: 'learning' }),
  vocabularyItem({ id: 'v-2', term: 'alloy', status: 'new', lessonId: null }),
  vocabularyItem({ id: 'v-3', term: 'kettle', status: 'known' }),
  ...Array.from({ length: 9 }, (_, index) =>
    vocabularyItem({ id: `v-${index + 4}`, term: `word${index + 4}`, status: 'new' }),
  ),
];

/** Журнал ошибок трёх разных категорий. */
const ERRORS: ErrorLogEntry[] = [
  errorEntry({ id: 'e-1', original: 'I have been there yesterday', category: 'grammar' }),
  errorEntry({
    id: 'e-2',
    original: 'I did a mistake',
    category: 'grammar',
    severity: 'major',
    corrected: 'I made a mistake',
    explanation: 'The verb make goes with mistake.',
    occurredAt: '2026-09-11T10:00:00.000Z',
  }),
  errorEntry({
    id: 'e-3',
    original: 'sank you',
    category: 'pronunciation',
    corrected: 'thank you',
    explanation: 'The th sound is not an s sound.',
    lessonId: 'lesson-2',
    occurredAt: '2026-09-10T10:00:00.000Z',
  }),
  errorEntry({
    id: 'e-4',
    original: 'recieve',
    category: 'spelling',
    corrected: 'receive',
    explanation: 'I goes before e except after c.',
    lessonId: null,
    occurredAt: '2026-05-10T10:00:00.000Z',
  }),
];

/** Запрос, дошедший до подменённого `fetch`. */
interface FetchRecord {
  url: string;
  method: string;
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

/** Query-параметры запроса. */
function queryOf(url: string): URLSearchParams {
  return new URL(url, 'http://localhost').searchParams;
}

/** Страница словаря с учётом фильтров запроса: поиск, стадия и пагинация. */
function vocabularyPage(items: VocabularyItem[], url: string) {
  const query = queryOf(url);
  const limit = Number(query.get('limit') ?? '10');
  const offset = Number(query.get('offset') ?? '0');
  const status = query.get('status');
  const search = query.get('search');
  const filtered = items.filter(
    (item) =>
      (!status || item.status === status) &&
      (!search || item.term.includes(search) || item.translation.includes(search)),
  );
  const page = filtered.slice(offset, offset + limit);

  return {
    items: page,
    total: filtered.length,
    limit,
    offset,
    hasMore: offset + page.length < filtered.length,
  };
}

/**
 * Страница журнала с учётом фильтров запроса.
 *
 * `countsByCategory` фасетные: период учитывается, собственный фильтр категории —
 * нет, ровно как отвечает сервер.
 */
function errorsPage(entries: ErrorLogEntry[], url: string) {
  const query = queryOf(url);
  const limit = Number(query.get('limit') ?? '10');
  const offset = Number(query.get('offset') ?? '0');
  const category = query.get('category');
  const since = query.get('since');
  const inPeriod = entries.filter((entry) => !since || entry.occurredAt >= since);
  const filtered = inPeriod.filter((entry) => !category || entry.category === category);
  const page = filtered.slice(offset, offset + limit);

  return {
    items: page,
    total: filtered.length,
    limit,
    offset,
    hasMore: offset + page.length < filtered.length,
    countsByCategory: counts(
      Object.fromEntries(
        ERROR_CATEGORIES.map((value) => [
          value,
          inPeriod.filter((entry) => entry.category === value).length,
        ]),
      ),
    ),
  };
}

/** Страница истории уровня. */
function historyPage(entries: LevelHistoryEntry[], url: string) {
  const query = queryOf(url);
  const limit = Number(query.get('limit') ?? '10');
  const offset = Number(query.get('offset') ?? '0');
  const page = entries.slice(offset, offset + limit);

  return {
    items: page,
    total: entries.length,
    limit,
    offset,
    hasMore: offset + page.length < entries.length,
  };
}

/** Что отдаёт подменённый сервер на каждый из четырёх маршрутов прогресса. */
interface ProgressFixtures {
  summary?: ProgressSummary;
  vocabulary?: VocabularyItem[];
  errors?: ErrorLogEntry[];
  history?: LevelHistoryEntry[];
}

/** Подменяет `fetch` ответами прогресса; запросы запоминаются в `calls`. */
function stubProgressServer(fixtures: ProgressFixtures = {}): void {
  const {
    summary = summaryFixture(),
    vocabulary = VOCABULARY,
    errors = ERRORS,
    history = [levelChange(), PLACEMENT_CHANGE],
  } = fixtures;

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      calls.push({ url, method: init?.method ?? 'GET' });

      if (url.includes('/progress/summary')) {
        return Promise.resolve(jsonResponse(summary));
      }

      if (url.includes('/progress/vocabulary')) {
        return Promise.resolve(jsonResponse(vocabularyPage(vocabulary, url)));
      }

      if (url.includes('/progress/level-history')) {
        return Promise.resolve(jsonResponse(historyPage(history, url)));
      }

      if (url.includes('/progress/errors')) {
        return Promise.resolve(jsonResponse(errorsPage(errors, url)));
      }

      return Promise.resolve(jsonResponse(CONFIG_FIXTURE));
    }),
  );
}

/** Поднимает приложение на разделе прогресса, без истории браузера. */
function renderProgress() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: ['/progress'] });

  return {
    user: userEvent.setup(),
    ...render(<App router={router} queryClient={queryClient} />),
  };
}

/** Query-параметры последнего запроса к маршруту. */
function lastQuery(path: string): URLSearchParams {
  const call = [...calls].reverse().find((record) => record.url.includes(path));

  if (!call) {
    throw new Error(`Запроса к «${path}» не было`);
  }

  return queryOf(call.url);
}

/** Перевод ключа раздела прогресса на английском. */
function tr(key: string, options?: Record<string, unknown>): string {
  return i18n.t(`progress:${key}`, options ?? {});
}

/** Блок страницы по заголовку второго уровня. */
function blockOf(titleKey: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name: tr(titleKey) });
  const block = heading.closest('section');

  if (!block) {
    throw new Error(`Блок «${titleKey}» не найден на странице`);
  }

  return block;
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
  vi.restoreAllMocks();
});

describe('страница прогресса', () => {
  it('показывает все четыре блока: сводку, лексику, журнал ошибок и историю уровня', async () => {
    stubProgressServer();

    renderProgress();

    // Сводка: уровень, серия занятий и доля верных ответов.
    expect(
      await screen.findByText(
        tr('summary.levelValue', { level: 'B1', name: i18n.t('profile:level.names.B1') }),
      ),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('heading', { level: 2, name: tr('summary.title') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: tr('vocabulary.title') }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: tr('errors.title') })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: tr('timeline.title') }),
    ).toBeInTheDocument();

    const summaryBlock = blockOf('summary.title');
    expect(within(summaryBlock).getByText(tr('summary.days', { count: 3 }))).toBeInTheDocument();
    expect(within(summaryBlock).getByText('85%')).toBeInTheDocument();

    // Лексика: слово из словаря и ссылка на урок, где оно встретилось.
    const vocabularyBlock = await screen.findByRole('region', { name: tr('vocabulary.title') });

    expect(within(vocabularyBlock).getByRole('table')).toBeInTheDocument();
    expect(within(vocabularyBlock).getByText('bridge')).toBeInTheDocument();
    expect(
      within(vocabularyBlock).getAllByRole('link', { name: tr('vocabulary.lessonLink') })[0],
    ).toHaveAttribute('href', '/lessons/lesson-1/plan');

    // Журнал: группа по категории, фрагмент, исправление и объяснение.
    const errorsBlock = await screen.findByRole('region', { name: tr('errors.title') });

    expect(
      within(errorsBlock).getByRole('table', {
        name: new RegExp(tr('errors.category.grammar')),
      }),
    ).toBeInTheDocument();
    expect(within(errorsBlock).getByText('I did a mistake')).toBeInTheDocument();
    expect(within(errorsBlock).getByText('I made a mistake')).toBeInTheDocument();
    expect(within(errorsBlock).getByText('The verb make goes with mistake.')).toBeInTheDocument();

    // История уровня: лента с источником изменения.
    const timelineBlock = await screen.findByRole('region', { name: tr('timeline.title') });

    expect(
      within(timelineBlock).getByRole('list', { name: tr('timeline.listLabel') }),
    ).toBeInTheDocument();
    expect(within(timelineBlock).getByText(tr('level.source.progress'))).toBeInTheDocument();
    expect(within(timelineBlock).getByText(tr('level.source.placement'))).toBeInTheDocument();
  });

  it('объясняет, почему уровень изменился: показывает reason и источник изменения', async () => {
    stubProgressServer();

    renderProgress();

    // Обоснование последнего изменения видно и в сводке, и в ленте истории.
    await waitFor(() => {
      expect(screen.getAllByText(PROMOTION_REASON)).toHaveLength(2);
    });

    const summaryBlock = blockOf('summary.title');

    expect(within(summaryBlock).getByText(PROMOTION_REASON)).toBeInTheDocument();
    expect(within(summaryBlock).getByText(tr('level.direction.up'))).toBeInTheDocument();
    expect(within(summaryBlock).getByText(tr('level.source.progress'))).toBeInTheDocument();

    // Готовность к пересчёту объяснена словами сервера и правилами политики.
    expect(within(summaryBlock).getByText(ELIGIBILITY_REASON)).toBeInTheDocument();
    expect(within(summaryBlock).getByText(tr('level.eligibility.cannot'))).toBeInTheDocument();
    expect(
      within(summaryBlock).getByText(tr('level.eligibility.remaining', { count: 2 })),
    ).toBeInTheDocument();

    // Первичная установка уровня подписана как определённая тестом.
    const timelineBlock = screen.getByRole('region', { name: tr('timeline.title') });

    expect(within(timelineBlock).getByText(PLACEMENT_REASON)).toBeInTheDocument();
    expect(within(timelineBlock).getByText(tr('level.source.placement'))).toBeInTheDocument();
  });
});

describe('фильтры лексики', () => {
  it('отправляет стадию, сортировку и поиск в параметрах запроса', async () => {
    stubProgressServer();

    const { user } = renderProgress();

    await screen.findByText('bridge');

    expect(lastQuery('/progress/vocabulary').get('sort')).toBe('recent');
    expect(lastQuery('/progress/vocabulary').get('order')).toBe('desc');
    expect(lastQuery('/progress/vocabulary').has('status')).toBe(false);

    await user.selectOptions(screen.getByLabelText(tr('vocabulary.statusLabel')), 'learning');

    await waitFor(() => {
      expect(lastQuery('/progress/vocabulary').get('status')).toBe('learning');
    });

    await user.selectOptions(screen.getByLabelText(tr('vocabulary.sortLabel')), 'alphabetical');

    await waitFor(() => {
      const query = lastQuery('/progress/vocabulary');

      expect(query.get('sort')).toBe('alphabetical');
      // У алфавитной сортировки естественное направление другое.
      expect(query.get('order')).toBe('asc');
      expect(query.get('status')).toBe('learning');
    });

    await user.type(screen.getByLabelText(tr('vocabulary.searchLabel')), 'bridge');
    await user.click(screen.getByRole('button', { name: tr('vocabulary.searchSubmit') }));

    await waitFor(() => {
      expect(lastQuery('/progress/vocabulary').get('search')).toBe('bridge');
    });
  });

  it('листает словарь постранично через смещение запроса', async () => {
    stubProgressServer();

    const { user } = renderProgress();

    await screen.findByText('bridge');

    expect(lastQuery('/progress/vocabulary').get('offset')).toBe('0');

    const vocabularyBlock = screen.getByRole('region', { name: tr('vocabulary.title') });

    await user.click(
      within(vocabularyBlock).getByRole('button', { name: tr('vocabulary.nextPage') }),
    );

    await waitFor(() => {
      expect(lastQuery('/progress/vocabulary').get('offset')).toBe('10');
    });
    expect(await screen.findByText('word12')).toBeInTheDocument();
  });
});

describe('фильтры журнала ошибок', () => {
  it('отправляет категорию и период в параметрах запроса', async () => {
    stubProgressServer();

    const { user } = renderProgress();

    await screen.findByText('I did a mistake');

    expect(lastQuery('/progress/errors').has('category')).toBe(false);
    expect(lastQuery('/progress/errors').has('since')).toBe(false);

    await user.click(
      screen.getByRole('button', {
        name: tr('errors.categoryOption', {
          category: tr('errors.category.pronunciation'),
          count: 1,
        }),
      }),
    );

    await waitFor(() => {
      expect(lastQuery('/progress/errors').get('category')).toBe('pronunciation');
    });
    expect(await screen.findByText('sank you')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(tr('errors.periodLabel')), 'week');

    await waitFor(() => {
      const since = lastQuery('/progress/errors').get('since');

      expect(since).not.toBeNull();
      // Неделя назад с точностью до суток: значение считается в момент выбора.
      const days = (Date.now() - new Date(since ?? '').getTime()) / (24 * 60 * 60 * 1000);

      expect(days).toBeGreaterThan(6.5);
      expect(days).toBeLessThan(7.5);
    });
  });

  it('оставляет переключатели соседних категорий доступными при выбранной категории', async () => {
    stubProgressServer();

    const { user } = renderProgress();

    await screen.findByText('I did a mistake');

    const grammarChip = screen.getByRole('button', {
      name: tr('errors.categoryOption', { category: tr('errors.category.grammar'), count: 2 }),
    });

    await user.click(grammarChip);

    await waitFor(() => {
      expect(lastQuery('/progress/errors').get('category')).toBe('grammar');
    });
    expect(grammarChip).toHaveAttribute('aria-pressed', 'true');

    // Счётчики фасетные: соседние категории остались ненулевыми и кликабельными.
    const pronunciationChip = screen.getByRole('button', {
      name: tr('errors.categoryOption', {
        category: tr('errors.category.pronunciation'),
        count: 1,
      }),
    });

    expect(pronunciationChip).toBeEnabled();
    expect(pronunciationChip).toHaveAttribute('aria-pressed', 'false');

    await user.click(pronunciationChip);

    await waitFor(() => {
      expect(lastQuery('/progress/errors').get('category')).toBe('pronunciation');
    });
    expect(await screen.findByText('sank you')).toBeInTheDocument();
  });
});

describe('новый ученик', () => {
  it('показывает заглушки во всех блоках и ничего не ломает на пустых данных', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    stubProgressServer({
      summary: EMPTY_SUMMARY,
      vocabulary: [],
      errors: [],
      history: [],
    });

    renderProgress();

    expect(await screen.findByText(tr('summary.empty'))).toBeInTheDocument();
    expect(screen.getByText(tr('summary.errorsEmpty'))).toBeInTheDocument();
    expect(screen.getByText(tr('level.noChange'))).toBeInTheDocument();
    expect(await screen.findByText(tr('vocabulary.empty'))).toBeInTheDocument();
    expect(await screen.findByText(tr('errors.empty'))).toBeInTheDocument();
    expect(await screen.findByText(tr('timeline.empty'))).toBeInTheDocument();

    // Пустая база — не ошибка: баннеров отказа на странице быть не должно.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('отказ сервера', () => {
  it('сообщает об ошибке каждого блока и предлагает повторить запрос', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        String(input).includes('/progress')
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve(jsonResponse(CONFIG_FIXTURE)),
      ),
    );

    renderProgress();

    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(4);
    });
    expect(screen.getByText(tr('summary.error'))).toBeInTheDocument();
    expect(screen.getByText(tr('vocabulary.error'))).toBeInTheDocument();
    expect(screen.getByText(tr('errors.error'))).toBeInTheDocument();
    expect(screen.getByText(tr('timeline.error'))).toBeInTheDocument();
    expect(screen.getAllByText(i18n.t('errors.network')).length).toBeGreaterThanOrEqual(4);
  });
});

describe('переводы раздела', () => {
  it('содержат одинаковые ключи в английском и русском словарях', () => {
    expect(flatKeys(ruProgress)).toEqual(flatKeys(enProgress));
  });
});

/** Суффиксы форм множественного числа: в русском их больше, чем в английском. */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** Плоский отсортированный список ключей словаря без суффиксов множественного числа. */
function flatKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) {
    return [prefix.replace(PLURAL_SUFFIX, '')];
  }

  return [
    ...new Set(
      Object.entries(value).flatMap(([key, nested]) =>
        flatKeys(nested, prefix ? `${prefix}.${key}` : key),
      ),
    ),
  ].sort();
}
