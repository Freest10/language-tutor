/**
 * Итог урока: что получилось, как это отразилось на уровне и куда идти дальше.
 *
 * Экран собирается из готовых данных сервера, поэтому поднимается напрямую,
 * без роутера приложения и мок-`fetch`: проверять здесь нужно представление
 * итога, а не путь запроса. Из провайдеров нужны только переводы и маршруты —
 * итог ссылается на раздел прогресса и на список уроков.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ErrorLogEntry,
  LessonSummary as LessonSummaryData,
  LevelHistoryEntry,
  VocabularyItem,
} from '@lt/shared';

import { i18n } from '../src/i18n';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { LessonSummary } from '../src/features/lessonRoom/LessonSummary';
import { ROUTE_PATHS } from '../src/router';

/** Перевод ключа из namespace комнаты урока. */
function roomText(key: string, params?: Record<string, unknown>): string {
  return i18n.t(`lessonRoom:${key}`, params ?? {});
}

/** Итог урока с заполненными по умолчанию полями схемы. */
function summary(overrides: Partial<LessonSummaryData> = {}): LessonSummaryData {
  return {
    text: 'You told a long story about the weekend and kept the past simple almost everywhere.',
    strengths: ['Confident vocabulary about travelling', 'Long sentences without long pauses'],
    weaknesses: ['Irregular verbs in the past simple'],
    recommendations: ['Retell the same story in the past simple once more'],
    newVocabulary: ['lake', 'to hike'],
    exercisesTotal: 16,
    exercisesCorrect: 13,
    accuracy: 0.8125,
    durationMinutes: 27,
    ...overrides,
  };
}

/** Обоснование повышения уровня: без него автокоррекция выглядит произволом. */
const PROMOTION_REASON = 'Three lessons in a row above 85 percent of correct answers.';

/** Запись истории уровня с заполненными по умолчанию полями схемы. */
function levelChange(overrides: Partial<LevelHistoryEntry> = {}): LevelHistoryEntry {
  return {
    id: 'lh-7',
    fromLevel: 'B1',
    toLevel: 'B2',
    direction: 'up',
    source: 'progress',
    confidence: 0.82,
    reason: PROMOTION_REASON,
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
    ...overrides,
  };
}

/** Слово личного словаря с заполненными по умолчанию полями схемы. */
function vocabularyItem(
  overrides: Partial<VocabularyItem> & Pick<VocabularyItem, 'id' | 'term' | 'translation'>,
): VocabularyItem {
  return {
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
    ...overrides,
  };
}

/** Запись журнала ошибок с заполненными по умолчанию полями схемы. */
function errorEntry(
  overrides: Partial<ErrorLogEntry> & Pick<ErrorLogEntry, 'id' | 'original' | 'explanation'>,
): ErrorLogEntry {
  return {
    category: 'grammar',
    severity: 'major',
    corrected: '',
    targetItem: 'past simple',
    language: 'en',
    lessonId: 'l-1',
    stepId: 's-1',
    exerciseId: null,
    messageId: 'm-2',
    occurredAt: '2026-09-01T10:20:00.000Z',
    createdAt: '2026-09-01T10:20:00.000Z',
    ...overrides,
  };
}

/** Поднимает итог урока в тех же провайдерах, что и приложение. */
function renderSummary(ui: Parameters<typeof render>[0]) {
  return render(
    <I18nProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </I18nProvider>,
  );
}

/** Карточка итога целиком: внутри неё и ищем. */
function summaryCard(): HTMLElement {
  return screen.getByRole('region', { name: roomText('summary.title') });
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  // При `globals: false` автоматической очистки DOM нет — убираем её вручную.
  cleanup();
});

