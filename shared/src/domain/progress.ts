/** Прогресс ученика: словарь, журнал ошибок, история изменения уровня. */
import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from '../api/common.js';

import { cefrLevelSchema, languageCodeSchema, levelConfidenceSchema } from './language.js';

/** Категории ошибок ученика. */
export const ERROR_CATEGORIES = [
  'grammar',
  'vocabulary',
  'pronunciation',
  'fluency',
  'spelling',
] as const;

/** Категория ошибки ученика. */
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** Категория ошибки ученика. */
export const errorCategorySchema = z.enum(ERROR_CATEGORIES);

/** Тяжесть ошибки: `minor` — не мешает пониманию, `major` — мешает. */
export const ERROR_SEVERITIES = ['minor', 'major'] as const;

/** Тяжесть ошибки. */
export type ErrorSeverity = (typeof ERROR_SEVERITIES)[number];

/** Тяжесть ошибки. */
export const errorSeveritySchema = z.enum(ERROR_SEVERITIES);

/**
 * Единичное исправление реплики или ответа ученика.
 * `explanation` пишется на `explanationLanguage` профиля.
 */
export const correctionSchema = z.object({
  category: errorCategorySchema,
  severity: errorSeveritySchema.default('minor'),
  original: z.string().trim().min(1).max(1000),
  corrected: z.string().trim().max(1000).default(''),
  explanation: z.string().trim().min(1).max(1000),
  targetItem: z.string().trim().max(200).nullish(),
});

/** Единичное исправление реплики или ответа ученика. */
export type Correction = z.infer<typeof correctionSchema>;

/** Стадии освоения слова. */
export const VOCABULARY_STATUSES = ['new', 'learning', 'known'] as const;

/** Стадия освоения слова. */
export type VocabularyStatus = (typeof VOCABULARY_STATUSES)[number];

/** Стадия освоения слова. */
export const vocabularyStatusSchema = z.enum(VOCABULARY_STATUSES);

/** Слово или выражение в личном словаре ученика. */
export const vocabularyItemSchema = z.object({
  id: idSchema,
  term: z.string().trim().min(1).max(200),
  translation: z.string().trim().min(1).max(300),
  /** Язык слова (обычно `learningLanguage` профиля). */
  language: languageCodeSchema,
  /** Язык перевода (обычно `explanationLanguage` профиля). */
  translationLanguage: languageCodeSchema,
  partOfSpeech: z.string().trim().max(40).nullish(),
  transcription: z.string().trim().max(200).nullish(),
  example: z.string().trim().max(600).nullish(),
  level: cefrLevelSchema.nullish(),
  status: vocabularyStatusSchema,
  timesSeen: z.int().nonnegative(),
  timesCorrect: z.int().nonnegative(),
  lessonId: idSchema.nullish(),
  materialId: idSchema.nullish(),
  firstSeenAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/** Слово или выражение в личном словаре ученика. */
export type VocabularyItem = z.infer<typeof vocabularyItemSchema>;

/** Запись журнала ошибок: исправление плюс контекст, в котором оно возникло. */
export const errorLogEntrySchema = correctionSchema.extend({
  id: idSchema,
  language: languageCodeSchema,
  lessonId: idSchema.nullish(),
  stepId: idSchema.nullish(),
  exerciseId: idSchema.nullish(),
  messageId: idSchema.nullish(),
  occurredAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
});

/** Запись журнала ошибок. */
export type ErrorLogEntry = z.infer<typeof errorLogEntrySchema>;

/** Направление изменения уровня. */
export const LEVEL_CHANGE_DIRECTIONS = ['initial', 'up', 'down'] as const;

/** Направление изменения уровня. */
export type LevelChangeDirection = (typeof LEVEL_CHANGE_DIRECTIONS)[number];

/** Направление изменения уровня. */
export const levelChangeDirectionSchema = z.enum(LEVEL_CHANGE_DIRECTIONS);

/** Что стало причиной изменения уровня. */
export const LEVEL_CHANGE_SOURCES = ['placement', 'progress', 'manual'] as const;

/** Что стало причиной изменения уровня. */
export type LevelChangeSource = (typeof LEVEL_CHANGE_SOURCES)[number];

/** Что стало причиной изменения уровня. */
export const levelChangeSourceSchema = z.enum(LEVEL_CHANGE_SOURCES);

/**
 * Правила автоматического пересчёта уровня (допущение A13).
 * Единственный источник значений: сервер считает по ним, клиент по ним объясняет.
 */
export const LEVEL_CHANGE_POLICY = {
  /** Уровень не пересчитывается, пока не завершено столько уроков. */
  minCompletedLessons: 3,
  /** Окно, по которому усредняется результат. */
  windowLessons: 3,
  /** Доля верных ответов в окне, начиная с которой уровень повышается. */
  promoteAccuracy: 0.85,
  /** Доля верных ответов в окне, ниже которой уровень понижается. */
  demoteAccuracy: 0.5,
  /** Минимум уроков между двумя изменениями уровня. */
  cooldownLessons: 3,
  /** За одно изменение уровень сдвигается не более чем на столько ступеней CEFR. */
  maxStepsPerChange: 1,
} as const;

/** Измеримое основание изменения уровня (допущение A13). */
export const levelChangeMetricsSchema = z.object({
  /** Доля верных ответов в окне, 0..1. */
  accuracy: z.number().min(0).max(1),
  /** Сколько завершённых уроков попало в окно. */
  lessonsConsidered: z.int().nonnegative(),
  /** Сколько уроков прошло с предыдущего изменения уровня. */
  lessonsSinceLastChange: z.int().nonnegative(),
  /** Сколько попыток учтено при расчёте `accuracy`. */
  exercisesEvaluated: z.int().nonnegative(),
  windowFrom: isoDateTimeSchema.nullish(),
  windowTo: isoDateTimeSchema.nullish(),
});

/** Измеримое основание изменения уровня. */
export type LevelChangeMetrics = z.infer<typeof levelChangeMetricsSchema>;

/**
 * Запись истории уровня. Хранит и человекочитаемое обоснование (`reason`),
 * и метрику, по которой принято решение (`metrics`) — допущение A13.
 */
export const levelHistoryEntrySchema = z.object({
  id: idSchema,
  /** `null` — первичная установка уровня. */
  fromLevel: cefrLevelSchema.nullish(),
  toLevel: cefrLevelSchema,
  direction: levelChangeDirectionSchema,
  source: levelChangeSourceSchema,
  confidence: levelConfidenceSchema,
  reason: z.string().trim().min(1).max(1000),
  metrics: levelChangeMetricsSchema,
  changedAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
});

/** Запись истории уровня. */
export type LevelHistoryEntry = z.infer<typeof levelHistoryEntrySchema>;
