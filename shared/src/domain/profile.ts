/** Профиль ученика: языки, уровень, цели, интересы, дневная норма. */
import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from '../api/common.js';

import { cefrLevelSchema, languageCodeSchema, levelConfidenceSchema } from './language.js';

/** Учебная цель: свободный текст («заказать кофе», «пройти собеседование»). */
export const learnerGoalSchema = z.string().trim().min(1).max(120);

/** Максимум целей в профиле (пустой список недопустим). */
export const MAX_LEARNER_GOALS = 10;

/** Интерес ученика: свободный текст, используется при подборе тем и материалов. */
export const learnerInterestSchema = z.string().trim().min(1).max(60);

/** Максимум интересов в профиле. */
export const MAX_LEARNER_INTERESTS = 20;

/** Минимальная дневная норма занятий, минуты. */
export const MIN_DAILY_MINUTES = 5;

/** Максимальная дневная норма занятий, минуты. */
export const MAX_DAILY_MINUTES = 240;

/** Дневная норма занятий по умолчанию, минуты. */
export const DEFAULT_DAILY_MINUTES = 20;

/** Дневная норма занятий, минуты. */
export const dailyMinutesSchema = z.int().min(MIN_DAILY_MINUTES).max(MAX_DAILY_MINUTES);

/**
 * Профиль ученика. Приложение однопользовательское: профиль один.
 *
 * Допущение A12: три независимых языка.
 * - `learningLanguage` — что изучаем;
 * - `interfaceLanguage` — язык интерфейса;
 * - `explanationLanguage` — на каком языке тьютор объясняет правила и ошибки
 *   (на A1 обычно родной, на C1 — изучаемый); задаётся отдельно и осознанно.
 */
export const learnerProfileSchema = z.object({
  id: idSchema,
  learningLanguage: languageCodeSchema,
  interfaceLanguage: languageCodeSchema,
  explanationLanguage: languageCodeSchema,
  level: cefrLevelSchema,
  levelConfidence: levelConfidenceSchema,
  /** Минимум одна цель: без цели невозможно спланировать урок. */
  goals: z.array(learnerGoalSchema).min(1).max(MAX_LEARNER_GOALS),
  interests: z.array(learnerInterestSchema).max(MAX_LEARNER_INTERESTS).default([]),
  dailyMinutes: dailyMinutesSchema,
  /** Когда в последний раз завершено определение уровня; `null` — ни разу. */
  placementCompletedAt: isoDateTimeSchema.nullish(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/** Профиль ученика. */
export type LearnerProfile = z.infer<typeof learnerProfileSchema>;
