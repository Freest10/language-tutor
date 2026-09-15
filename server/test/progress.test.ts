import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  API_PREFIX,
  ERROR_CATEGORIES,
  getProgressSummaryResponseSchema,
  LEVEL_CHANGE_POLICY,
  levelHistoryEntrySchema,
  listErrorsResponseSchema,
  listLevelHistoryResponseSchema,
  listVocabularyResponseSchema,
  type CefrLevel,
  type Correction,
  type Id,
} from '@lt/shared';

import { buildApp } from '../src/app.js';
import { closeDb, getDb, IN_MEMORY_DB_PATH, openDatabase, setDb } from '../src/db/connection.js';
import { nowIso, toIsoDate } from '../src/db/mappers.js';
import { migrate } from '../src/db/migrate.js';
import { PROFILE_ROW_ID } from '../src/db/rows.js';
import * as learnerContext from '../src/services/learnerContext.js';
import {
  computeStreaks,
  decideLevelChange,
  getProgressSummary,
  maybeAdjustLevel,
  recordErrors,
  recordExerciseOutcome,
  recordVocabulary,
  type LevelChangeInput,
} from '../src/services/progressService.js';

const SUMMARY_URL = `${API_PREFIX}/progress/summary`;
const VOCABULARY_URL = `${API_PREFIX}/progress/vocabulary`;
const ERRORS_URL = `${API_PREFIX}/progress/errors`;
const LEVEL_HISTORY_URL = `${API_PREFIX}/progress/level-history`;

let app: FastifyInstance;

/** Параметры завершённого урока, который подкладывается в базу. */
interface SeedLessonOptions {
  /** Сколько попыток засчитано верными. */
  correct?: number;
  /** Сколько попыток засчитано неверными. */
  wrong?: number;
  completedAt?: string;
  durationMinutes?: number;
  topic?: string;
  language?: string;
  status?: 'draft' | 'in_progress' | 'completed';
}

/** Число строк таблицы: проверка дедупликации идёт по базе, а не по ответу API. */
function countRows(table: string): number {
  const { total } = getDb().prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as {
    total: number;
  };

  return total;
}

/** Итог урока в формате `LessonSummary`. */
function lessonSummary(durationMinutes: number, correct: number, total: number): string {
  return JSON.stringify({
    text: 'Итог урока',
    strengths: [],
    weaknesses: [],
    recommendations: [],
    newVocabulary: [],
    exercisesTotal: total,
    exercisesCorrect: correct,
    accuracy: total === 0 ? 0 : correct / total,
    durationMinutes,
  });
}

/** Кладёт в базу урок с заданиями и попытками; возвращает идентификатор урока. */
function seedLesson(id: Id, options: SeedLessonOptions = {}): Id {
  const correct = options.correct ?? 0;
  const wrong = options.wrong ?? 0;
  const status = options.status ?? 'completed';
  const completedAt = options.completedAt ?? '2026-09-01T10:00:00.000Z';
  const db = getDb();

  db.prepare(
    `INSERT INTO lessons (
       id, title, status, learning_language, explanation_language, level, topic, goals,
       current_step_id, planned_minutes, summary, started_at, completed_at, created_at, updated_at
     ) VALUES (@id, @title, @status, @language, 'ru', 'A1', @topic, '[]',
       NULL, 20, @summary, @created_at, @completed_at, @created_at, @created_at)`,
  ).run({
    id,
    title: `Урок ${id}`,
    status,
    language: options.language ?? 'en',
    topic: options.topic ?? null,
    summary:
      status === 'completed'
        ? lessonSummary(options.durationMinutes ?? 0, correct, correct + wrong)
        : null,
    completed_at: status === 'completed' ? completedAt : null,
    created_at: completedAt,
  });

  if (correct + wrong === 0) {
    return id;
  }

  const exerciseId = `${id}-exercise`;

  db.prepare(
    `INSERT INTO exercises (
       id, lesson_id, step_id, "order", type, prompt, instructions, options,
       expected_answer, acceptable_answers, hints, target_items, level, created_at
     ) VALUES (@id, @lesson_id, NULL, 0, 'translate', 'Переведите', NULL, '[]',
       NULL, '[]', '[]', '[]', NULL, @created_at)`,
  ).run({ id: exerciseId, lesson_id: id, created_at: completedAt });

  const insertAttempt = db.prepare(
    `INSERT INTO exercise_attempts (
       id, exercise_id, lesson_id, step_id, answer, source, is_correct, score,
       corrections, feedback, duration_ms, created_at
     ) VALUES (@id, @exercise_id, @lesson_id, NULL, 'ответ', 'text', @is_correct, @score,
       '[]', '', NULL, @created_at)`,
  );

  for (let index = 0; index < correct + wrong; index += 1) {
    insertAttempt.run({
      id: `${id}-attempt-${String(index)}`,
      exercise_id: exerciseId,
      lesson_id: id,
      is_correct: index < correct ? 1 : 0,
      score: index < correct ? 1 : 0,
      created_at: completedAt,
    });
  }

  return id;
}