describe('итог урока', () => {
  it('показывает текст итога, разборы и числа урока', () => {
    const data = summary();

    renderSummary(<LessonSummary summary={data} />);

    const card = summaryCard();

    expect(within(card).getByText(data.text)).toBeInTheDocument();

    // 0.8125 — доля верных ответов; ученик видит проценты, а не дробь.
    expect(within(card).getByText(roomText('summary.accuracy', { percent: 81 }))).toBeVisible();
    expect(
      within(card).getByText(roomText('summary.exercises', { correct: 13, total: 16 })),
    ).toBeVisible();
    expect(within(card).getByText(roomText('summary.duration', { count: 27 }))).toBeVisible();

    for (const heading of ['strengths', 'weaknesses', 'recommendations'] as const) {
      expect(
        within(card).getByRole('heading', { name: roomText(`summary.${heading}`) }),
      ).toBeInTheDocument();
    }

    for (const item of [...data.strengths, ...data.weaknesses, ...data.recommendations]) {
      expect(within(card).getByText(item)).toBeInTheDocument();
    }
  });

  it('показывает новые слова урока', () => {
    renderSummary(<LessonSummary summary={summary({ newVocabulary: ['lake', 'to hike'] })} />);

    const card = summaryCard();

    expect(
      within(card).getByRole('heading', { name: roomText('summary.newVocabulary') }),
    ).toBeInTheDocument();
    expect(within(card).getByText('lake')).toBeInTheDocument();
    expect(within(card).getByText('to hike')).toBeInTheDocument();
  });

  it('объясняет повышение уровня переходом и причиной', () => {
    renderSummary(<LessonSummary summary={summary()} levelChange={levelChange()} />);

    const banner = screen.getByRole('status');

    expect(
      within(banner).getByText(roomText('summary.levelChange.up', { from: 'B1', to: 'B2' })),
    ).toBeInTheDocument();
    // Обоснование — главное в изменении уровня: без него это выглядит произволом.
    expect(
      within(banner).getByText(
        roomText('summary.levelChange.reason', { reason: PROMOTION_REASON }),
      ),
    ).toBeInTheDocument();
    expect(within(banner).getByText(new RegExp(PROMOTION_REASON))).toBeInTheDocument();
  });

  it('объясняет понижение уровня тем же способом', () => {
    const reason = 'Two lessons in a row below 50 percent of correct answers.';

    renderSummary(
      <LessonSummary
        summary={summary({ accuracy: 0.42 })}
        levelChange={levelChange({ fromLevel: 'B2', toLevel: 'B1', direction: 'down', reason })}
      />,
    );

    const banner = screen.getByRole('status');

    expect(
      within(banner).getByText(roomText('summary.levelChange.down', { from: 'B2', to: 'B1' })),
    ).toBeInTheDocument();
    expect(within(banner).getByText(new RegExp(reason))).toBeInTheDocument();
  });

  it('первичную установку уровня показывает без прежнего уровня', () => {
    const reason = 'The first finished lesson set the starting level.';

    renderSummary(
      <LessonSummary
        summary={summary()}
        levelChange={levelChange({
          fromLevel: null,
          toLevel: 'A2',
          direction: 'initial',
          source: 'placement',
          reason,
        })}
      />,
    );

    const banner = screen.getByRole('status');

    expect(
      within(banner).getByText(roomText('summary.levelChange.initial', { to: 'A2' })),
    ).toBeInTheDocument();
    expect(within(banner).getByText(new RegExp(reason))).toBeInTheDocument();
  });

  it('без изменения уровня не показывает пустой блок', () => {
    renderSummary(<LessonSummary summary={summary()} levelChange={null} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/Your level/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Why:/)).not.toBeInTheDocument();
  });

  it('показывает добавленную лексику с переводами и их числом', () => {
    const added = [
      vocabularyItem({ id: 'v-1', term: 'lake', translation: 'озеро' }),
      vocabularyItem({ id: 'v-2', term: 'to hike', translation: 'ходить в поход' }),
    ];

    renderSummary(<LessonSummary summary={summary()} vocabularyAdded={added} />);

    const table = screen.getByRole('table');

    expect(
      within(table).getByText(roomText('summary.vocabularyCount', { count: 2 })),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole('columnheader', { name: roomText('summary.vocabularyTerm') }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole('columnheader', { name: roomText('summary.vocabularyTranslation') }),
    ).toBeInTheDocument();

    for (const item of added) {
      const row = within(table).getByRole('cell', { name: item.term }).closest('tr');

      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).getByText(item.translation)).toBeInTheDocument();
    }
  });

  it('показывает записанные ошибки с объяснениями и их числом', () => {
    const errors = [
      errorEntry({
        id: 'e-1',
        original: 'I go to school yesterday',
        corrected: 'I went to school yesterday',
        explanation: 'Past simple needs went, not go.',
      }),
      errorEntry({
        id: 'e-2',
        category: 'vocabulary',
        severity: 'minor',
        original: 'we maked a photo',
        corrected: 'we took a photo',
        explanation: 'Photos are taken, not made.',
      }),
    ];

    renderSummary(<LessonSummary summary={summary()} errorsLogged={errors} />);

    expect(
      screen.getByRole('heading', { name: roomText('summary.errorsLogged', { count: 2 }) }),
    ).toBeInTheDocument();

    for (const entry of errors) {
      // Объяснение важнее пары «было — стало»: именно оно чему-то учит.
      expect(screen.getByText(entry.explanation)).toBeInTheDocument();
      expect(screen.getByText(entry.original)).toBeInTheDocument();
      expect(screen.getByText(entry.corrected)).toBeInTheDocument();
    }
  });

  it('на пустых списках не рисует ни заголовков, ни пустых списков', () => {
    const empty = summary({
      strengths: [],
      weaknesses: [],
      recommendations: [],
      newVocabulary: [],
      exercisesTotal: 0,
      exercisesCorrect: 0,
      accuracy: 0,
      durationMinutes: 1,
    });

    renderSummary(<LessonSummary summary={empty} vocabularyAdded={[]} errorsLogged={[]} />);

    const card = summaryCard();

    expect(within(card).getByText(empty.text)).toBeInTheDocument();
    expect(within(card).getByText(roomText('summary.accuracy', { percent: 0 }))).toBeVisible();
    expect(
      within(card).getByText(roomText('summary.exercises', { correct: 0, total: 0 })),
    ).toBeVisible();
    // Единственная минута урока склоняется отдельной формой множественного числа.
    expect(within(card).getByText(roomText('summary.duration', { count: 1 }))).toBeVisible();

    for (const heading of [
      'strengths',
      'weaknesses',
      'recommendations',
      'newVocabulary',
      'vocabularyAdded',
    ] as const) {
      expect(
        within(card).queryByRole('heading', { name: roomText(`summary.${heading}`) }),
      ).not.toBeInTheDocument();
    }

    expect(within(card).queryAllByRole('list')).toHaveLength(0);
    expect(within(card).queryByRole('table')).not.toBeInTheDocument();
    expect(within(card).queryByText(roomText('feedback.noCorrections'))).not.toBeInTheDocument();
  });

  it('ведёт в раздел прогресса и в список уроков', () => {
    renderSummary(<LessonSummary summary={summary()} />);

    const card = summaryCard();

    expect(
      within(card).getByRole('link', { name: roomText('summary.actions.progress') }),
    ).toHaveAttribute('href', ROUTE_PATHS.progress);
    expect(
      within(card).getByRole('link', { name: roomText('summary.actions.lessons') }),
    ).toHaveAttribute('href', ROUTE_PATHS.lessons);
  });
});
