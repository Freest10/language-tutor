/** Определение исходного уровня: сессия из нескольких вопросов и её результат. */
import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from '../api/common.js';

import { cefrLevelSchema, languageCodeSchema, levelConfidenceSchema } from './language.js';
import { messageSourceSchema } from './lesson.js';

/** Состояние сессии определения уровня. */
export const PLACEMENT_SESSION_STATUSES = ['in_progress', 'completed', 'abandoned'] as const;

/** Состояние сессии определения уровня. */
export type PlacementSessionStatus = (typeof PLACEMENT_SESSION_STATUSES)[number];

/** Состояние сессии определения уровня. */
export const placementSessionStatusSchema = z.enum(PLACEMENT_SESSION_STATUSES);

/** Навык, который проверяет вопрос. */
export const PLACEMENT_SKILLS = ['grammar', 'vocabulary', 'comprehension', 'speaking'] as const;

/** Навык, который проверяет вопрос. */
export type PlacementSkill = (typeof PLACEMENT_SKILLS)[number];

/** Навык, который проверяет вопрос. */
export const placementSkillSchema = z.enum(PLACEMENT_SKILLS);

/** Число вопросов в сессии по умолчанию. */
export const PLACEMENT_DEFAULT_MAX_TURNS = 8;

/** Предельное число вопросов в сессии. */
export const PLACEMENT_MAX_TURNS_LIMIT = 30;

/** Вопрос определения уровня вместе с ответом и оценкой (если ответ уже дан). */
export const placementTurnSchema = z.object({
  id: idSchema,
  sessionId: idSchema,
  /** Порядковый номер вопроса в сессии, с нуля. */
  order: z.int().nonnegative(),
  question: z.string().trim().min(1).max(2000),
  /** Язык, на котором задан вопрос. */
  questionLanguage: languageCodeSchema,
  /** Уровень, который проверяет вопрос. */
  targetLevel: cefrLevelSchema,
  skill: placementSkillSchema,
  answer: z.string().trim().max(4000).nullish(),
  source: messageSourceSchema.nullish(),
  /** Оценка ответа, 0..1. */
  score: z.number().min(0).max(1).nullish(),
  /** Разбор ответа на языке объяснений сессии. */
  feedback: z.string().trim().max(2000).nullish(),
  /** Промежуточная оценка уровня после этого ответа. */
  estimatedLevel: cefrLevelSchema.nullish(),
  askedAt: isoDateTimeSchema,
  answeredAt: isoDateTimeSchema.nullish(),
});

/** Вопрос определения уровня. */
export type PlacementTurn = z.infer<typeof placementTurnSchema>;

/** Результат определения уровня: он же обоснование записи в истории уровня. */
export const placementResultSchema = z.object({
  level: cefrLevelSchema,
  confidence: levelConfidenceSchema,
  /** Человекочитаемое обоснование оценки на языке объяснений сессии. */
  rationale: z.string().trim().min(1).max(2000),
  strengths: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  weaknesses: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  recommendedGoals: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  turnsEvaluated: z.int().nonnegative(),
  /** Доля верных ответов в сессии, 0..1. */
  accuracy: z.number().min(0).max(1),
});

/** Результат определения уровня. */
export type PlacementResult = z.infer<typeof placementResultSchema>;

/** Сессия определения уровня. */
export const placementSessionSchema = z.object({
  id: idSchema,
  status: placementSessionStatusSchema,
  learningLanguage: languageCodeSchema,
  explanationLanguage: languageCodeSchema,
  maxTurns: z.int().min(1).max(PLACEMENT_MAX_TURNS_LIMIT),
  turns: z.array(placementTurnSchema).max(PLACEMENT_MAX_TURNS_LIMIT).default([]),
  /** Заполняется при завершении сессии. */
  result: placementResultSchema.nullish(),
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullish(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/** Сессия определения уровня. */
export type PlacementSession = z.infer<typeof placementSessionSchema>;