/** Уровень профиля в базе: пересчёт уровня проверяется по строке, а не по ответу. */
function profileLevel(): CefrLevel {
  const row = getDb().prepare('SELECT level FROM profile WHERE id = ?').get(PROFILE_ROW_ID) as {
    level: CefrLevel;
  };

  return row.level;
}

/** Исправление тьютора для журнала ошибок. */
function correction(overrides: Partial<Correction> = {}): Correction {
  return {
    category: 'grammar',
    severity: 'minor',
    original: 'ich haben',
    corrected: 'ich habe',
    explanation: 'Первое лицо единственного числа: habe',
    targetItem: null,
    ...overrides,
  };
}

/** Статистика для `decideLevelChange()` с разумными значениями по умолчанию. */
function levelInput(overrides: Partial<LevelChangeInput> = {}): LevelChangeInput {
  return {
    currentLevel: 'A2',
    completedLessons: LEVEL_CHANGE_POLICY.minCompletedLessons,
    lessonsSinceLastChange: LEVEL_CHANGE_POLICY.cooldownLessons,
    hasLevelChange: false,
    accuracy: 0.7,
    lessonsConsidered: LEVEL_CHANGE_POLICY.windowLessons,
    exercisesEvaluated: 10,
    ...overrides,
  };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeDb();
});

beforeEach(() => {
  const db = openDatabase(IN_MEMORY_DB_PATH);

  migrate(db);
  setDb(db);
});

describe('recordVocabulary', () => {
  it('сохраняет новое слово со стадией new и одной встречей', () => {
    const [item] = recordVocabulary([{ term: 'das Haus', translation: 'дом' }]);

    expect(item).toMatchObject({
      term: 'das Haus',
      translation: 'дом',
      language: 'en',
      translationLanguage: 'ru',
      status: 'new',
      timesSeen: 1,
      timesCorrect: 0,
    });
    expect(countRows('vocabulary_items')).toBe(1);
  });

  it('не дублирует строку при повторной записи и повышает счётчик встреч', () => {
    recordVocabulary([{ term: 'das Haus', translation: 'дом' }]);
    const [updated] = recordVocabulary([{ term: 'Das Haus ', translation: 'дом, здание' }]);

    expect(countRows('vocabulary_items')).toBe(1);
    expect(updated?.timesSeen).toBe(2);
    expect(updated?.status).toBe('learning');
    expect(updated?.translation).toBe('дом, здание');
  });

  it('схлопывает повторы одного слова внутри одного вызова', () => {
    const items = recordVocabulary([
      { term: 'gehen', translation: 'идти' },
      { term: 'GEHEN', translation: 'идти' },
    ]);

    expect(items).toHaveLength(1);
    expect(countRows('vocabulary_items')).toBe(1);
    expect(items[0]?.timesSeen).toBe(2);
  });

  it('переводит слово в known после трёх верных употреблений', () => {
    recordVocabulary([{ term: 'gehen', translation: 'идти', correct: true }]);
    recordVocabulary([{ term: 'gehen', translation: 'идти', correct: true }]);
    const [item] = recordVocabulary([{ term: 'gehen', translation: 'идти', correct: true }]);

    expect(item).toMatchObject({ status: 'known', timesSeen: 3, timesCorrect: 3 });
  });

  it('не понижает достигнутую стадию освоения', () => {
    recordVocabulary([{ term: 'gehen', translation: 'идти', status: 'known' }]);
    const [item] = recordVocabulary([{ term: 'gehen', translation: 'идти' }]);

    expect(item?.status).toBe('known');
  });

  it('пропускает новое слово без перевода и без самого слова', () => {
    const items = recordVocabulary([
      { term: 'ohne', translation: '   ' },
      { term: '   ', translation: 'перевод' },
    ]);

    expect(items).toEqual([]);
    expect(countRows('vocabulary_items')).toBe(0);
  });

  it('разводит одинаковые слова разных языков по разным строкам', () => {
    recordVocabulary([{ term: 'die', translation: 'артикль', language: 'de' }]);
    recordVocabulary([{ term: 'die', translation: 'умирать', language: 'en' }]);

    expect(countRows('vocabulary_items')).toBe(2);
  });
});

