/**
 * Ход урока: `POST /api/lessons/:id/start`, `.../complete`, `.../turns`,
 * `POST /api/lessons/:id/steps/:stepId/advance`,
 * `POST /api/lessons/:id/exercises/:exerciseId/attempts`,
 * `GET /api/lessons/:id/messages`.
 *
 * Допущение A9: ответы модели не стримятся — каждый вызов возвращает
 * готовый результат целиком.
 */
import { z } from 'zod';

import {
  idSchema,
  paginatedResponseSchema,
  paginationQuerySchema,
  sortOrderSchema,
} from './common.js';

import { exerciseAttemptSchema, exerciseSchema } from '../domain/exercise.js';
import {
  lessonMessageRoleSchema,
  lessonMessageSchema,
  lessonPlanStepSchema,
  lessonSchema,
  lessonSummarySchema,
  messageSourceSchema,
} from '../domain/lesson.js';
import {
  correctionSchema,
  errorLogEntrySchema,
  levelHistoryEntrySchema,
  vocabularyItemSchema,
} from '../domain/progress.js';

/** Тело `POST /api/lessons/:id/start`: параметров нет, допустимо пустое тело. */
export const startLessonRequestSchema = z.object({});

/** Тело `POST /api/lessons/:id/start`. */
export type StartLessonRequest = z.infer<typeof startLessonRequestSchema>;

/** Ответ `POST /api/lessons/:id/start`: урок переходит в `in_progress`. */
export const startLessonResponseSchema = z.object({
  lesson: lessonSchema,
  /** Вступительные реплики тьютора. */
  messages: z.array(lessonMessageSchema).default([]),
  currentStep: lessonPlanStepSchema.nullish(),
});

/** Ответ `POST /api/lessons/:id/start`. */
export type StartLessonResponse = z.infer<typeof startLessonResponseSchema>;

/** Тело `POST /api/lessons/:id/complete`; допустимо пустое тело. */
export const completeLessonRequestSchema = z.object({
  /** Заметка пользователя об уроке. */
  notes: z.string().trim().max(2000).optional(),
  /** Фактическая длительность, если клиент её измерял. */
  durationMinutes: z.int().nonnegative().max(600).optional(),
});

/** Тело `POST /api/lessons/:id/complete`. */
export type CompleteLessonRequest = z.infer<typeof completeLessonRequestSchema>;

/**
 * Ответ `POST /api/lessons/:id/complete`.
 * `levelChange` заполняется, только если сработали правила A13
 * (`LEVEL_CHANGE_POLICY`); иначе `null`.
 */
export const completeLessonResponseSchema = z.object({
  lesson: lessonSchema,
  summary: lessonSummarySchema,
  levelChange: levelHistoryEntrySchema.nullish(),
  vocabularyAdded: z.array(vocabularyItemSchema).default([]),
  errorsLogged: z.array(errorLogEntrySchema).default([]),
});

/** Ответ `POST /api/lessons/:id/complete`. */
export type CompleteLessonResponse = z.infer<typeof completeLessonResponseSchema>;

/** Тело `POST /api/lessons/:id/turns`: реплика ученика. */
export const lessonTurnRequestSchema = z.object({
  /** Текст реплики; для голоса — расшифровка из `POST /api/voice/stt`. */
  text: z.string().trim().min(1).max(4000),
  source: messageSourceSchema.default('text'),
  /** Шаг, к которому относится реплика; по умолчанию — текущий шаг урока. */
  stepId: idSchema.optional(),
  durationMs: z.int().nonnegative().optional(),
});

/** Тело `POST /api/lessons/:id/turns`. */
export type LessonTurnRequest = z.infer<typeof lessonTurnRequestSchema>;

/** Ответ `POST /api/lessons/:id/turns`: сохранённая реплика и ответ тьютора. */
export const lessonTurnResponseSchema = z.object({
  userMessage: lessonMessageSchema,
  tutorMessage: lessonMessageSchema,
  /** Исправления к реплике ученика (дублируют `userMessage.corrections`). */
  corrections: z.array(correctionSchema).default([]),
  lesson: lessonSchema,
  currentStep: lessonPlanStepSchema.nullish(),
  /** Задания, выданные тьютором в этом ходе. */
  exercises: z.array(exerciseSchema).default([]),
});

