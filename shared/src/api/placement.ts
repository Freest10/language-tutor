/**
 * Определение уровня:
 * `POST /api/placement/sessions`,
 * `POST /api/placement/sessions/:id/turns`,
 * `POST /api/placement/sessions/:id/finish`.
 */
import { z } from 'zod';

import { idParamSchema, idSchema } from './common.js';

import { languageCodeSchema } from '../domain/language.js';
import { messageSourceSchema } from '../domain/lesson.js';
import {
  PLACEMENT_MAX_TURNS_LIMIT,
  placementResultSchema,
  placementSessionSchema,
  placementTurnSchema,
} from '../domain/placement.js';
import { learnerProfileSchema } from '../domain/profile.js';

/** Параметры маршрутов `/api/placement/sessions/:id/...`. */
export const placementSessionParamsSchema = idParamSchema;

/** Параметры маршрутов сессии определения уровня. */
export type PlacementSessionParams = z.infer<typeof placementSessionParamsSchema>;

/** Тело `POST /api/placement/sessions`; все поля по умолчанию берутся из профиля. */
export const createPlacementSessionRequestSchema = z.object({
  learningLanguage: languageCodeSchema.optional(),
  explanationLanguage: languageCodeSchema.optional(),
  maxTurns: z.int().min(1).max(PLACEMENT_MAX_TURNS_LIMIT).optional(),
});

/** Тело `POST /api/placement/sessions`. */
export type CreatePlacementSessionRequest = z.infer<typeof createPlacementSessionRequestSchema>;

/** Ответ `POST /api/placement/sessions`: сессия и первый вопрос. */
export const createPlacementSessionResponseSchema = z.object({
  session: placementSessionSchema,
  /** Вопрос, на который ждут ответа; `null` — вопросов больше нет. */
  nextTurn: placementTurnSchema.nullish(),
});

/** Ответ `POST /api/placement/sessions`. */
export type CreatePlacementSessionResponse = z.infer<typeof createPlacementSessionResponseSchema>;

/** Тело `POST /api/placement/sessions/:id/turns`: ответ на конкретный вопрос. */
export const submitPlacementTurnRequestSchema = z.object({
  turnId: idSchema,
  answer: z.string().trim().min(1).max(4000),
  source: messageSourceSchema.default('text'),
  durationMs: z.int().nonnegative().optional(),
});

/** Тело `POST /api/placement/sessions/:id/turns`. */
export type SubmitPlacementTurnRequest = z.infer<typeof submitPlacementTurnRequestSchema>;

/** Ответ `POST /api/placement/sessions/:id/turns`. */
export const submitPlacementTurnResponseSchema = z.object({
  session: placementSessionSchema,
  /** Оценённый ход: тот же вопрос с ответом, оценкой и разбором. */
  evaluatedTurn: placementTurnSchema,
  nextTurn: placementTurnSchema.nullish(),
  /** `true` — вопросы кончились, пора вызывать `/finish`. */
  finished: z.boolean(),
});

/** Ответ `POST /api/placement/sessions/:id/turns`. */
export type SubmitPlacementTurnResponse = z.infer<typeof submitPlacementTurnResponseSchema>;

/** Тело `POST /api/placement/sessions/:id/finish`. */
export const finishPlacementSessionRequestSchema = z.object({
  /** Записать полученный уровень в профиль и в историю уровня. */
  applyToProfile: z.boolean().default(true),
});

/** Тело `POST /api/placement/sessions/:id/finish`. */
export type FinishPlacementSessionRequest = z.infer<typeof finishPlacementSessionRequestSchema>;

/** Ответ `POST /api/placement/sessions/:id/finish`. */
export const finishPlacementSessionResponseSchema = z.object({
  session: placementSessionSchema,
  result: placementResultSchema,
  /** Обновлённый профиль; `null`, если `applyToProfile: false`. */
  profile: learnerProfileSchema.nullish(),
});

/** Ответ `POST /api/placement/sessions/:id/finish`. */
export type FinishPlacementSessionResponse = z.infer<typeof finishPlacementSessionResponseSchema>;
