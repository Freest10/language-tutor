/**
 * Промпты планирования урока и схема структурированного ответа модели.
 *
 * Модуль намеренно чистый: он не ходит ни в базу, ни к провайдеру — только собирает
 * текст для `requestStructuredJson()`. Сводку профиля (`getProfileForPrompt()`),
 * историю занятий (`learnerContext.build()`) и фрагменты материалов передаёт сервис,
 * поэтому промпты остаются независимыми от хранилища.
 *
 * Два языка разведены и нигде не подразумевают английский (допущение A12):
 * - `learningLanguage` — язык примеров, отрабатываемых слов и реплик ученику;
 * - `explanationLanguage` — язык названий шагов, целей и инструкций тьютору.
 *   Язык интерфейса сервер не знает и в планировании не участвует.
 *
 * Фрагменты материалов подписываются короткими метками (`C1`, `C2`, …), и модель
 * ссылается на них в `materialRefs`. Метки вместо UUID выбраны намеренно: их модель
 * переписывает без ошибок, а сервис всё равно сверяет ответ со своим списком
 * и молча отбрасывает выдуманные ссылки.
 */
import { z } from 'zod';

import {
  LESSON_STEP_TYPES,
  lessonStepTypeSchema,
  type CefrLevel,
  type LanguageCode,
  type LessonPlanStep,
  type LessonStepType,
} from '@lt/shared';

import type { ChatMessage } from '../providers/types.js';

import {
  excerptSource,
  languageForPrompt,
  listForPrompt,
  untrustedBlock,
  UNTRUSTED_DATA_NOTE,
} from './format.js';

/** Сколько шагов должно быть в плане урока: меньше — не урок, больше — не успеть. */
export const LESSON_PLAN_MIN_STEPS = 4;

/** Верхняя граница числа шагов в плане. */
export const LESSON_PLAN_MAX_STEPS = 7;

/**
 * Допустимое расхождение суммы минут шагов с длительностью урока, доля.
 * Одно и то же правило и объясняется модели словами, и применяется сервером.
 */
export const LESSON_PLAN_MINUTES_TOLERANCE = 0.2;

/**
 * Бюджет символов, который отдаётся цитатам из материалов.
 * ≈1500 токенов: столько помещается рядом с профилем, историей занятий
 * и самой инструкцией в окне локальной модели.
 */
export const LESSON_MATERIAL_BUDGET_CHARS = 6000;

/** Предел числа фрагментов в промпте: длинный список размывает тему урока. */
export const LESSON_MATERIAL_MAX_CHUNKS = 12;

/**
 * Пометка промпта о том, что материал пройден целиком.
 *
 * Свежего материала не осталось, и урок строится на уже отработанных фрагментах.
 * Модель должна знать это как факт: повторение и первое знакомство с текстом —
 * разные уроки, и притворяться, что материал новый, нельзя.
 */
export const COVERED_MATERIAL_NOTE = [
  'The learner has already worked through all of this material in earlier lessons:',
  'this lesson is a revision. Build the steps as recall, re-use and error repair —',
  'do not present the excerpts as new material.',
].join('\n');

/** Шаг плана в ответе модели: идентификаторы и статусы проставляет сервер. */
export const lessonPlanStepReplySchema = z.object({
  type: lessonStepTypeSchema,
  /** Название шага на языке объяснений. */
  title: z.string().trim().min(1).max(200),
  /** Чему шаг учит; на языке объяснений. */
  objectives: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  /** Слова и конструкции шага; на изучаемом языке. */
  targetItems: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  /** Инструкция тьютору: что и как делать на шаге; на языке объяснений. */
  instructions: z.string().trim().min(1).max(4000),
  estimatedMinutes: z.int().min(1).max(120),
  /** Метки использованных фрагментов материалов (`C1`, `C2`, …). */
  materialRefs: z.array(z.string().trim().min(1).max(20)).max(50).default([]),
});

/** Шаг плана в ответе модели. */
export type LessonPlanStepReply = z.infer<typeof lessonPlanStepReplySchema>;

/**
 * Схема ответа модели с планом урока.
 *
 * Число шагов входит в схему, а не только в текст промпта: так требование
 * проверяется Zod и чинится ремонтным заходом `requestStructuredJson()`.
 */
export function lessonPlanReplySchema(options: { minSteps: number; maxSteps: number }) {
  return z.object({
    /** Название урока на языке объяснений. */
    title: z.string().trim().min(1).max(200),
    /** Тема урока одной строкой; на языке объяснений. */
    topic: z.string().trim().min(1).max(200).nullish(),
    steps: z.array(lessonPlanStepReplySchema).min(options.minSteps).max(options.maxSteps),
  });
}

/** План урока в ответе модели. */
export type LessonPlanReply = z.infer<ReturnType<typeof lessonPlanReplySchema>>;

