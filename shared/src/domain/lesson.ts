/** Урок: план, шаги, диалог с тьютором, итог. */
import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from '../api/common.js';

import { cefrLevelSchema, languageCodeSchema } from './language.js';
import { correctionSchema } from './progress.js';

/** Жизненный цикл урока. */
export const LESSON_STATUSES = ['draft', 'in_progress', 'completed'] as const;

/** Статус урока. */
export type LessonStatus = (typeof LESSON_STATUSES)[number];

/** Статус урока. */
export const lessonStatusSchema = z.enum(LESSON_STATUSES);

/** Виды шагов плана урока. */
export const LESSON_STEP_TYPES = [
  'warmup',
  'vocabulary',
  'grammar',
  'reading',
  'listening',
  'speaking',
  'exercise',
  'wrapup',
] as const;

/** Вид шага плана урока. */
export type LessonStepType = (typeof LESSON_STEP_TYPES)[number];

/** Вид шага плана урока. */
export const lessonStepTypeSchema = z.enum(LESSON_STEP_TYPES);

/** Состояние шага плана урока. */
export const LESSON_STEP_STATUSES = ['pending', 'in_progress', 'completed', 'skipped'] as const;

/** Состояние шага плана урока. */
export type LessonStepStatus = (typeof LESSON_STEP_STATUSES)[number];

/** Состояние шага плана урока. */
export const lessonStepStatusSchema = z.enum(LESSON_STEP_STATUSES);

/** Как получена реплика или ответ: голосом или набором текста. */
export const MESSAGE_SOURCES = ['voice', 'text'] as const;

/** Как получена реплика или ответ. */
export type MessageSource = (typeof MESSAGE_SOURCES)[number];

/** Как получена реплика или ответ. */
export const messageSourceSchema = z.enum(MESSAGE_SOURCES);

/** Кто произнёс реплику урока. */
export const LESSON_MESSAGE_ROLES = ['user', 'tutor', 'system'] as const;

/** Кто произнёс реплику урока. */
export type LessonMessageRole = (typeof LESSON_MESSAGE_ROLES)[number];

/** Кто произнёс реплику урока. */
export const lessonMessageRoleSchema = z.enum(LESSON_MESSAGE_ROLES);

/** Шаг плана урока. */
export const lessonPlanStepSchema = z.object({
  id: idSchema,
  lessonId: idSchema,
  /** Порядковый номер шага в плане, с нуля. */
  order: z.int().nonnegative(),
  type: lessonStepTypeSchema,
  title: z.string().trim().min(1).max(200),
  /** Чему шаг учит: формулировки для ученика. */
  objectives: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  /** Слова и конструкции, которые отрабатываются на шаге. */
  targetItems: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  /** Инструкция тьютору: что и как делать на этом шаге. */
  instructions: z.string().trim().min(1).max(4000),
  estimatedMinutes: z.int().min(1).max(120),
  status: lessonStepStatusSchema,
  /** Фрагменты материалов, на которых строится шаг. */
  materialChunkIds: z.array(idSchema).max(50).default([]),
  /** Задания, созданные для этого шага. */
  exerciseIds: z.array(idSchema).max(50).default([]),
  startedAt: isoDateTimeSchema.nullish(),
  completedAt: isoDateTimeSchema.nullish(),
});

/** Шаг плана урока. */
export type LessonPlanStep = z.infer<typeof lessonPlanStepSchema>;

/** Итог завершённого урока: основа для пересчёта уровня и для экрана прогресса. */
export const lessonSummarySchema = z.object({
  /** Связный текст на `explanationLanguage` урока. */
  text: z.string().trim().min(1).max(4000),
  strengths: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  weaknesses: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  recommendations: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  newVocabulary: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  exercisesTotal: z.int().nonnegative(),
  exercisesCorrect: z.int().nonnegative(),
  /** Доля верных ответов, 0..1. */
  accuracy: z.number().min(0).max(1),
  durationMinutes: z.int().nonnegative(),
});

/** Итог завершённого урока. */
export type LessonSummary = z.infer<typeof lessonSummarySchema>;

/** Урок. */
export const lessonSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(200),
  status: lessonStatusSchema,
  /** Язык, который отрабатывается на уроке. */
  learningLanguage: languageCodeSchema,
  /** Язык объяснений и разборов ошибок на уроке (допущение A12). */
  explanationLanguage: languageCodeSchema,
  /** Целевой уровень урока на момент его создания. */
  level: cefrLevelSchema,
  topic: z.string().trim().max(200).nullish(),
  goals: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  materialIds: z.array(idSchema).max(20).default([]),
  plan: z.array(lessonPlanStepSchema).max(20).default([]),
  /** Шаг, на котором урок сейчас находится; `null` — урок не начат или завершён. */
  currentStepId: idSchema.nullish(),
  plannedMinutes: z.int().min(5).max(240),
  summary: lessonSummarySchema.nullish(),
  startedAt: isoDateTimeSchema.nullish(),
  completedAt: isoDateTimeSchema.nullish(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/** Урок. */
export type Lesson = z.infer<typeof lessonSchema>;

/**
 * Реплика диалога урока.
 *
 * Допущение A10: аудио не сохраняется, в БД попадает только расшифровка.
 * Поле `audioPath` зарезервировано на будущее и сейчас всегда пустое.
 */
export const lessonMessageSchema = z.object({
  id: idSchema,
  lessonId: idSchema,
  stepId: idSchema.nullish(),
  role: lessonMessageRoleSchema,
  source: messageSourceSchema,
  content: z.string().trim().min(1).max(8000),
  language: languageCodeSchema.nullish(),
  /** Исправления, которые тьютор привязал к этой реплике. */
  corrections: z.array(correctionSchema).max(20).default([]),
  /** Зарезервировано (A10): путь к аудио. Сервер всегда отдаёт `null`. */
  audioPath: z.string().trim().max(500).nullish(),
  /** Длительность исходной аудиозаписи, мс, если реплика надиктована. */
  durationMs: z.int().nonnegative().nullish(),
  createdAt: isoDateTimeSchema,
});

/** Реплика диалога урока. */
export type LessonMessage = z.infer<typeof lessonMessageSchema>;