describe('recordErrors', () => {
  it('пишет исправления в журнал с категорией, фрагментом и объяснением', () => {
    const lessonId = seedLesson('lesson-errors');
    const entries = recordErrors(lessonId, [correction()], { language: 'de' });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      category: 'grammar',
      original: 'ich haben',
      corrected: 'ich habe',
      lessonId,
      language: 'de',
    });
    expect(countRows('error_log')).toBe(1);
  });

  it('пропускает исправления без исходного фрагмента или объяснения', () => {
    const entries = recordErrors(null, [
      correction({ original: '  ' }),
      correction({ explanation: '' }),
      correction({ category: 'spelling' }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.category).toBe('spelling');
  });

  it('переживает удаление урока: запись остаётся с lessonId = null', () => {
    const lessonId = seedLesson('lesson-removed');

    recordErrors(lessonId, [correction()]);
    getDb().prepare('DELETE FROM lessons WHERE id = ?').run(lessonId);

    expect(countRows('error_log')).toBe(1);

    const row = getDb().prepare('SELECT lesson_id FROM error_log').get() as {
      lesson_id: string | null;
    };

    expect(row.lesson_id).toBeNull();
  });
});

describe('recordExerciseOutcome', () => {
  it('пишет ошибки задания и двигает счётчики отработанных слов', () => {
    const lessonId = seedLesson('lesson-outcome', { correct: 2, wrong: 1 });

    recordVocabulary([{ term: 'gehen', translation: 'идти' }]);

    const result = recordExerciseOutcome({
      lessonId,
      exerciseId: `${lessonId}-exercise`,
      isCorrect: true,
      targetItems: ['gehen', 'unbekannt'],
      corrections: [correction({ category: 'vocabulary' })],
    });

    expect(result.errors).toHaveLength(1);
    expect(result.vocabulary).toHaveLength(1);
    expect(result.vocabulary[0]).toMatchObject({ term: 'gehen', timesSeen: 2, timesCorrect: 1 });
    // Незнакомое слово не заводится: перевода для него нет.
    expect(countRows('vocabulary_items')).toBe(1);
    expect(result.lesson).toEqual({ total: 3, correct: 2, accuracy: 2 / 3 });
    expect(result.overall).toEqual({ total: 3, correct: 2, accuracy: 2 / 3 });
  });
});

describe('decideLevelChange', () => {
  it('повышает уровень при доле верных ответов не ниже порога', () => {
    const decision = decideLevelChange(
      levelInput({ accuracy: LEVEL_CHANGE_POLICY.promoteAccuracy }),
    );

    expect(decision).toMatchObject({
      changed: true,
      direction: 'up',
      fromLevel: 'A2',
      toLevel: 'B1',
    });
    expect(decision.metrics.accuracy).toBe(LEVEL_CHANGE_POLICY.promoteAccuracy);
    expect(decision.eligibility.canChange).toBe(true);
  });

  it('понижает уровень при доле верных ответов ниже порога', () => {
    const decision = decideLevelChange({ ...levelInput(), accuracy: 0.3 });

    expect(decision).toMatchObject({
      changed: true,
      direction: 'down',
      fromLevel: 'A2',
      toLevel: 'A1',
    });
  });

  it('оставляет уровень, когда доля верных ответов между порогами', () => {
    const decision = decideLevelChange(levelInput({ accuracy: 0.7 }));

    expect(decision).toMatchObject({ changed: false, direction: null, toLevel: 'A2' });
    expect(decision.eligibility.canChange).toBe(true);
    expect(decision.eligibility.lessonsUntilEligible).toBe(0);
  });

  it('не меняет уровень, пока завершено меньше minCompletedLessons уроков', () => {
    const decision = decideLevelChange(
      levelInput({ accuracy: 1, completedLessons: LEVEL_CHANGE_POLICY.minCompletedLessons - 1 }),
    );

    expect(decision.changed).toBe(false);
    expect(decision.eligibility).toMatchObject({ canChange: false, lessonsUntilEligible: 1 });
  });

  it('не меняет уровень повторно внутри cooldownLessons', () => {
    const decision = decideLevelChange(
      levelInput({
        accuracy: 1,
        hasLevelChange: true,
        lessonsSinceLastChange: LEVEL_CHANGE_POLICY.cooldownLessons - 1,
      }),
    );

    expect(decision.changed).toBe(false);
    expect(decision.eligibility).toMatchObject({ canChange: false, lessonsUntilEligible: 1 });
  });

  it('не меняет уровень без единой оценённой попытки', () => {
    const decision = decideLevelChange(levelInput({ accuracy: 1, exercisesEvaluated: 0 }));

    expect(decision.changed).toBe(false);
    expect(decision.eligibility.canChange).toBe(false);
  });

  it('сдвигает уровень не больше чем на maxStepsPerChange ступеней', () => {
    const decision = decideLevelChange(levelInput({ currentLevel: 'A1', accuracy: 1 }));

    expect(decision.toLevel).toBe('A2');
    expect(LEVEL_CHANGE_POLICY.maxStepsPerChange).toBe(1);
  });

  it('не выходит за границы шкалы CEFR', () => {
    expect(decideLevelChange(levelInput({ currentLevel: 'C2', accuracy: 1 })).changed).toBe(false);
    expect(decideLevelChange(levelInput({ currentLevel: 'A1', accuracy: 0 })).changed).toBe(false);
  });
});