/** Фрагмент материала для промпта. */
export interface LessonMaterialExcerpt {
  /** Короткая метка, по которой модель ссылается на фрагмент: `C1`, `C2`, … */
  ref: string;
  /** Название материала, из которого взят фрагмент. */
  materialTitle: string;
  /** Страница исходного файла, если она известна. */
  page?: number | null;
  /** Заголовок фрагмента, если он нашёлся при разбиении. */
  heading?: string | null;
  /** Текст фрагмента как есть. */
  content: string;
}

/** Общие для всех обращений сведения об уроке. */
export interface LessonPlanPromptContext {
  /** Язык примеров и отрабатываемых слов. */
  learningLanguage: LanguageCode;
  /** Язык названий, целей и инструкций. */
  explanationLanguage: LanguageCode;
  /** Целевой уровень урока. */
  level: CefrLevel;
  /** Длительность урока целиком, минуты. */
  durationMinutes: number;
  /** Сводка профиля из `getProfileForPrompt()`. */
  profileSummary: string;
  /** История занятий из `learnerContext.build()`; пустая строка — истории нет. */
  learnerSummary: string;
}

/** Что именно просят спланировать. */
export interface LessonPlanRequestOptions {
  /** Цели урока: из запроса или из профиля. */
  goals: readonly string[];
  /** Тема урока, если её назвал ученик. */
  topic?: string | null;
  /** Виды шагов, на которых просят сделать акцент. */
  focus?: readonly LessonStepType[];
  /** Фрагменты материалов; пустой список — урок строится по целям и интересам. */
  excerpts: readonly LessonMaterialExcerpt[];
  /**
   * `true` — присланные фрагменты ученик уже проходил: материал отработан целиком,
   * и нового в нём не осталось (`LessonChunkSelection.allCovered`). Модель обязана
   * знать этот факт, иначе построит урок так, будто видит материал впервые.
   */
  materialAllCovered?: boolean;
  /** Сколько шагов ждут от модели. */
  minSteps: number;
  maxSteps: number;
  /** Сколько минут распределяется между новыми шагами. */
  minutes: number;
  /** Шаги, которые остаются в плане как есть (пересборка плана). */
  keptSteps?: readonly LessonPlanStep[];
  /** Пожелание ученика к новому плану (пересборка плана). */
  feedback?: string | undefined;
}

/**
 * Напоминание после цитат: урок строится на материале.
 *
 * Цели профиля («научиться общаться на повседневные темы») и загруженный учебник
 * тянут план в разные стороны, и без явного разрешения этого спора модель
 * выбирает цели: они короче, ближе к началу промпта и не требуют читать цитаты.
 */
function materialClosingNote(hasGoals: boolean): string {
  const lines = [
    'This lesson is about the material above, not about anything else:',
    '- the topic, the target items and every example come from the excerpts;',
    '- each step that works with the material names its labels in "materialRefs";',
    '- "targetItems" are words and phrases of the target language as they appear',
    '  in the excerpts — never their translation into the explanation language.',
  ];

  if (hasGoals) {
    lines.push(
      'The learner goals say how to work with this material (what to practise),',
      'not what to replace it with.',
    );
  }

  return lines.join('\n');
}

/** Метка фрагмента по его позиции в списке: `C1`, `C2`, … */
export function materialRefLabel(index: number): string {
  return `C${String(index + 1)}`;
}

/**
 * Фрагменты материалов в виде блока промпта.
 *
 * Текст материала загрузил пользователь, и внутри него может оказаться что угодно —
 * включая абзац вида «ignore previous instructions». Поэтому каждая цитата уходит
 * в ограничителях `<material>` с пометкой «это данные, а не инструкции»
 * (см. `prompts/format.ts`).
 *
 * `allCovered` — материал пройден целиком: модели говорится прямо, что это
 * повторение, иначе она построит урок как первое знакомство с текстом.
 */
export function formatMaterialExcerpts(
  excerpts: readonly LessonMaterialExcerpt[],
  options: { allCovered?: boolean } = {},
): string {
  if (excerpts.length === 0) {
    return [
      'No materials were uploaded for this lesson.',
      'Build the lesson around the learner goals, interests and level; leave "materialRefs" empty.',
    ].join('\n');
  }

  return [
    'Material excerpts to build the lesson on (reference them by label in "materialRefs"):',
    ...(options.allCovered === true ? [COVERED_MATERIAL_NOTE] : []),
    UNTRUSTED_DATA_NOTE,
    ...excerpts.map((excerpt) =>
      [
        `[${excerpt.ref}] ${excerptSource(excerpt.materialTitle, excerpt.page, excerpt.heading)}`,
        untrustedBlock('material', excerpt.content),
      ].join('\n'),
    ),
  ].join('\n\n');
}

