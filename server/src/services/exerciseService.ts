/**
 * Задания урока: генерация под текущий шаг и проверка ответа ученика.
 *
 * Отдельного эндпоинта у заданий нет (их нет и в контракте): задания рождаются
 * внутри хода урока и уезжают клиенту полем `exercises[]` ответов `/turns` и
 * `/steps/:stepId/advance`. Поэтому модуль ничего не знает про HTTP и не сохраняет
 * задания сам — он возвращает готовые `Exercise`, а пишет их одной транзакцией
 * вместе с репликами `lessonSessionService`.
 *
 * Два решения, которые стоит знать:
 * - **вид задания подбирается под вид шага** (`EXERCISE_TYPES_BY_STEP`): на разминке
 *   и подведении итогов письменных заданий не бывает вовсе, и лишнего обращения
 *   к модели там тоже не будет;
 * - **ответ проверяет модель, а не сравнение строк.** Эталон уходит в промпт
 *   ориентиром, но синонимичная формулировка или ответ голосом без пунктуации
 *   обязаны засчитываться, иначе проверка превращается в диктант.
 *
 * Ответ модели нормализуется сервером: варианты остаются только у `multiple_choice`,
 * у свободной речи не бывает эталонного ответа, а отрабатываемые единицы при
 * молчании модели берутся из шага плана — по ним потом двигаются счётчики словаря.
 */
import { randomUUID } from 'node:crypto';

import type { CefrLevel, Exercise, ExerciseType, Id, LessonPlanStep } from '@lt/shared';

import { nowIso } from '../db/mappers.js';
import {
  answerCheckSchema,
  buildAnswerCheckMessages,
  type AnswerCheckPromptOptions,
  type AnswerCheckReply,
} from '../prompts/answerCheck.js';
import {
  buildExerciseMessages,
  EXERCISE_BATCH_MAX,
  EXERCISE_BATCH_MIN,
  EXERCISE_TYPES_BY_STEP,
  exerciseBatchSchema,
  type ExerciseReply,
} from '../prompts/exercise.js';
import type { TutorMaterialExcerpt, TutorPromptContext } from '../prompts/tutorTurn.js';
import { requestStructuredJson } from '../providers/structuredJson.js';
import type { ProviderLogger } from '../providers/types.js';

/** Температура генерации заданий: разнообразие полезно, но в рамках шага. */
const EXERCISE_TEMPERATURE = 0.5;

/** Температура проверки ответа: оценка должна быть предсказуемой. */
const ANSWER_CHECK_TEMPERATURE = 0.2;

/** Предел числа отрабатываемых единиц у задания (`exerciseSchema.targetItems`). */
const MAX_TARGET_ITEMS = 20;

/** Сколько вариантов ответа делает задание `multiple_choice` осмысленным. */
const MIN_CHOICE_OPTIONS = 2;

/** Общие параметры обращения к сервису. */
export interface ExerciseServiceOptions {
  /** Логгер запроса: провайдер пишет в него повторы и тайминги. */
  logger?: ProviderLogger | undefined;
}

/** Виды заданий, уместные на шаге; пустой список — шагу задания не нужны. */
export function stepExerciseTypes(step: LessonPlanStep): readonly ExerciseType[] {
  return EXERCISE_TYPES_BY_STEP[step.type];
}

/** Нужны ли шагу письменные задания. */
export function stepWantsExercises(step: LessonPlanStep): boolean {
  return stepExerciseTypes(step).length > 0;
}

/** Что именно генерируется. */
export interface GenerateExercisesInput {
  lessonId: Id;
  /** Уровень урока: им помечаются задания. */
  level: CefrLevel;
  step: LessonPlanStep;
  /** Сведения об уроке для промпта. */
  context: TutorPromptContext;
  excerpts: readonly TutorMaterialExcerpt[];
  /** Формулировки уже выданных заданий шага: их нельзя повторять. */
  existingPrompts: readonly string[];
  /** Порядковый номер первого нового задания в уроке. */
  startOrder: number;
  /** Сколько заданий просить; по умолчанию — пачка `EXERCISE_BATCH_MIN..MAX`. */
  maxCount?: number | undefined;
}

