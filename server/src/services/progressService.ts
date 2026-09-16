/**
 * Прикладная логика прогресса: личный словарь, журнал ошибок, автокоррекция уровня
 * и сводка для экрана прогресса.
 *
 * Этим модулем пользуются и ход урока (записывает слова, ошибки и итоги заданий),
 * и маршруты `GET /api/progress/*` (только читают). Правила здесь такие:
 *
 * - слово дедуплицируется по `(language, lemma)`: повторная запись не создаёт строку,
 *   а увеличивает счётчики и двигает стадию освоения `new → learning → known`
 *   (стадия никогда не понижается — ученик не «разучивается» от одного промаха);
 * - записи журнала ошибок неизменяемы: это история, а не текущее состояние;
 * - уровень пересчитывается только по `LEVEL_CHANGE_POLICY` (допущение A13) —
 *   пороги, окно, минимум уроков, cooldown и шаг берутся оттуда и здесь не дублируются.
 *   Решение принимает чистая функция `decideLevelChange()`: её можно прогнать на
 *   синтетических данных, не поднимая базу;
 * - изменение уровня всегда пишется в историю с `source: 'progress'`, обоснованием
 *   и метриками, по которым оно принято, одной транзакцией с профилем. Саму запись
 *   собирает общий `services/levelHistory.ts`: правило «первая запись истории —
 *   первичная установка» одинаково для всех трёх источников изменения уровня.
 *
 * Тексты обоснований — на русском, как и у ручной смены уровня в `profileService`.
 */
import { randomUUID } from 'node:crypto';

import {
  ERROR_CATEGORIES,
  ERROR_SEVERITIES,
  LEVEL_CHANGE_POLICY,
  VOCABULARY_STATUSES,
  type CefrLevel,
  type Correction,
  type ErrorLogEntry,
  type Id,
  type LanguageCode,
  type LearnerProfile,
  type LevelChangeMetrics,
  type LevelEligibility,
  type LevelHistoryEntry,
  type ListErrorsQuery,
  type ListErrorsResponse,
  type ListLevelHistoryQuery,
  type ListLevelHistoryResponse,
  type ListVocabularyQuery,
  type ListVocabularyResponse,
  type ProgressSummary,
  type VocabularyItem,
  type VocabularyStatus,
} from '@lt/shared';

import { isOnboardingCompleted, learnerProfileToRow, nowIso, toIsoDate } from '../db/mappers.js';
import { shiftLevel } from '../lib/cefr.js';
import { accuracyRatio, formatPercent } from '../lib/metrics.js';
import {
  findLatestLevelHistoryEntry,
  findProfileRow,
  saveProfileRow,
} from '../repositories/profileRepository.js';
import {
  countCompletedLessonsSince,
  countErrorsByCategory,
  countLessonsByStatus,
  findRecentCompletedLessons,
  findVocabularyItem,
  getExerciseTotals,
  getExerciseTotalsForLessons,
  getVocabularyStats,
  insertErrorLogEntries,
  listActivityDates,
  listDailyActivity,
  listErrorLogEntries,
  listLevelHistory as selectLevelHistory,
  listVocabularyItems,
  saveVocabularyItems,
  sumPracticeMinutes,
  type ExerciseTotals,
} from '../repositories/progressRepository.js';

import { buildLevelHistoryEntry } from './levelHistory.js';
import { getProfile } from './profileService.js';

// ---------------------------------------------------------------------------
// Константы правил
// ---------------------------------------------------------------------------

/** Со скольких встреч слово перестаёт быть новым. */
const VOCABULARY_LEARNING_AFTER_SEEN = 2;

/** Сколько верных употреблений переводят слово в «знаю». */
const VOCABULARY_KNOWN_AFTER_CORRECT = 3;

/**
 * Уверенность в уровне после автоматического пересчёта: измерение есть, но сделано
 * оно на окне в несколько уроков, а не полноценным определением уровня.
 */
const PROGRESS_LEVEL_CONFIDENCE = 0.5;

/** Сколько последних дней с активностью попадает в `recentActivity` сводки. */
const RECENT_ACTIVITY_DAYS = 30;