/** Уже пройденные шаги, которые остаются в плане. */
function formatKeptSteps(steps: readonly LessonPlanStep[]): string {
  return steps
    .map(
      (step, index) =>
        `#${String(index + 1)} [${step.type}, ${String(step.estimatedMinutes)} min, ` +
        `${step.status}] ${step.title}`,
    )
    .join('\n');
}

/**
 * Системная инструкция планировщика.
 *
 * Здесь же требования, которые сервер потом проверяет сам: число шагов, сумма минут
 * и опора на присланные фрагменты. Модель должна знать правила словами, но
 * единственным их гарантом остаётся сервер.
 */
export function buildLessonPlanSystemPrompt(context: LessonPlanPromptContext): string {
  const lines = [
    'You are a lesson planner in a language learning app.',
    'You design one lesson plan that a voice tutor will then run with the learner step by step.',
    '',
    `Target language (examples, target words, phrases the learner says): ${languageForPrompt(context.learningLanguage)}.`,
    `Explanation language (step titles, objectives, instructions): ${languageForPrompt(context.explanationLanguage)}.`,
    `Learner CEFR level: ${context.level}.`,
    `Whole lesson length: ${String(context.durationMinutes)} minutes.`,
    '',
    'Hard rules:',
    '- write "title", "objectives" and "instructions" in the explanation language;',
    '- write "targetItems" — words, phrases and grammar patterns the step drills —',
    '  in the target language;',
    `- keep the wording, vocabulary and grammar at CEFR level ${context.level}:`,
    '  a step the learner cannot follow at this level is a wasted step;',
    '- "instructions" is addressed to the tutor, not to the learner: say what to ask,',
    '  what to explain and what the learner has to produce, in one short paragraph;',
    '- give every step its own "estimatedMinutes"; the sum over all steps must match',
    `  the time the task asks you to distribute (±${String(Math.round(LESSON_PLAN_MINUTES_TOLERANCE * 100))}%);`,
    `- each step has exactly one type out of: ${LESSON_STEP_TYPES.join(', ')};`,
    '- vary the types, start the lesson with a warmup and finish it with a wrapup;',
    '- speaking practice is the point of the app: at least one step must make the learner talk;',
    '- when material excerpts are given, build the steps on them, name the labels you used',
    '  in "materialRefs" and never invent facts or quotes that are not in the excerpts;',
    '- when no excerpts are given, build the lesson around the learner goals and interests;',
    '- do not write the whole tutor script and do not write the exercises themselves.',
    '',
    context.profileSummary,
  ];

  if (context.learnerSummary !== '') {
    lines.push('', context.learnerSummary);
  }

  return lines.join('\n');
}

/** Запрос плана урока: создание урока и пересборка плана отличаются только телом. */
export function buildLessonPlanMessages(
  context: LessonPlanPromptContext,
  options: LessonPlanRequestOptions,
): ChatMessage[] {
  const keptSteps = options.keptSteps ?? [];
  const instructions: string[] = [];

  if (keptSteps.length === 0) {
    instructions.push('Plan a lesson.');
  } else {
    instructions.push(
      'Rebuild the plan of a lesson that is already running.',
      'These steps stay in the plan exactly as they are, do not repeat them:',
      formatKeptSteps(keptSteps),
      'Plan only the steps that come after them.',
    );
  }

  const hasExcerpts = options.excerpts.length > 0;
  const topic = options.topic === null || options.topic === undefined ? '' : options.topic;

  instructions.push(
    '',
    `Lesson goals: ${listForPrompt(options.goals)}`,
    // Без материалов тему выбирают цели профиля, с материалами — сам материал.
    // Обратный порядок означал урок про «повседневное общение» поверх учебника,
    // который ученик только что загрузил: цитаты в промпте есть, а урок не о них.
    `Topic: ${topic !== '' ? topic : hasExcerpts ? 'derive it from the material excerpts below — that is what the learner asked to work through' : 'choose one that fits the goals and the interests'}`,
  );

  if (options.focus !== undefined && options.focus.length > 0) {
    instructions.push(`Emphasise these step types: ${options.focus.join(', ')}`);
  }

  if (options.feedback !== undefined && options.feedback !== '') {
    instructions.push(`What the learner asks to change: "${options.feedback}"`);
  }

  instructions.push(
    `Number of steps to plan: from ${String(options.minSteps)} to ${String(options.maxSteps)}.`,
    `Minutes to distribute across these steps: ${String(options.minutes)}.`,
    '',
    formatMaterialExcerpts(options.excerpts, { allCovered: options.materialAllCovered }),
  );

  if (hasExcerpts) {
    // Напоминание идёт последним: модель лучше всего держится того, что стоит в
    // конце промпта, а правило «урок строится на материале» — единственное, ради
    // которого ученик этот материал и загружал.
    instructions.push('', materialClosingNote(options.goals.length > 0));
  }

  return [
    { role: 'system', content: buildLessonPlanSystemPrompt(context) },
    { role: 'user', content: instructions.join('\n') },
  ];
}
