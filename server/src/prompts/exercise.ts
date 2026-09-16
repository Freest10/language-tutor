/**
 * Промпт генерации заданий урока и схема структурированного ответа модели.
 *
 * Задания не живут отдельным эндпоинтом: их выдаёт тьютор по ходу занятия —
 * при переходе на новый шаг и внутри хода диалога, когда ученик готов к письменной
 * отработке. Поэтому модуль знает только про «шаг плана → пачка заданий», а когда
 * её запрашивать, решает `services/exerciseService.ts`.
 *
 * Виды заданий ограничены видом шага (`EXERCISE_TYPES_BY_STEP`): перевод уместен
 * на лексике и грамматике, вопросы — на чтении и аудировании, свободная речь —
 * на говорении. Разминке и подведению итогов задания не нужны вовсе.
 *
 * Языки разведены как и везде (A12): формулировка задания — на изучаемом языке,
 * пояснение к нему (`instructions`) — на языке объяснений.
 */
import { z } from 'zod';

import {
  exerciseTypeSchema,
  type ExerciseType,
  type LessonPlanStep,
  type LessonStepType,
} from '@lt/shared';

import type { ChatMessage } from '../providers/types.js';

import {
  buildTutorSystemPrompt,
  formatExcerpts,
  formatStep,
  listForPrompt,
  type TutorMaterialExcerpt,
  type TutorPromptContext,
} from './tutorTurn.js';

/** Сколько заданий просить у модели за один раз. */
export const EXERCISE_BATCH_MIN = 1;

/** Верхняя граница пачки заданий: больше трёх подряд ученик не выполнит. */
export const EXERCISE_BATCH_MAX = 3;

/**
 * Виды заданий, уместные на шаге каждого вида. Пустой список — шаг обходится
 * без письменных заданий: на разминке и подведении итогов важнее разговор.
 */
export const EXERCISE_TYPES_BY_STEP: Record<LessonStepType, readonly ExerciseType[]> = {
  warmup: [],
  vocabulary: ['translate', 'fill_blank', 'multiple_choice'],
  grammar: ['fill_blank', 'translate', 'multiple_choice'],
  reading: ['qa', 'multiple_choice'],
  listening: ['qa', 'fill_blank'],
  speaking: ['free_speech', 'qa'],
  exercise: ['translate', 'fill_blank', 'qa', 'multiple_choice'],
  wrapup: [],
};

/** Задание в ответе модели: идентификаторы, порядок и урок проставляет сервер. */
export const exerciseReplySchema = z.object({
  type: exerciseTypeSchema,
  /** Формулировка задания; язык уместен виду задания. */
  prompt: z.string().trim().min(1).max(2000),
  /** Пояснение к заданию на языке объяснений. */
  instructions: z.string().trim().max(1000).nullish(),
  /** Варианты ответа; только для `multiple_choice`. */
  options: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  /** Эталонный ответ; пусто для заданий со свободным ответом. */
  expectedAnswer: z.string().trim().max(2000).nullish(),
  /** Другие ответы, которые тоже считаются верными. */
  acceptableAnswers: z.array(z.string().trim().min(1).max(2000)).max(10).default([]),
  hints: z.array(z.string().trim().min(1).max(300)).max(5).default([]),
  /** Слова и конструкции, которые проверяет задание; на изучаемом языке. */
  targetItems: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
});

/** Задание в ответе модели. */
export type ExerciseReply = z.infer<typeof exerciseReplySchema>;

/**
 * Схема пачки заданий. Число заданий входит в схему, а не только в текст промпта:
 * так требование проверяется Zod и чинится ремонтным заходом `requestStructuredJson()`.
 */
export function exerciseBatchSchema(options: { minCount: number; maxCount: number }) {
  return z.object({
    exercises: z.array(exerciseReplySchema).min(options.minCount).max(options.maxCount),
  });
}

/** Пачка заданий в ответе модели. */
export type ExerciseBatchReply = z.infer<ReturnType<typeof exerciseBatchSchema>>;

/** Что именно просят сгенерировать. */
export interface ExercisePromptOptions {
  /** Шаг, под который делаются задания. */
  step: LessonPlanStep;
  /** Виды заданий, допустимые на этом шаге. */
  allowedTypes: readonly ExerciseType[];
  /** Сколько заданий ждут от модели. */
  minCount: number;
  maxCount: number;
  excerpts: readonly TutorMaterialExcerpt[];
  /** Формулировки уже выданных заданий шага: их нельзя повторять. */
  existingPrompts: readonly string[];
}

/** Запрос пачки заданий под текущий шаг урока. */
export function buildExerciseMessages(
  context: TutorPromptContext,
  options: ExercisePromptOptions,
): ChatMessage[] {
  const instructions = [
    'Write exercises for the step the learner is on right now.',
    '',
    formatStep(options.step),
    '',
    formatExcerpts(options.excerpts),
    '',
    `Number of exercises: from ${String(options.minCount)} to ${String(options.maxCount)}.`,
    `Allowed exercise types: ${options.allowedTypes.join(', ')}.`,
    'Rules:',
    '- "prompt" is what the learner sees: write it in the target language, except for a',
    '  "translate" task where the sentence to translate is in the explanation language;',
    '- "instructions" is one short sentence in the explanation language telling the learner',
    '  what to do;',
    `- keep the difficulty at CEFR level ${context.level} and drill the target items of the step;`,
    '- "fill_blank" prompts contain exactly one gap written as "___";',
    '- "multiple_choice" prompts come with 3 or 4 "options", exactly one of them correct,',
    '  and "expectedAnswer" repeats that correct option verbatim;',
    '- "translate", "fill_blank" and "qa" have an "expectedAnswer"; list other correct',
    '  wordings in "acceptableAnswers";',
    '- "free_speech" has no "expectedAnswer": it is graded by the tutor;',
    '- "targetItems" lists the words or patterns the exercise checks, in the target language;',
    `- target items of this step: ${listForPrompt(options.step.targetItems)};`,
    '- when material excerpts are given, build the exercises on them and never invent facts.',
  ];

  if (options.existingPrompts.length > 0) {
    instructions.push(
      '',
      'The learner has already got these exercises on this step, do not repeat them:',
      ...options.existingPrompts.map((prompt) => `- ${prompt}`),
    );
  }

  return [
    { role: 'system', content: buildTutorSystemPrompt(context) },
    { role: 'user', content: instructions.join('\n') },
  ];
}