/** На сколько дней назад ищутся серии занятий (`streakDays`). */
const STREAK_LOOKBACK_DAYS = 366;

/** Предельные длины полей контракта: значения обрезаются, а не отбрасываются. */
const MAX_TERM_LENGTH = 200;
const MAX_TRANSLATION_LENGTH = 300;
const MAX_PART_OF_SPEECH_LENGTH = 40;
const MAX_TRANSCRIPTION_LENGTH = 200;
const MAX_EXAMPLE_LENGTH = 600;
const MAX_CORRECTION_TEXT_LENGTH = 1000;
const MAX_TARGET_ITEM_LENGTH = 200;

/** Миллисекунд в сутках: шаг при подсчёте серий занятий. */
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Общие помощники
// ---------------------------------------------------------------------------

/** Обрезает строку до предела контракта; пустая строка означает «значения нет». */
function clampText(value: string | null | undefined, limit: number): string {
  return (value ?? '').trim().slice(0, limit);
}

/** Необязательное текстовое поле: пустое значение хранится как `NULL`. */
function optionalText(value: string | null | undefined, limit: number): string | null {
  const text = clampText(value, limit);

  return text === '' ? null : text;
}

// ---------------------------------------------------------------------------
// Личный словарь
// ---------------------------------------------------------------------------

/** Слово, встреченное на уроке или в материале. */
export interface VocabularyInput {
  /** Слово или выражение на изучаемом языке. */
  term: string;
  /** Перевод на язык объяснений: без него новое слово не сохраняется. */
  translation: string;
  /** Язык слова; по умолчанию — `learningLanguage` профиля. */
  language?: LanguageCode;
  /** Язык перевода; по умолчанию — `explanationLanguage` профиля. */
  translationLanguage?: LanguageCode;
  partOfSpeech?: string | null;
  transcription?: string | null;
  example?: string | null;
  level?: CefrLevel | null;
  /** Стадия, ниже которой слово не опустится; итоговая стадия — максимум из стадий. */
  status?: VocabularyStatus;
  lessonId?: Id | null;
  materialId?: Id | null;
  /** Слово употреблено верно: увеличивает `timesCorrect`. */
  correct?: boolean;
  /** Момент встречи; по умолчанию — сейчас. */
  seenAt?: string;
}

/** Стадия освоения по шкале `VOCABULARY_STATUSES`: чем больше, тем лучше усвоено. */
function statusRank(status: VocabularyStatus): number {
  return VOCABULARY_STATUSES.indexOf(status);
}

/** Более высокая из двух стадий: понижать стадию освоения нельзя. */
function maxStatus(left: VocabularyStatus, right: VocabularyStatus): VocabularyStatus {
  return statusRank(right) > statusRank(left) ? right : left;
}

/**
 * Стадия освоения по счётчикам: слово становится `learning` со второй встречи
 * и `known` после трёх верных употреблений. Уже достигнутая стадия сохраняется.
 */
function earnedVocabularyStatus(timesSeen: number, timesCorrect: number): VocabularyStatus {
  if (timesCorrect >= VOCABULARY_KNOWN_AFTER_CORRECT) {
    return 'known';
  }

  return timesSeen >= VOCABULARY_LEARNING_AFTER_SEEN ? 'learning' : 'new';
}

