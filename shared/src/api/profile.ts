/** `GET /api/profile`, `PUT /api/profile`. */
import { z } from 'zod';

import {
  dailyMinutesSchema,
  learnerGoalSchema,
  learnerInterestSchema,
  learnerProfileSchema,
  MAX_LEARNER_GOALS,
  MAX_LEARNER_INTERESTS,
} from '../domain/profile.js';
import { cefrLevelSchema, languageCodeSchema } from '../domain/language.js';

/** Ответ `GET /api/profile`. */
export const getProfileResponseSchema = learnerProfileSchema;

/** Ответ `GET /api/profile`. */
export type GetProfileResponse = z.infer<typeof getProfileResponseSchema>;

/**
 * Тело `PUT /api/profile`: частичное обновление, нужно хотя бы одно поле.
 * `levelConfidence` не обновляется вручную — его пересчитывает сервер;
 * ручная смена `level` фиксируется в истории уровня с `source: 'manual'`.
 */
export const updateProfileRequestSchema = z
  .object({
    learningLanguage: languageCodeSchema.optional(),
    interfaceLanguage: languageCodeSchema.optional(),
    explanationLanguage: languageCodeSchema.optional(),
    level: cefrLevelSchema.optional(),
    goals: z.array(learnerGoalSchema).min(1).max(MAX_LEARNER_GOALS).optional(),
    interests: z.array(learnerInterestSchema).max(MAX_LEARNER_INTERESTS).optional(),
    dailyMinutes: dailyMinutesSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Нужно передать хотя бы одно поле профиля',
  });

/** Тело `PUT /api/profile`. */
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

/** Ответ `PUT /api/profile`. */
export const updateProfileResponseSchema = learnerProfileSchema;

/** Ответ `PUT /api/profile`. */
export type UpdateProfileResponse = z.infer<typeof updateProfileResponseSchema>;