describe('maybeAdjustLevel', () => {
  it('на пустой базе ничего не меняет', () => {
    const adjustment = maybeAdjustLevel();

    expect(adjustment.changed).toBe(false);
    expect(countRows('level_history')).toBe(0);
    expect(profileLevel()).toBe('A1');
  });

  it('повышает уровень и пишет историю с source = progress', () => {
    seedLesson('lesson-1', { correct: 10, wrong: 0, completedAt: '2026-09-01T10:00:00.000Z' });
    seedLesson('lesson-2', { correct: 10, wrong: 0, completedAt: '2026-09-02T10:00:00.000Z' });
    seedLesson('lesson-3', { correct: 9, wrong: 1, completedAt: '2026-09-03T10:00:00.000Z' });

    const adjustment = maybeAdjustLevel();

    expect(adjustment.changed).toBe(true);
    expect(adjustment.profile.level).toBe('A2');
    expect(profileLevel()).toBe('A2');

    const entry = levelHistoryEntrySchema.parse(adjustment.entry);

    expect(entry).toMatchObject({
      source: 'progress',
      direction: 'up',
      fromLevel: 'A1',
      toLevel: 'A2',
    });
    expect(entry.reason.length).toBeGreaterThan(0);
    expect(entry.metrics.lessonsConsidered).toBe(LEVEL_CHANGE_POLICY.windowLessons);
    expect(entry.metrics.exercisesEvaluated).toBe(30);
    expect(entry.metrics.accuracy).toBeCloseTo(29 / 30, 5);
    expect(countRows('level_history')).toBe(1);
  });

  it('понижает уровень при низкой доле верных ответов', () => {
    getDb().prepare('UPDATE profile SET level = ? WHERE id = ?').run('B1', PROFILE_ROW_ID);
    seedLesson('lesson-1', { correct: 1, wrong: 9, completedAt: '2026-09-01T10:00:00.000Z' });
    seedLesson('lesson-2', { correct: 2, wrong: 8, completedAt: '2026-09-02T10:00:00.000Z' });
    seedLesson('lesson-3', { correct: 1, wrong: 9, completedAt: '2026-09-03T10:00:00.000Z' });

    const adjustment = maybeAdjustLevel();

    expect(adjustment.changed).toBe(true);
    expect(adjustment.decision.direction).toBe('down');
    expect(profileLevel()).toBe('A2');
  });

  it('не меняет уровень повторно, пока не пройдёт пауза в cooldownLessons уроков', () => {
    seedLesson('lesson-1', { correct: 10, completedAt: '2026-09-01T10:00:00.000Z' });
    seedLesson('lesson-2', { correct: 10, completedAt: '2026-09-02T10:00:00.000Z' });
    seedLesson('lesson-3', { correct: 10, completedAt: '2026-09-03T10:00:00.000Z' });

    expect(maybeAdjustLevel().changed).toBe(true);

    const second = maybeAdjustLevel();

    expect(second.changed).toBe(false);
    expect(second.decision.eligibility).toMatchObject({
      canChange: false,
      lessonsUntilEligible: LEVEL_CHANGE_POLICY.cooldownLessons,
    });
    expect(countRows('level_history')).toBe(1);
    expect(profileLevel()).toBe('A2');
  });

  it('снова меняет уровень, когда после паузы накопились новые уроки', () => {
    seedLesson('lesson-1', { correct: 10, completedAt: '2026-09-01T10:00:00.000Z' });
    seedLesson('lesson-2', { correct: 10, completedAt: '2026-09-02T10:00:00.000Z' });
    seedLesson('lesson-3', { correct: 10, completedAt: '2026-09-03T10:00:00.000Z' });

    expect(maybeAdjustLevel().changed).toBe(true);

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    seedLesson('lesson-4', { correct: 10, completedAt: future });
    seedLesson('lesson-5', { correct: 10, completedAt: future });
    seedLesson('lesson-6', { correct: 10, completedAt: future });

    expect(maybeAdjustLevel().changed).toBe(true);
    expect(profileLevel()).toBe('B1');
    expect(countRows('level_history')).toBe(2);
  });

  it('не сбрасывает признак пройденного онбординга', () => {
    getDb().prepare('UPDATE profile SET onboarding_completed = 1 WHERE id = ?').run(PROFILE_ROW_ID);
    seedLesson('lesson-1', { correct: 10, completedAt: '2026-09-01T10:00:00.000Z' });
    seedLesson('lesson-2', { correct: 10, completedAt: '2026-09-02T10:00:00.000Z' });
    seedLesson('lesson-3', { correct: 10, completedAt: '2026-09-03T10:00:00.000Z' });

    expect(maybeAdjustLevel().changed).toBe(true);

    const row = getDb()
      .prepare('SELECT onboarding_completed FROM profile WHERE id = ?')
      .get(PROFILE_ROW_ID) as { onboarding_completed: number };

    expect(row.onboarding_completed).toBe(1);
  });
});