/** Слово после очередной встречи: счётчики, стадия и время последней встречи. */
function mergeVocabularyItem(
  existing: VocabularyItem | undefined,
  input: VocabularyInput,
  defaults: { language: LanguageCode; translationLanguage: LanguageCode },
  seenAt: string,
): VocabularyItem {
  const timesSeen = (existing?.timesSeen ?? 0) + 1;
  const timesCorrect = (existing?.timesCorrect ?? 0) + (input.correct === true ? 1 : 0);
  const status = maxStatus(
    maxStatus(earnedVocabularyStatus(timesSeen, timesCorrect), existing?.status ?? 'new'),
    input.status ?? 'new',
  );

  return {
    id: existing?.id ?? randomUUID(),
    // Написание фиксируется первой встречей: лемма у вариантов всё равно одна.
    term: existing?.term ?? clampText(input.term, MAX_TERM_LENGTH),
    translation:
      optionalText(input.translation, MAX_TRANSLATION_LENGTH) ?? existing?.translation ?? '',
    language: existing?.language ?? input.language ?? defaults.language,
    translationLanguage:
      input.translationLanguage ?? existing?.translationLanguage ?? defaults.translationLanguage,
    partOfSpeech:
      optionalText(input.partOfSpeech, MAX_PART_OF_SPEECH_LENGTH) ?? existing?.partOfSpeech ?? null,
    transcription:
      optionalText(input.transcription, MAX_TRANSCRIPTION_LENGTH) ??
      existing?.transcription ??
      null,
    example: optionalText(input.example, MAX_EXAMPLE_LENGTH) ?? existing?.example ?? null,
    level: input.level ?? existing?.level ?? null,
    status,
    timesSeen,
    timesCorrect,
    lessonId: input.lessonId ?? existing?.lessonId ?? null,
    materialId: input.materialId ?? existing?.materialId ?? null,
    firstSeenAt: existing?.firstSeenAt ?? seenAt,
    lastSeenAt: seenAt,
    createdAt: existing?.createdAt ?? seenAt,
    updatedAt: seenAt,
  };
}

/** То же слово после ещё одной встречи в задании: новых сведений о слове нет. */
function touchVocabularyItem(
  existing: VocabularyItem,
  correct: boolean,
  seenAt: string,
): VocabularyItem {
  const timesSeen = existing.timesSeen + 1;
  const timesCorrect = existing.timesCorrect + (correct ? 1 : 0);

  return {
    ...existing,
    status: maxStatus(earnedVocabularyStatus(timesSeen, timesCorrect), existing.status),
    timesSeen,
    timesCorrect,
    lastSeenAt: seenAt,
    updatedAt: seenAt,
  };
}

/** Ключ дедупликации внутри одного вызова: тот же, что у уникального индекса таблицы. */
function vocabularyKey(language: LanguageCode, term: string): string {
  return `${language}::${term.trim().toLowerCase()}`;
}

/**
 * Записывает встреченные слова: повторная запись не создаёт новую строку,
 * а увеличивает счётчики существующей (`UNIQUE (language, lemma)`).
 *
 * Элементы без слова или без перевода (например, обрывки ответа модели) пропускаются:
 * они не прошли бы `vocabularyItemSchema`. Возвращаются сохранённые слова в порядке
 * первого появления во входе.
 */
export function recordVocabulary(inputs: readonly VocabularyInput[]): VocabularyItem[] {
  if (inputs.length === 0) {
    return [];
  }

  const profile = getProfile();
  const defaults = {
    language: profile.learningLanguage,
    translationLanguage: profile.explanationLanguage,
  };
  const merged = new Map<string, VocabularyItem>();

  for (const input of inputs) {
    const term = clampText(input.term, MAX_TERM_LENGTH);
    const language = input.language ?? defaults.language;

    if (term === '') {
      continue;
    }

    const key = vocabularyKey(language, term);
    const existing = merged.get(key) ?? findVocabularyItem(language, term);

    if (existing === undefined && clampText(input.translation, MAX_TRANSLATION_LENGTH) === '') {
      continue;
    }

    merged.set(
      key,
      mergeVocabularyItem(
        existing,
        { ...input, term, language },
        defaults,
        input.seenAt ?? nowIso(),
      ),
    );
  }

  const items = [...merged.values()];

  saveVocabularyItems(items);

  return items;
}

/** Страница личного словаря для `GET /api/progress/vocabulary`. */
export function listVocabulary(query: ListVocabularyQuery): ListVocabularyResponse {
  return listVocabularyItems(query);
}

// ---------------------------------------------------------------------------
// Журнал ошибок
// ---------------------------------------------------------------------------

/** Контекст, в котором возникли исправления. */
export interface ErrorContext {
  /** Язык, на котором говорил ученик; по умолчанию — `learningLanguage` профиля. */
  language?: LanguageCode;
  stepId?: Id | null;
  exerciseId?: Id | null;
  messageId?: Id | null;
  /** Момент, когда ошибка возникла; по умолчанию — сейчас. */
  occurredAt?: string;
}

