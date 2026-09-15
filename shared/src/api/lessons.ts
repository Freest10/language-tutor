/**
 * Уроки: `GET /api/lessons`, `POST /api/lessons`, `GET /api/lessons/:id`,
 * `POST /api/lessons/:id/plan/regenerate`.
 * Ход урока описан в `api/lessonSession.ts`.
 */
import { z } from 'zod';

import {
  idParamSchema,
  idSchema,
  paginatedResponseSchema,
  paginationQuerySchema,
} from './common.js';

import { exerciseAttemptSchema, exerciseSchema } from '../domain/exercise.js';
import { cefrLevelSchema, languageCodeSchema } from '../domain/language.js';
import { lessonSchema, lessonStatusSchema, lessonStepTypeSchema } from '../domain/lesson.js';
import { learnerGoalSchema, MAX_LEARNER_GOALS } from '../domain/profile.js';

/** Query `GET /api/lessons`. */
export const listLessonsQuerySchema = paginationQuerySchema.extend({
  status: lessonStatusSchema.optional(),
  language: languageCodeSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

/** Query `GET /api/lessons`. */
export type ListLessonsQuery = z.infer<typeof listLessonsQuerySchema>;

/** Ответ `GET /api/lessons`: уроки от новых к старым. */
export const listLessonsResponseSchema = paginatedResponseSchema(lessonSchema);

/** Ответ `GET /api/lessons`. */
export type ListLessonsResponse = z.infer<typeof listLessonsResponseSchema>;

/**
 * Тело `POST /api/lessons`. Всё необязательно: без параметров сервер
 * планирует урок по профилю (уровень, цели, интересы, дневная норма).
 */
export const createLessonRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  topic: z.string().trim().min(1).max(200).optional(),
  /** Материалы, на которых строится урок. */
  materialIds: z.array(idSchema).max(20).optional(),
  /** Виды шагов, на которых просят сделать акцент. */
  focus: z.array(lessonStepTypeSchema).max(8).optional(),
  /** Уровень урока; по умолчанию — уровень профиля. */
  level: cefrLevelSchema.optional(),
  /** Длительность урока; по умолчанию — `dailyMinutes` профиля. */
  durationMinutes: z.int().min(5).max(240).optional(),
  goals: z.array(learnerGoalSchema).max(MAX_LEARNER_GOALS).optional(),
});

/** Тело `POST /api/lessons`. */
export type CreateLessonRequest = z.infer<typeof createLessonRequestSchema>;

/** Ответ `POST /api/lessons`: урок в статусе `draft` со сгенерированным планом. */
export const createLessonResponseSchema = lessonSchema;

/** Ответ `POST /api/lessons`. */
export type CreateLessonResponse = z.infer<typeof createLessonResponseSchema>;

/** Параметры маршрутов `/api/lessons/:id/...`. */
export const lessonParamsSchema = idParamSchema;

/** Параметры маршрутов урока. */
export type LessonParams = z.infer<typeof lessonParamsSchema>;

/** Ответ `GET /api/lessons/:id`: урок целиком, без реплик диалога. */
export const getLessonResponseSchema = z.object({
  lesson: lessonSchema,
  exercises: z.array(exerciseSchema).default([]),
  attempts: z.array(exerciseAttemptSchema).default([]),
});

/** Ответ `GET /api/lessons/:id`. */
export type GetLessonResponse = z.infer<typeof getLessonResponseSchema>;

/** Тело `POST /api/lessons/:id/plan/regenerate`. */
export const regenerateLessonPlanRequestSchema = z.object({
  /** Пожелание пользователя к новому плану. */
  feedback: z.string().trim().min(1).max(1000).optional(),
  /** Сохранить уже пройденные шаги и перепланировать только оставшиеся. */
  keepCompletedSteps: z.boolean().default(true),
});

/** Тело `POST /api/lessons/:id/plan/regenerate`. */
export type RegenerateLessonPlanRequest = z.infer<typeof regenerateLessonPlanRequestSchema>;

/** Ответ `POST /api/lessons/:id/plan/regenerate`. */
export const regenerateLessonPlanResponseSchema = lessonSchema;

/** Ответ `POST /api/lessons/:id/plan/regenerate`. */
export type RegenerateLessonPlanResponse = z.infer<typeof regenerateLessonPlanResponseSchema>;