describe('computeStreaks', () => {
  it('считает текущую и самую длинную серию', () => {
    const streaks = computeStreaks(
      ['2026-09-16', '2026-09-15', '2026-09-14', '2026-09-10', '2026-09-09'],
      '2026-09-16',
    );

    expect(streaks).toEqual({ current: 3, longest: 3 });
  });

  it('обнуляет текущую серию, если занятий не было вчера и сегодня', () => {
    const streaks = computeStreaks(['2026-09-10', '2026-09-09'], '2026-09-16');

    expect(streaks).toEqual({ current: 0, longest: 2 });
  });

  it('не падает на пустом списке дней', () => {
    expect(computeStreaks([], '2026-09-16')).toEqual({ current: 0, longest: 0 });
  });
});

describe('learnerContext.build', () => {
  it('не падает на пустой базе и содержит уровень и цели', () => {
    const context = learnerContext.build({ language: 'en' });

    expect(context).toContain('Learner context (en)');
    expect(context).toContain('CEFR level: A1');
    expect(context).toContain('Goals:');
    expect(context.length).toBeLessThanOrEqual(learnerContext.LEARNER_CONTEXT_MAX_CHARS);
  });

  it('собирает слабые места, слова в работе и темы последних уроков', () => {
    const lessonId = seedLesson('lesson-context', { correct: 2, wrong: 1, topic: 'Im Café' });

    recordVocabulary([{ term: 'das Haus', translation: 'дом', language: 'en' }]);
    recordErrors(lessonId, [correction({ category: 'grammar' })], { language: 'en' });

    const context = learnerContext.build({ language: 'en' });

    expect(context).toContain('grammar (1)');
    expect(context).toContain('das Haus — дом');
    expect(context).toContain('Im Café');
    expect(context).toContain('1 lessons completed');
  });

  it('укладывается в предел символов на раздутых данных', () => {
    const goals = Array.from({ length: 10 }, (_, index) =>
      `Очень длинная цель номер ${String(index)} `.repeat(4).trim(),
    );
    const interests = Array.from({ length: 10 }, (_, index) =>
      `Интерес ${String(index)} `.repeat(6).trim(),
    );

    getDb()
      .prepare('UPDATE profile SET goals = ?, interests = ? WHERE id = ?')
      .run(JSON.stringify(goals), JSON.stringify(interests), PROFILE_ROW_ID);

    const lessonId = seedLesson('lesson-big', {
      correct: 5,
      wrong: 5,
      topic: 'Очень подробная тема урока про путешествия и бронирование гостиниц',
    });

    recordVocabulary(
      Array.from({ length: 60 }, (_, index) => ({
        term: `слово-${String(index)}-${'длинное'.repeat(5)}`,
        translation: `перевод-${String(index)}-${'подробный'.repeat(5)}`,
      })),
    );
    recordErrors(
      lessonId,
      Array.from({ length: 30 }, (_, index) =>
        correction({
          category: ERROR_CATEGORIES[index % ERROR_CATEGORIES.length],
          original: `ошибочная фраза номер ${String(index)} ${'очень длинная'.repeat(10)}`,
          corrected: `исправленная фраза номер ${String(index)} ${'очень длинная'.repeat(10)}`,
        }),
      ),
    );

    const context = learnerContext.build();

    expect(context.length).toBeLessThanOrEqual(learnerContext.LEARNER_CONTEXT_MAX_CHARS);
    expect(context.split('\n').every((line) => line.length <= 200)).toBe(true);
    expect(context).toContain('Learner context');
  });

  it('уважает переданный предел символов', () => {
    expect(learnerContext.build({ maxChars: 40 }).length).toBeLessThanOrEqual(40);
  });
});