/** Исправление, пригодное для записи в журнал: иначе оно не прошло бы схему. */
function isRecordableCorrection(correction: Correction): boolean {
  return (
    ERROR_CATEGORIES.includes(correction.category) &&
    clampText(correction.original, MAX_CORRECTION_TEXT_LENGTH) !== '' &&
    clampText(correction.explanation, MAX_CORRECTION_TEXT_LENGTH) !== ''
  );
}

/**
 * Пишет исправления тьютора в журнал ошибок. `lessonId` — урок, на котором они
 * возникли, или `null` (например, определение уровня). Неполные исправления
 * пропускаются; возвращаются сохранённые записи.
 */
export function recordErrors(
  lessonId: Id | null,
  corrections: readonly Correction[],
  context: ErrorContext = {},
): ErrorLogEntry[] {
  if (corrections.length === 0) {
    return [];
  }

  const occurredAt = context.occurredAt ?? nowIso();
  const language = context.language ?? getProfile().learningLanguage;
  const entries: ErrorLogEntry[] = corrections.filter(isRecordableCorrection).map((correction) => ({
    id: randomUUID(),
    category: correction.category,
    severity: ERROR_SEVERITIES.includes(correction.severity) ? correction.severity : 'minor',
    original: clampText(correction.original, MAX_CORRECTION_TEXT_LENGTH),
    corrected: clampText(correction.corrected, MAX_CORRECTION_TEXT_LENGTH),
    explanation: clampText(correction.explanation, MAX_CORRECTION_TEXT_LENGTH),
    targetItem: optionalText(correction.targetItem, MAX_TARGET_ITEM_LENGTH),
    language,
    lessonId,
    stepId: context.stepId ?? null,
    exerciseId: context.exerciseId ?? null,
    messageId: context.messageId ?? null,
    occurredAt,
    createdAt: occurredAt,
  }));

  insertErrorLogEntries(entries);

  return entries;
}

/** Страница журнала ошибок для `GET /api/progress/errors`. */
export function listErrors(query: ListErrorsQuery): ListErrorsResponse {
  const page = listErrorLogEntries(query);
  // Счётчики — фасетные: учитывают все фильтры, КРОМЕ пагинации и собственного
  // `category`. Иначе при выборе одной категории остальные четыре обнулялись бы,
  // и UI, который рисует по ним переключатели, лишился бы возможности вернуться
  // к другой категории.
  const countsByCategory = countErrorsByCategory({
    ...(query.lessonId === undefined ? {} : { lessonId: query.lessonId }),
    ...(query.since === undefined ? {} : { since: query.since }),
    ...(query.until === undefined ? {} : { until: query.until }),
  });

  return { ...page, countsByCategory };
}

// ---------------------------------------------------------------------------
// Итоги заданий
// ---------------------------------------------------------------------------

/** Агрегат попыток вместе с долей верных ответов. */
export interface ExerciseAccuracy extends ExerciseTotals {
  /** Доля верных ответов, 0..1. */
  accuracy: number;
}

/** Результат задания, который нужно учесть в прогрессе. */
export interface ExerciseOutcomeInput {
  lessonId: Id;
  exerciseId?: Id | null;
  stepId?: Id | null;
  /** Ответ засчитан как верный. */
  isCorrect: boolean;
  /** Слова и конструкции, которые проверяло задание: счётчики словаря по ним растут. */
  targetItems?: readonly string[];
  /** Исправления тьютора к ответу: уходят в журнал ошибок. */
  corrections?: readonly Correction[];
  language?: LanguageCode;
  occurredAt?: string;
}

/** Что записано по итогу задания и как это изменило агрегаты. */
export interface ExerciseOutcomeResult {
  /** Записи журнала ошибок, созданные из `corrections`. */
  errors: ErrorLogEntry[];
  /** Слова словаря, счётчики которых обновились. */
  vocabulary: VocabularyItem[];
  /** Агрегат попыток этого урока. */
  lesson: ExerciseAccuracy;
  /** Агрегат попыток за всё время. */
  overall: ExerciseAccuracy;
}

