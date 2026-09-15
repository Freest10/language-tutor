/**
 * Прогресс: `GET /api/progress/summary`, `/vocabulary`, `/errors`, `/level-history`.
 */
import { z } from 'zod';

import {
  idSchema,
  isoDateSchema,
  isoDateTimeSchema,
  paginatedResponseSchema,
  paginationQuerySchema,
  sortOrderSchema,
} from './common.js';

import { cefrLevelSchema, languageCodeSchema, levelConfidenceSchema } from '../domain/language.js';
import {
  errorCategorySchema,
  errorLogEntrySchema,
  levelHistoryEntrySchema,
  vocabularyItemSchema,
  vocabularyStatusSchema,
} from '../domain/progress.js';

/** Активность за один день (для графика занятий). */
export const dailyActivitySchema = z.object({
  date: isoDateSchema,
  minutes: z.int().nonnegative(),
  lessons: z.int().nonnegative(),
  exercises: z.int().nonnegative(),
});

/** Активность за один день. */
export type DailyActivity = z.infer<typeof dailyActivitySchema>;

/** Сводка по словарю. */
export const vocabularyStatsSchema = z.object({
  total: z.int().nonnegative(),
  new: z.int().nonnegative(),
  learning: z.int().nonnegative(),
  known: z.int().nonnegative(),
});

/** Сводка по словарю. */
export type VocabularyStats = z.infer<typeof vocabularyStatsSchema>;

/**
 * Готовность уровня к пересчёту (допущение A13). `reason` объясняет пользователю,
 * почему уровень сейчас не меняется, на языке объяснений профиля.
 */
export const levelEligibilitySchema = z.object({
  canChange: z.boolean(),
  /** Сколько завершённых уроков осталось до ближайшей возможной переоценки. */
  lessonsUntilEligible: z.int().nonnegative(),
  reason: z.string().trim().min(1).max(500),
});

/** Готовность уровня к пересчёту. */
export type LevelEligibility = z.infer<typeof levelEligibilitySchema>;

/** Ответ `GET /api/progress/summary`. */
export const progressSummarySchema = z.object({
  level: cefrLevelSchema,
  levelConfidence: levelConfidenceSchema,
  learningLanguage: languageCodeSchema,
  lessonsCompleted: z.int().nonnegative(),
  lessonsInProgress: z.int().nonnegative(),
  /** Завершённых уроков с последнего изменения уровня (A13). */
  lessonsSinceLevelChange: z.int().nonnegative(),
  practiceMinutes: z.int().nonnegative(),
  exercisesTotal: z.int().nonnegative(),
  exercisesCorrect: z.int().nonnegative(),
  /** Доля верных ответов за всё время, 0..1. */
  accuracyOverall: z.number().min(0).max(1),
  /** Доля верных ответов в окне `LEVEL_CHANGE_POLICY.windowLessons`, 0..1. */
  accuracyRecent: z.number().min(0).max(1),
  streakDays: z.int().nonnegative(),
  longestStreakDays: z.int().nonnegative(),
  vocabulary: vocabularyStatsSchema,
  /** Счётчики по всем категориям ошибок: ключи перечислены целиком. */
  errorsByCategory: z.record(errorCategorySchema, z.int().nonnegative()),
  recentActivity: z.array(dailyActivitySchema).max(366).default([]),
  levelEligibility: levelEligibilitySchema,
  lastLevelChange: levelHistoryEntrySchema.nullish(),
  updatedAt: isoDateTimeSchema,
});

/** Сводка прогресса. */
export type ProgressSummary = z.infer<typeof progressSummarySchema>;

/** Ответ `GET /api/progress/summary`. */
export const getProgressSummaryResponseSchema = progressSummarySchema;

/** Ответ `GET /api/progress/summary`. */
export type GetProgressSummaryResponse = ProgressSummary;

/** Поля сортировки словаря. */
export const VOCABULARY_SORT_FIELDS = ['recent', 'alphabetical', 'timesSeen'] as const;

/** Поле сортировки словаря. */
export type VocabularySortField = (typeof VOCABULARY_SORT_FIELDS)[number];

/** Поле сортировки словаря. */
export const vocabularySortFieldSchema = z.enum(VOCABULARY_SORT_FIELDS);

/** Query `GET /api/progress/vocabulary`. */
export const listVocabularyQuerySchema = paginationQuerySchema.extend({
  status: vocabularyStatusSchema.optional(),
  language: languageCodeSchema.optional(),
  lessonId: idSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
  sort: vocabularySortFieldSchema.default('recent'),
  order: sortOrderSchema.default('desc'),
});

/** Query `GET /api/progress/vocabulary`. */
export type ListVocabularyQuery = z.infer<typeof listVocabularyQuerySchema>;

/** Ответ `GET /api/progress/vocabulary`. */
export const listVocabularyResponseSchema = paginatedResponseSchema(vocabularyItemSchema);

/** Ответ `GET /api/progress/vocabulary`. */
export type ListVocabularyResponse = z.infer<typeof listVocabularyResponseSchema>;

/** Query `GET /api/progress/errors`. */
export const listErrorsQuerySchema = paginationQuerySchema.extend({
  category: errorCategorySchema.optional(),
  lessonId: idSchema.optional(),
  /** Нижняя граница по времени возникновения, включительно. */
  since: isoDateTimeSchema.optional(),
  /** Верхняя граница по времени возникновения, включительно. */
  until: isoDateTimeSchema.optional(),
  order: sortOrderSchema.default('desc'),
});

/** Query `GET /api/progress/errors`. */
export type ListErrorsQuery = z.infer<typeof listErrorsQuerySchema>;

/** Ответ `GET /api/progress/errors`. */
export const listErrorsResponseSchema = paginatedResponseSchema(errorLogEntrySchema).extend({
  /** Счётчики по всем категориям с учётом фильтров, кроме пагинации. */
  countsByCategory: z.record(errorCategorySchema, z.int().nonnegative()),
});

/** Ответ `GET /api/progress/errors`. */
export type ListErrorsResponse = z.infer<typeof listErrorsResponseSchema>;

/** Query `GET /api/progress/level-history`. */
export const listLevelHistoryQuerySchema = paginationQuerySchema.extend({
  order: sortOrderSchema.default('desc'),
});

/** Query `GET /api/progress/level-history`. */
export type ListLevelHistoryQuery = z.infer<typeof listLevelHistoryQuerySchema>;

/** Ответ `GET /api/progress/level-history`. */
export const listLevelHistoryResponseSchema = paginatedResponseSchema(levelHistoryEntrySchema);

/** Ответ `GET /api/progress/level-history`. */
export type ListLevelHistoryResponse = z.infer<typeof listLevelHistoryResponseSchema>;