describe('GET /api/progress/summary', () => {
  it('на пустой базе отдаёт валидную сводку с нулями', async () => {
    const response = await app.inject({ method: 'GET', url: SUMMARY_URL });

    expect(response.statusCode).toBe(200);

    const summary = getProgressSummaryResponseSchema.parse(response.json());

    expect(summary).toMatchObject({
      level: 'A1',
      learningLanguage: 'en',
      lessonsCompleted: 0,
      lessonsInProgress: 0,
      practiceMinutes: 0,
      exercisesTotal: 0,
      exercisesCorrect: 0,
      accuracyOverall: 0,
      accuracyRecent: 0,
      streakDays: 0,
      longestStreakDays: 0,
      vocabulary: { total: 0, new: 0, learning: 0, known: 0 },
      recentActivity: [],
      lastLevelChange: null,
    });
    expect(Object.keys(summary.errorsByCategory).sort()).toEqual([...ERROR_CATEGORIES].sort());
    expect(summary.levelEligibility.canChange).toBe(false);
    expect(summary.levelEligibility.lessonsUntilEligible).toBe(
      LEVEL_CHANGE_POLICY.minCompletedLessons,
    );
  });

  it('считает уроки, задания, минуты, словарь и ошибки', async () => {
    const lessonId = seedLesson('lesson-summary', {
      correct: 3,
      wrong: 1,
      durationMinutes: 25,
      completedAt: '2026-09-01T10:00:00.000Z',
    });

    seedLesson('lesson-active', { status: 'in_progress' });
    recordVocabulary([
      { term: 'das Haus', translation: 'дом' },
      { term: 'gehen', translation: 'идти' },
    ]);
    recordVocabulary([{ term: 'gehen', translation: 'идти' }]);
    recordErrors(lessonId, [correction(), correction({ category: 'spelling' })]);

    const response = await app.inject({ method: 'GET', url: SUMMARY_URL });
    const summary = getProgressSummaryResponseSchema.parse(response.json());

    expect(summary).toMatchObject({
      lessonsCompleted: 1,
      lessonsInProgress: 1,
      lessonsSinceLevelChange: 1,
      practiceMinutes: 25,
      exercisesTotal: 4,
      exercisesCorrect: 3,
      accuracyOverall: 0.75,
      accuracyRecent: 0.75,
      vocabulary: { total: 2, new: 1, learning: 1, known: 0 },
    });
    expect(summary.errorsByCategory.grammar).toBe(1);
    expect(summary.errorsByCategory.spelling).toBe(1);
    expect(summary.errorsByCategory.fluency).toBe(0);
    expect(summary.recentActivity).toEqual([
      { date: '2026-09-01', minutes: 25, lessons: 1, exercises: 4 },
    ]);
  });

  it('считает серию занятий по последним дням', async () => {
    const today = toIsoDate(new Date());
    const yesterday = toIsoDate(Date.now() - 24 * 60 * 60 * 1000);

    seedLesson('lesson-today', { correct: 1, completedAt: `${today}T09:00:00.000Z` });
    seedLesson('lesson-yesterday', { correct: 1, completedAt: `${yesterday}T09:00:00.000Z` });

    const response = await app.inject({ method: 'GET', url: SUMMARY_URL });
    const summary = getProgressSummaryResponseSchema.parse(response.json());

    expect(summary.streakDays).toBe(2);
    expect(summary.longestStreakDays).toBe(2);
  });

  it('отдаёт последнее изменение уровня и не меняет уровень сам', async () => {
    seedLesson('lesson-1', { correct: 10, completedAt: '2026-09-01T10:00:00.000Z' });
    seedLesson('lesson-2', { correct: 10, completedAt: '2026-09-02T10:00:00.000Z' });
    seedLesson('lesson-3', { correct: 10, completedAt: '2026-09-03T10:00:00.000Z' });

    const before = getProgressSummary();

    expect(before.levelEligibility.canChange).toBe(true);
    expect(countRows('level_history')).toBe(0);
    expect(profileLevel()).toBe('A1');

    maybeAdjustLevel();

    const response = await app.inject({ method: 'GET', url: SUMMARY_URL });
    const summary = getProgressSummaryResponseSchema.parse(response.json());

    expect(summary.level).toBe('A2');
    expect(summary.lastLevelChange?.source).toBe('progress');
    expect(summary.lessonsSinceLevelChange).toBe(0);
  });
});