/** Агрегат вместе с долей верных ответов. */
function toAccuracy(totals: ExerciseTotals): ExerciseAccuracy {
  return { ...totals, accuracy: accuracyRatio(totals.correct, totals.total) };
}

/**
 * Учитывает результат задания: пишет исправления в журнал ошибок, двигает счётчики
 * словаря по отработанным словам и возвращает агрегаты верных/неверных ответов.
 *
 * Сама попытка (`exercise_attempts`) сохраняется ходом урока, поэтому вызывать эту
 * функцию следует после её вставки — иначе попытка не попадёт в агрегаты.
 * Новых слов функция не создаёт: у `targetItems` нет перевода, поэтому обновляются
 * только уже известные словарю слова.
 */
export function recordExerciseOutcome(input: ExerciseOutcomeInput): ExerciseOutcomeResult {
  const occurredAt = input.occurredAt ?? nowIso();
  const language = input.language ?? getProfile().learningLanguage;
  const errors = recordErrors(input.lessonId, input.corrections ?? [], {
    language,
    stepId: input.stepId ?? null,
    exerciseId: input.exerciseId ?? null,
    occurredAt,
  });

  const touched = new Map<string, VocabularyItem>();

  for (const term of input.targetItems ?? []) {
    const clamped = clampText(term, MAX_TERM_LENGTH);

    if (clamped === '') {
      continue;
    }

    const key = vocabularyKey(language, clamped);
    const existing = touched.get(key) ?? findVocabularyItem(language, clamped);

    if (existing === undefined) {
      continue;
    }

    touched.set(key, touchVocabularyItem(existing, input.isCorrect, occurredAt));
  }

  const vocabulary = [...touched.values()];

  saveVocabularyItems(vocabulary);

  return {
    errors,
    vocabulary,
    lesson: toAccuracy(getExerciseTotalsForLessons([input.lessonId])),
    overall: toAccuracy(getExerciseTotals()),
  };
}

// ---------------------------------------------------------------------------
// Автокоррекция уровня (A13)
// ---------------------------------------------------------------------------

/** Статистика, по которой принимается решение об уровне. */
export interface LevelChangeInput {
  /** Уровень, записанный в профиле сейчас. */
  currentLevel: CefrLevel;
  /** Сколько уроков завершено за всё время. */
  completedLessons: number;
  /** Сколько уроков завершено после последнего изменения уровня. */
  lessonsSinceLastChange: number;
  /** Было ли вообще зафиксировано изменение уровня (иначе пауза не действует). */
  hasLevelChange: boolean;
  /** Доля верных ответов в окне, 0..1. */
  accuracy: number;
  /** Сколько завершённых уроков попало в окно. */
  lessonsConsidered: number;
  /** Сколько попыток учтено при расчёте `accuracy`. */
  exercisesEvaluated: number;
  windowFrom?: string | null;
  windowTo?: string | null;
}

/** Общая часть решения об уровне. */
interface LevelDecisionBase {
  fromLevel: CefrLevel;
  toLevel: CefrLevel;
  /** Человекочитаемое обоснование: уходит в `LevelHistoryEntry.reason`. */
  reason: string;
  /** Метрика, по которой принято решение. */
  metrics: LevelChangeMetrics;
  /** Готовность уровня к пересчёту — то же значение отдаётся в сводке. */
  eligibility: LevelEligibility;
}

/** Уровень остаётся прежним. */
export interface LevelUnchanged extends LevelDecisionBase {
  changed: false;
  direction: null;
}

/** Уровень меняется, но не больше чем на `maxStepsPerChange` ступеней. */
export interface LevelChanged extends LevelDecisionBase {
  changed: true;
  direction: 'up' | 'down';
}

/** Решение о пересчёте уровня. */
export type LevelDecision = LevelUnchanged | LevelChanged;

/** Результат попытки пересчитать уровень. */
export interface LevelAdjustment {
  /** Уровень изменён и записан в историю. */
  changed: boolean;
  /** Профиль после пересчёта (при `changed: false` — прежний). */
  profile: LearnerProfile;
  /** Запись истории уровня; `null`, если уровень остался прежним. */
  entry: LevelHistoryEntry | null;
  /** Решение целиком: обоснование, метрики и готовность к следующему пересчёту. */
  decision: LevelDecision;
}

