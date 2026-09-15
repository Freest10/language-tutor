/** Задания урока и попытки их выполнения. */
import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from '../api/common.js';

import { cefrLevelSchema } from './language.js';
import { messageSourceSchema } from './lesson.js';
import { correctionSchema } from './progress.js';

/** Виды заданий. */
export const EXERCISE_TYPES = [
  'translate',
  'fill_blank',
  'qa',
  'free_speech',
  'multiple_choice',
] as const;

/** Вид задания. */
export type ExerciseType = (typeof EXERCISE_TYPES)[number];

/** Вид задания. */
export const exerciseTypeSchema = z.enum(EXERCISE_TYPES);

/** Задание урока. */
export const exerciseSchema = z.object({
  id: idSchema,
  lessonId: idSchema,
  stepId: idSchema.nullish(),
  /** Порядковый номер задания внутри урока, с нуля. */
  order: z.int().nonnegative(),
  type: exerciseTypeSchema,
  /** Формулировка задания на языке, уместном для типа задания. */
  prompt: z.string().trim().min(1).max(2000),
  /** Пояснение к заданию на `explanationLanguage` урока. */
  instructions: z.string().trim().max(1000).nullish(),
  /** Варианты ответа; заполняются только для `multiple_choice`. */
  options: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  /** Эталонный ответ; `null` для заданий со свободным ответом. */
  expectedAnswer: z.string().trim().max(2000).nullish(),
  /** Другие ответы, которые тоже считаются верными. */
  acceptableAnswers: z.array(z.string().trim().min(1).max(2000)).max(10).default([]),
  hints: z.array(z.string().trim().min(1).max(300)).max(5).default([]),
  /** Слова и конструкции, которые проверяет задание. */
  targetItems: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  level: cefrLevelSchema.nullish(),
  createdAt: isoDateTimeSchema,
});

/** Задание урока. */
export type Exercise = z.infer<typeof exerciseSchema>;

/** Попытка выполнения задания вместе с разбором от тьютора. */
export const exerciseAttemptSchema = z.object({
  id: idSchema,
  exerciseId: idSchema,
  lessonId: idSchema,
  stepId: idSchema.nullish(),
  answer: z.string().trim().min(1).max(4000),
  source: messageSourceSchema,
  isCorrect: z.boolean(),
  /** Оценка ответа, 0..1: для свободной речи бывает промежуточной. */
  score: z.number().min(0).max(1),
  corrections: z.array(correctionSchema).max(20).default([]),
  /** Обратная связь на `explanationLanguage` урока. */
  feedback: z.string().trim().max(2000).default(''),
  durationMs: z.int().nonnegative().nullish(),
  createdAt: isoDateTimeSchema,
});

/** Попытка выполнения задания. */
export type ExerciseAttempt = z.infer<typeof exerciseAttemptSchema>;