/** Ответ `POST /api/lessons/:id/turns`. */
export type LessonTurnResponse = z.infer<typeof lessonTurnResponseSchema>;

/** Параметры `POST /api/lessons/:id/steps/:stepId/advance`. */
export const lessonStepParamsSchema = z.object({ id: idSchema, stepId: idSchema });

/** Параметры маршрута шага урока. */
export type LessonStepParams = z.infer<typeof lessonStepParamsSchema>;

/** Тело `POST /api/lessons/:id/steps/:stepId/advance`. */
export const advanceLessonStepRequestSchema = z.object({
  /** Чем закончился шаг. */
  status: z.enum(['completed', 'skipped']).default('completed'),
  /** Комментарий, который стоит учесть на следующем шаге. */
  note: z.string().trim().max(1000).optional(),
});

/** Тело `POST /api/lessons/:id/steps/:stepId/advance`. */
export type AdvanceLessonStepRequest = z.infer<typeof advanceLessonStepRequestSchema>;

/** Ответ `POST /api/lessons/:id/steps/:stepId/advance`. */
export const advanceLessonStepResponseSchema = z.object({
  lesson: lessonSchema,
  /** Следующий шаг; `null` — план пройден до конца. */
  currentStep: lessonPlanStepSchema.nullish(),
  /** Реплики тьютора, открывающие новый шаг. */
  messages: z.array(lessonMessageSchema).default([]),
  exercises: z.array(exerciseSchema).default([]),
});

/** Ответ `POST /api/lessons/:id/steps/:stepId/advance`. */
export type AdvanceLessonStepResponse = z.infer<typeof advanceLessonStepResponseSchema>;

/** Параметры `POST /api/lessons/:id/exercises/:exerciseId/attempts`. */
export const lessonExerciseParamsSchema = z.object({ id: idSchema, exerciseId: idSchema });

/** Параметры маршрута задания урока. */
export type LessonExerciseParams = z.infer<typeof lessonExerciseParamsSchema>;

/** Тело `POST /api/lessons/:id/exercises/:exerciseId/attempts`. */
export const createExerciseAttemptRequestSchema = z.object({
  answer: z.string().trim().min(1).max(4000),
  source: messageSourceSchema.default('text'),
  durationMs: z.int().nonnegative().optional(),
});

/** Тело попытки выполнения задания. */
export type CreateExerciseAttemptRequest = z.infer<typeof createExerciseAttemptRequestSchema>;

/** Ответ `POST /api/lessons/:id/exercises/:exerciseId/attempts`. */
export const createExerciseAttemptResponseSchema = z.object({
  attempt: exerciseAttemptSchema,
  exercise: exerciseSchema,
  lesson: lessonSchema,
  /** Следующее задание шага; `null` — задания шага закончились. */
  nextExercise: exerciseSchema.nullish(),
  /** Реплики тьютора с разбором ответа. */
  messages: z.array(lessonMessageSchema).default([]),
});

/** Ответ попытки выполнения задания. */
export type CreateExerciseAttemptResponse = z.infer<typeof createExerciseAttemptResponseSchema>;

/** Query `GET /api/lessons/:id/messages`. */
export const listLessonMessagesQuerySchema = paginationQuerySchema.extend({
  stepId: idSchema.optional(),
  role: lessonMessageRoleSchema.optional(),
  /** Порядок по времени создания; по умолчанию — от старых к новым. */
  order: sortOrderSchema.default('asc'),
});

/** Query `GET /api/lessons/:id/messages`. */
export type ListLessonMessagesQuery = z.infer<typeof listLessonMessagesQuerySchema>;

/** Ответ `GET /api/lessons/:id/messages`. */
export const listLessonMessagesResponseSchema = paginatedResponseSchema(lessonMessageSchema);

/** Ответ `GET /api/lessons/:id/messages`. */
export type ListLessonMessagesResponse = z.infer<typeof listLessonMessagesResponseSchema>;