/**
 * Решение об уровне по правилам `LEVEL_CHANGE_POLICY` (A13). Функция чистая:
 * никаких обращений к базе, только переданная статистика.
 *
 * Порядок проверок — от защит к порогам:
 * 1. пока завершено меньше `minCompletedLessons` уроков, уровень не трогаем;
 * 2. после любого изменения уровня действует пауза в `cooldownLessons` уроков;
 * 3. без единой оценённой попытки долю верных ответов считать не по чему;
 * 4. доля верных ответов в окне `windowLessons` сравнивается с `promoteAccuracy`
 *    и `demoteAccuracy`; уровень сдвигается не больше чем на `maxStepsPerChange`
 *    ступеней и не выходит за границы шкалы CEFR.
 */
export function decideLevelChange(input: LevelChangeInput): LevelDecision {
  const policy = LEVEL_CHANGE_POLICY;
  const accuracy = Math.min(1, Math.max(0, input.accuracy));
  const metrics: LevelChangeMetrics = {
    accuracy,
    lessonsConsidered: input.lessonsConsidered,
    lessonsSinceLastChange: input.lessonsSinceLastChange,
    exercisesEvaluated: input.exercisesEvaluated,
    windowFrom: input.windowFrom ?? null,
    windowTo: input.windowTo ?? null,
  };

  const keep = (reason: string, eligibility: LevelEligibility): LevelUnchanged => ({
    changed: false,
    direction: null,
    fromLevel: input.currentLevel,
    toLevel: input.currentLevel,
    reason,
    metrics,
    eligibility,
  });

  const lessonsUntilMinimum = Math.max(0, policy.minCompletedLessons - input.completedLessons);

  if (lessonsUntilMinimum > 0) {
    return keep(
      `Завершено ${String(input.completedLessons)} уроков из ${String(policy.minCompletedLessons)}: уровень пока не пересчитывается`,
      {
        canChange: false,
        lessonsUntilEligible: lessonsUntilMinimum,
        reason: `Уровень пересчитывается после ${String(policy.minCompletedLessons)} завершённых уроков: осталось ${String(lessonsUntilMinimum)}`,
      },
    );
  }

  const lessonsUntilCooldownEnds = input.hasLevelChange
    ? Math.max(0, policy.cooldownLessons - input.lessonsSinceLastChange)
    : 0;

  if (lessonsUntilCooldownEnds > 0) {
    return keep(
      `С последнего изменения уровня прошло ${String(input.lessonsSinceLastChange)} уроков из ${String(policy.cooldownLessons)}: уровень не меняется`,
      {
        canChange: false,
        lessonsUntilEligible: lessonsUntilCooldownEnds,
        reason: `После недавнего изменения уровня нужно ещё ${String(lessonsUntilCooldownEnds)} завершённых уроков`,
      },
    );
  }

  if (input.exercisesEvaluated === 0) {
    return keep('Нет оценённых заданий: долю верных ответов считать не по чему', {
      canChange: false,
      lessonsUntilEligible: 0,
      reason: 'В последних уроках нет оценённых заданий: уровень пересчитывать не по чему',
    });
  }

  const eligibility: LevelEligibility = {
    canChange: true,
    lessonsUntilEligible: 0,
    reason: `Доля верных ответов за последние ${String(input.lessonsConsidered)} уроков — ${formatPercent(accuracy)}; порог повышения ${formatPercent(policy.promoteAccuracy)}, понижения ${formatPercent(policy.demoteAccuracy)}`,
  };
  const window = `за последние ${String(input.lessonsConsidered)} уроков (${String(input.exercisesEvaluated)} заданий)`;

  if (accuracy >= policy.promoteAccuracy) {
    const toLevel = shiftLevel(input.currentLevel, policy.maxStepsPerChange);

    if (toLevel === input.currentLevel) {
      return keep(
        `Доля верных ответов ${formatPercent(accuracy)} ${window}, но ${input.currentLevel} — верх шкалы CEFR`,
        eligibility,
      );
    }

    return {
      changed: true,
      direction: 'up',
      fromLevel: input.currentLevel,
      toLevel,
      reason: `Доля верных ответов ${formatPercent(accuracy)} ${window} не ниже порога ${formatPercent(policy.promoteAccuracy)}: уровень повышен ${input.currentLevel} → ${toLevel}`,
      metrics,
      eligibility,
    };
  }

  if (accuracy < policy.demoteAccuracy) {
    const toLevel = shiftLevel(input.currentLevel, -policy.maxStepsPerChange);

    if (toLevel === input.currentLevel) {
      return keep(
        `Доля верных ответов ${formatPercent(accuracy)} ${window}, но ${input.currentLevel} — низ шкалы CEFR`,
        eligibility,
      );
    }

    return {
      changed: true,
      direction: 'down',
      fromLevel: input.currentLevel,
      toLevel,
      reason: `Доля верных ответов ${formatPercent(accuracy)} ${window} ниже порога ${formatPercent(policy.demoteAccuracy)}: уровень понижен ${input.currentLevel} → ${toLevel}`,
      metrics,
      eligibility,
    };
  }

  return keep(
    `Доля верных ответов ${formatPercent(accuracy)} ${window} между порогами ${formatPercent(policy.demoteAccuracy)} и ${formatPercent(policy.promoteAccuracy)}: уровень ${input.currentLevel} сохранён`,
    eligibility,
  );
}