describe('GET /api/progress/vocabulary', () => {
  beforeEach(() => {
    recordVocabulary([
      { term: 'banane', translation: 'банан', seenAt: '2026-09-01T10:00:00.000Z' },
      { term: 'apfel', translation: 'яблоко', seenAt: '2026-09-02T10:00:00.000Z' },
      {
        term: 'citrone',
        translation: 'лимон',
        status: 'known',
        seenAt: '2026-09-03T10:00:00.000Z',
      },
    ]);
  });

  it('отдаёт словарь страницей, свежие слова первыми', async () => {
    const response = await app.inject({ method: 'GET', url: VOCABULARY_URL });

    expect(response.statusCode).toBe(200);

    const page = listVocabularyResponseSchema.parse(response.json());

    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(false);
    expect(page.items.map((item) => item.term)).toEqual(['citrone', 'apfel', 'banane']);
  });

  it('фильтрует по стадии освоения', async () => {
    const response = await app.inject({ method: 'GET', url: `${VOCABULARY_URL}?status=known` });
    const page = listVocabularyResponseSchema.parse(response.json());

    expect(page.total).toBe(1);
    expect(page.items[0]?.term).toBe('citrone');
  });

  it('сортирует по алфавиту и отдаёт запрошенную страницу', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${VOCABULARY_URL}?sort=alphabetical&order=asc&limit=2&offset=1`,
    });
    const page = listVocabularyResponseSchema.parse(response.json());

    expect(page).toMatchObject({ total: 3, limit: 2, offset: 1, hasMore: false });
    expect(page.items.map((item) => item.term)).toEqual(['banane', 'citrone']);
  });

  it('ищет по слову и по переводу', async () => {
    const byTerm = await app.inject({ method: 'GET', url: `${VOCABULARY_URL}?search=apf` });
    const byTranslation = await app.inject({
      method: 'GET',
      url: `${VOCABULARY_URL}?search=лимон`,
    });

    expect(listVocabularyResponseSchema.parse(byTerm.json()).total).toBe(1);
    expect(listVocabularyResponseSchema.parse(byTranslation.json()).total).toBe(1);
  });

  it('отвечает 400 на недопустимое поле сортировки', async () => {
    const response = await app.inject({ method: 'GET', url: `${VOCABULARY_URL}?sort=nonsense` });

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/progress/errors', () => {
  beforeEach(() => {
    const lessonId = seedLesson('lesson-errors-api');

    recordErrors(
      lessonId,
      [
        correction({ category: 'grammar' }),
        correction({ category: 'grammar' }),
        correction({ category: 'vocabulary' }),
      ],
      { occurredAt: '2026-09-01T10:00:00.000Z' },
    );
    recordErrors(null, [correction({ category: 'pronunciation' })], {
      occurredAt: '2026-09-05T10:00:00.000Z',
    });
  });

  it('отдаёт журнал ошибок и счётчики по всем пяти категориям', async () => {
    const response = await app.inject({ method: 'GET', url: ERRORS_URL });

    expect(response.statusCode).toBe(200);

    const page = listErrorsResponseSchema.parse(response.json());

    expect(page.total).toBe(4);
    expect(page.items[0]?.category).toBe('pronunciation');
    expect(Object.keys(page.countsByCategory).sort()).toEqual([...ERROR_CATEGORIES].sort());
    expect(page.countsByCategory).toMatchObject({
      grammar: 2,
      vocabulary: 1,
      pronunciation: 1,
      fluency: 0,
      spelling: 0,
    });
  });

  it('фильтрует по категории, оставляя в счётчиках все пять ключей', async () => {
    const response = await app.inject({ method: 'GET', url: `${ERRORS_URL}?category=grammar` });
    const page = listErrorsResponseSchema.parse(response.json());

    expect(page.total).toBe(2);
    expect(page.items.every((item) => item.category === 'grammar')).toBe(true);
    expect(Object.keys(page.countsByCategory).sort()).toEqual([...ERROR_CATEGORIES].sort());
    expect(page.countsByCategory.grammar).toBe(2);
    expect(page.countsByCategory.fluency).toBe(0);
  });

  it('счётчики фасетные: свой фильтр category не обнуляет соседние категории', async () => {
    // UI рисует по этим счётчикам переключатели категорий. Если бы они учитывали
    // собственный фильтр, после выбора «грамматики» остальные показали бы 0 и
    // вернуться к другой категории было бы некуда.
    const response = await app.inject({ method: 'GET', url: `${ERRORS_URL}?category=grammar` });
    const page = listErrorsResponseSchema.parse(response.json());

    expect(page.items).toHaveLength(2);
    expect(page.countsByCategory.vocabulary).toBe(1);
    expect(page.countsByCategory.pronunciation).toBe(1);
  });

  it('счётчики учитывают остальные фильтры, кроме собственного', async () => {
    // lessonId оставляет только первую запись (3 ошибки), поэтому pronunciation,
    // привязанный к другому уроку, обязан обнулиться — в отличие от category.
    const response = await app.inject({
      method: 'GET',
      url: `${ERRORS_URL}?category=grammar&lessonId=lesson-errors-api`,
    });
    const page = listErrorsResponseSchema.parse(response.json());

    expect(page.countsByCategory.grammar).toBe(2);
    expect(page.countsByCategory.vocabulary).toBe(1);
    expect(page.countsByCategory.pronunciation).toBe(0);
  });

  it('фильтрует по уроку и по времени возникновения', async () => {
    const byLesson = await app.inject({
      method: 'GET',
      url: `${ERRORS_URL}?lessonId=lesson-errors-api`,
    });
    const bySince = await app.inject({
      method: 'GET',
      url: `${ERRORS_URL}?since=2026-09-02T00:00:00.000Z`,
    });

    expect(listErrorsResponseSchema.parse(byLesson.json()).total).toBe(3);
    expect(listErrorsResponseSchema.parse(bySince.json()).total).toBe(1);
  });
});

describe('GET /api/progress/level-history', () => {
  it('на пустой базе отдаёт пустую страницу', async () => {
    const response = await app.inject({ method: 'GET', url: LEVEL_HISTORY_URL });

    expect(response.statusCode).toBe(200);
    expect(listLevelHistoryResponseSchema.parse(response.json())).toMatchObject({
      items: [],
      total: 0,
      hasMore: false,
    });
  });

  it('отдаёт записи истории, свежие первыми', async () => {
    getDb()
      .prepare(
        `INSERT INTO level_history (
           id, from_level, to_level, direction, source, confidence, reason, metrics,
           changed_at, created_at
         ) VALUES (@id, @from_level, @to_level, @direction, @source, 0.5, @reason, @metrics,
           @changed_at, @changed_at)`,
      )
      .run({
        id: 'history-1',
        from_level: null,
        to_level: 'A2',
        direction: 'initial',
        source: 'placement',
        reason: 'Определение уровня',
        metrics: JSON.stringify({
          accuracy: 0.6,
          lessonsConsidered: 0,
          lessonsSinceLastChange: 0,
          exercisesEvaluated: 0,
          windowFrom: null,
          windowTo: null,
        }),
        changed_at: '2026-09-01T10:00:00.000Z',
      });

    seedLesson('lesson-1', { correct: 10, completedAt: '2026-09-02T10:00:00.000Z' });
    seedLesson('lesson-2', { correct: 10, completedAt: '2026-09-03T10:00:00.000Z' });
    seedLesson('lesson-3', { correct: 10, completedAt: '2026-09-04T10:00:00.000Z' });
    getDb().prepare('UPDATE profile SET level = ? WHERE id = ?').run('A2', PROFILE_ROW_ID);

    expect(maybeAdjustLevel().changed).toBe(true);

    const response = await app.inject({ method: 'GET', url: LEVEL_HISTORY_URL });
    const page = listLevelHistoryResponseSchema.parse(response.json());

    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({ source: 'progress', direction: 'up', toLevel: 'B1' });
    expect(page.items[1]).toMatchObject({ source: 'placement', direction: 'initial' });
    expect(page.items[0]?.changedAt.localeCompare(nowIso())).toBeLessThanOrEqual(0);
  });
});