/**
 * Приводит задание от модели к контракту.
 *
 * `multiple_choice` без вариантов ответа клиенту нечем показать, поэтому такое
 * задание становится обычным вопросом; у свободной речи эталонного ответа не бывает
 * по определению.
 */
function toExercise(
  reply: ExerciseReply,
  input: GenerateExercisesInput,
  order: number,
  createdAt: string,
): Exercise {
  const isChoice = reply.type === 'multiple_choice' && reply.options.length >= MIN_CHOICE_OPTIONS;
  const type: ExerciseType = reply.type === 'multiple_choice' && !isChoice ? 'qa' : reply.type;
  const expectedAnswer = type === 'free_speech' ? null : (reply.expectedAnswer ?? null);
  const targetItems = reply.targetItems.length > 0 ? reply.targetItems : input.step.targetItems;

  return {
    id: randomUUID(),
    lessonId: input.lessonId,
    stepId: input.step.id,
    order,
    type,
    prompt: reply.prompt,
    instructions: reply.instructions ?? null,
    options: isChoice ? reply.options : [],
    expectedAnswer,
    acceptableAnswers: type === 'free_speech' ? [] : reply.acceptableAnswers,
    hints: reply.hints,
    targetItems: [...targetItems].slice(0, MAX_TARGET_ITEMS),
    level: input.level,
    createdAt,
  };
}

/**
 * Просит у модели задания под текущий шаг урока.
 *
 * Задания возвращаются несохранёнными: их пишет вызывающий код одной транзакцией
 * вместе с репликой тьютора и обновлённым шагом плана. Шагу, которому задания
 * не положены, обращение к модели не делается вовсе.
 */
export async function generateStepExercises(
  input: GenerateExercisesInput,
  options: ExerciseServiceOptions = {},
): Promise<Exercise[]> {
  const allowedTypes = stepExerciseTypes(input.step);

  if (allowedTypes.length === 0) {
    return [];
  }

  const maxCount = Math.min(EXERCISE_BATCH_MAX, Math.max(1, input.maxCount ?? EXERCISE_BATCH_MAX));
  const minCount = Math.min(EXERCISE_BATCH_MIN, maxCount);
  const { data } = await requestStructuredJson({
    schema: exerciseBatchSchema({ minCount, maxCount }),
    messages: buildExerciseMessages(input.context, {
      step: input.step,
      allowedTypes,
      minCount,
      maxCount,
      excerpts: input.excerpts,
      existingPrompts: input.existingPrompts,
    }),
    schemaName: 'lesson_exercises',
    temperature: EXERCISE_TEMPERATURE,
    logger: options.logger,
  });
  const createdAt = nowIso();

  return data.exercises.map((reply, index) =>
    toExercise(reply, input, input.startOrder + index, createdAt),
  );
}

/** Что проверяется. */
export interface CheckAnswerInput extends AnswerCheckPromptOptions {
  /** Сведения об уроке для промпта. */
  context: TutorPromptContext;
}

/**
 * Просит у модели разбор ответа ученика: засчитан ли он, оценку 0..1, обратную
 * связь и исправления. Сама попытка сохраняется вызывающим кодом.
 */
export async function checkExerciseAnswer(
  input: CheckAnswerInput,
  options: ExerciseServiceOptions = {},
): Promise<AnswerCheckReply> {
  const { data } = await requestStructuredJson({
    schema: answerCheckSchema,
    messages: buildAnswerCheckMessages(input.context, {
      exercise: input.exercise,
      step: input.step,
      answer: input.answer,
      spoken: input.spoken,
    }),
    schemaName: 'exercise_answer_check',
    temperature: ANSWER_CHECK_TEMPERATURE,
    logger: options.logger,
  });

  return data;
}