/** Окно последних завершённых уроков и попытки внутри него. */
interface LevelWindow {
  lessonsConsidered: number;
  exercisesEvaluated: number;
  accuracy: number;
  from: string | null;
  to: string | null;
}

/** Окно `LEVEL_CHANGE_POLICY.windowLessons` последних завершённых уроков. */
function collectLevelWindow(): LevelWindow {
  const lessons = findRecentCompletedLessons(LEVEL_CHANGE_POLICY.windowLessons);
  const totals = getExerciseTotalsForLessons(lessons.map((lesson) => lesson.id));

  return {
    lessonsConsidered: lessons.length,
    exercisesEvaluated: totals.total,
    accuracy: accuracyRatio(totals.correct, totals.total),
    // Уроки отсортированы от свежего к раннему, поэтому границы окна берутся с краёв.
    from: lessons.at(-1)?.completedAt ?? null,
    to: lessons[0]?.completedAt ?? null,
  };
}

/** Статистика для `decideLevelChange()`, собранная из базы. */
function collectLevelChangeInput(
  profile: LearnerProfile,
  lastChange: LevelHistoryEntry | undefined,
): LevelChangeInput {
  const window = collectLevelWindow();

  return {
    currentLevel: profile.level,
    completedLessons: countLessonsByStatus().completed,
    lessonsSinceLastChange: countCompletedLessonsSince(lastChange?.changedAt ?? null),
    hasLevelChange: lastChange !== undefined,
    accuracy: window.accuracy,
    lessonsConsidered: window.lessonsConsidered,
    exercisesEvaluated: window.exercisesEvaluated,
    windowFrom: window.from,
    windowTo: window.to,
  };
}

/**
 * Пересчитывает уровень по накопленной статистике и, если правила это позволяют,
 * записывает изменение: профиль и запись истории (`source: 'progress'`) сохраняются
 * одной транзакцией. Вызывать после завершения урока; при `changed: false`
 * база не меняется вообще.
 */
