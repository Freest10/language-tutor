/**
 * Промпт проверки ответа ученика на задание и схема структурированного ответа модели.
 *
 * Проверку делает модель, а не сравнение строк: «Ich habe einen Hund» и
 * «Ich hab' 'nen Hund» — один и тот же верный ответ, а ответ голосом вдобавок
 * приходит без пунктуации. Эталонный ответ задания уходит в промпт как ориентир,
 * но последнее слово остаётся за моделью — иначе любая синонимичная формулировка
 * считалась бы ошибкой.
 *
 * Оценка возвращается сразу в двух видах: `isCorrect` для счётчиков прогресса и
 * `score` 0..1 для свободной речи, где ответ бывает частично верным.
 *
 * Языки разведены как и везде (A12): `feedback` и `explanation` исправлений —
 * на языке объяснений, реплика ученику (`message`) — на изучаемом языке.
 */
import { z } from 'zod';

import { correctionSchema, type Exercise, type LessonPlanStep } from '@lt/shared';

import type { ChatMessage } from '../providers/types.js';

import {
  buildTutorSystemPrompt,
  formatStep,
  listForPrompt,
  type TutorPromptContext,
} from './tutorTurn.js';

/** Разбор ответа ученика. */
export const answerCheckSchema = z.object({
  /** Засчитан ли ответ: по нему считаются счётчики прогресса и уровень (A13). */
  isCorrect: z.boolean(),
  /** Оценка ответа, 0..1: для свободной речи бывает промежуточной. */
  score: z.number().min(0).max(1),
  /** Разбор ответа на языке объяснений: он сохраняется вместе с попыткой. */
  feedback: z.string().trim().min(1).max(2000),
  /** Реплика ученику на изучаемом языке; пусто — ученику зачитывается разбор. */
  message: z.string().trim().max(2000).nullish(),
  /** Исправления к ответу; `explanation` — на языке объяснений. */
  corrections: z.array(correctionSchema).max(10).default([]),
});

/** Разбор ответа ученика. */
export type AnswerCheckReply = z.infer<typeof answerCheckSchema>;

/** Задание и ответ, которые проверяются. */
export interface AnswerCheckPromptOptions {
  exercise: Exercise;
  /** Шаг, к которому относится задание; `undefined` — задание вне шага. */
  step?: LessonPlanStep | undefined;
  /** Ответ ученика текстом (голос уже распознан). */
  answer: string;
  /** Ответ надиктован голосом: расшифровка бывает неточной. */
  spoken: boolean;
}

/** Задание в виде блока промпта: формулировка, варианты и эталон. */
function formatExercise(exercise: Exercise): string {
  const lines = [
    `Exercise type: ${exercise.type}`,
    `Prompt: ${exercise.prompt}`,
    `Instructions shown to the learner: ${exercise.instructions ?? '—'}`,
  ];

  if (exercise.options.length > 0) {
    lines.push(`Options: ${listForPrompt(exercise.options)}`);
  }

  lines.push(
    `Expected answer: ${exercise.expectedAnswer ?? '(free answer, judge it yourself)'}`,
    `Other acceptable answers: ${listForPrompt(exercise.acceptableAnswers)}`,
    `Target items: ${listForPrompt(exercise.targetItems)}`,
  );

  return lines.join('\n');
}

/** Запрос разбора ответа ученика на задание. */
export function buildAnswerCheckMessages(
  context: TutorPromptContext,
  options: AnswerCheckPromptOptions,
): ChatMessage[] {
  const instructions = [
    'Check the answer the learner has just given to an exercise.',
    '',
    formatExercise(options.exercise),
    '',
    `The learner answered: "${options.answer}"`,
  ];

  if (options.spoken) {
    instructions.push(
      'The answer comes from speech recognition: ignore punctuation, casing and obvious',
      'transcription noise, judge grammar, vocabulary and meaning.',
    );
  }

  if (options.step !== undefined) {
    instructions.push('', formatStep(options.step));
  }

  instructions.push(
    '',
    'Rules:',
    '- accept any answer that is correct in meaning and grammar, even if it differs from',
    '  the expected answer word by word; "isCorrect" is false only for a real mistake;',
    '- "score" is 1 for a fully correct answer, 0 for a wrong one and a value in between',
    '  for a partially correct free answer;',
    '- "feedback" is a short explanation in the explanation language: say what was right',
    '  and what to fix, without retelling the whole grammar rule;',
    '- "message" is one or two sentences the learner hears from you, in the target language;',
    '- put every mistake worth remembering into "corrections", at most three of them.',
  );

  return [
    { role: 'system', content: buildTutorSystemPrompt(context) },
    { role: 'user', content: instructions.join('\n') },
  ];
}