export function maybeAdjustLevel(): LevelAdjustment {
  const profile = getProfile();
  const lastChange = findLatestLevelHistoryEntry();
  const decision = decideLevelChange(collectLevelChangeInput(profile, lastChange));

  if (!decision.changed) {
    return { changed: false, profile, entry: null, decision };
  }

  const changedAt = nowIso();
  // Запись собирается общим сборщиком: первая запись истории обязана быть
  // первичной установкой, даже если её повод — автокоррекция (см. levelHistory.ts).
  const entry: LevelHistoryEntry = buildLevelHistoryEntry({
    fromLevel: decision.fromLevel,
    toLevel: decision.toLevel,
    source: 'progress',
    confidence: PROGRESS_LEVEL_CONFIDENCE,
    reason: decision.reason,
    metrics: decision.metrics,
    changedAt,
  });
  const next: LearnerProfile = {
    ...profile,
    level: decision.toLevel,
    levelConfidence: PROGRESS_LEVEL_CONFIDENCE,
    updatedAt: changedAt,
  };
  // Признак пройденного онбординга в доменный профиль не входит, а пересчёт уровня
  // не должен его сбрасывать, поэтому текущее значение переносится как есть.
  const row = findProfileRow();

  saveProfileRow(
    learnerProfileToRow(next, {
      onboardingCompleted: row === undefined ? false : isOnboardingCompleted(row),
    }),
    { levelChange: entry },
  );

  return { changed: true, profile: next, entry, decision };
}

/** Страница истории уровня для `GET /api/progress/level-history`. */
export function listLevelHistory(query: ListLevelHistoryQuery): ListLevelHistoryResponse {
  return selectLevelHistory(query);
}

// ---------------------------------------------------------------------------
// Сводка прогресса
// ---------------------------------------------------------------------------

/** Серии занятий: текущая и самая длинная. */
export interface StudyStreaks {
  current: number;
  longest: number;
}

/** Календарная дата, сдвинутая на `days` суток. */
function shiftDate(date: string, days: number): string {
  return toIsoDate(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS);
}

/**
 * Серии занятий по дням с активностью (UTC). Дни принимаются в любом порядке.
 * Текущая серия считается, только если последнее занятие было сегодня или вчера:
 * иначе серия уже прервана.
 */
export function computeStreaks(
  days: readonly string[],
  today: string = toIsoDate(new Date()),
): StudyStreaks {
  const unique = [...new Set(days)].sort().reverse();

  if (unique.length === 0) {
    return { current: 0, longest: 0 };
  }

  let longest = 1;
  let run = 1;

  for (let index = 1; index < unique.length; index += 1) {
    const previous = unique[index - 1] as string;

    run = shiftDate(previous, -1) === unique[index] ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  const latest = unique[0] as string;
  let current = 0;

  if (latest === today || latest === shiftDate(today, -1)) {
    current = 1;

    for (let index = 1; index < unique.length; index += 1) {
      if (shiftDate(unique[index - 1] as string, -1) !== unique[index]) {
        break;
      }
      current += 1;
    }
  }

  return { current, longest };
}

/**
 * Сводка прогресса для `GET /api/progress/summary`.
 *
 * Только чтение: готовность уровня к пересчёту считается теми же правилами, что и
 * в `maybeAdjustLevel()`, но сам уровень здесь никогда не меняется — у GET не должно
 * быть побочных эффектов.
 */
export function getProgressSummary(): ProgressSummary {
  const profile = getProfile();
  const lastChange = findLatestLevelHistoryEntry();
  const input = collectLevelChangeInput(profile, lastChange);
  const decision = decideLevelChange(input);
  const totals = getExerciseTotals();
  const lessons = countLessonsByStatus();
  const streaks = computeStreaks(listActivityDates(STREAK_LOOKBACK_DAYS));

  return {
    level: profile.level,
    levelConfidence: profile.levelConfidence,
    learningLanguage: profile.learningLanguage,
    lessonsCompleted: lessons.completed,
    lessonsInProgress: lessons.inProgress,
    lessonsSinceLevelChange: input.lessonsSinceLastChange,
    practiceMinutes: sumPracticeMinutes(),
    exercisesTotal: totals.total,
    exercisesCorrect: totals.correct,
    accuracyOverall: accuracyRatio(totals.correct, totals.total),
    accuracyRecent: input.accuracy,
    streakDays: streaks.current,
    longestStreakDays: streaks.longest,
    vocabulary: getVocabularyStats(),
    errorsByCategory: countErrorsByCategory({}),
    recentActivity: listDailyActivity(RECENT_ACTIVITY_DAYS),
    levelEligibility: decision.eligibility,
    lastLevelChange: lastChange ?? null,
    updatedAt: nowIso(),
  };
}
