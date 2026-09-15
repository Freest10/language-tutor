/**
 * Промпты определения исходного уровня и схемы структурированных ответов модели.
 *
 * Модуль намеренно чистый: он не ходит ни в базу, ни к провайдеру — только собирает
 * текст для `requestStructuredJson()`. Сводку профиля ему передаёт сервис
 * (`getProfileForPrompt()`), поэтому промпты остаются независимыми от хранилища.
 *
 * Два языка разведены и нигде не подразумевают английский (допущение A12):
 * - `learningLanguage` — язык вопросов ученику;
 * - `explanationLanguage` — язык служебных полей (`feedback`, `rationale`),
 *   которые видит только сервер.
 *
 * Главное правило теста: модель не раскрывает ученику оценку. Похвала, разбор
 * ошибки или названный уровень превращают измерение в подсказку, поэтому
 * `assistantMessage` обязан содержать только следующий вопрос, а вся оценка
 * уходит в отдельные поля JSON.
 */
import { z } from 'zod';

import {
  CEFR_LEVELS,
  cefrLevelSchema,
  KNOWN_LANGUAGE_CODES,
  LANGUAGE_LABELS,
  levelConfidenceSchema,
  PLACEMENT_SKILLS,
  placementSkillSchema,
  type CefrLevel,
  type LanguageCode,
  type PlacementTurn,
} from '@lt/shared';

import type { ChatMessage } from '../providers/types.js';

/** Первый вопрос сессии: уровень вопроса задаёт сервер, модель выбирает навык. */
export const placementQuestionSchema = z.object({
  /** Текст вопроса ученику на изучаемом языке; без оценок и подсказок. */
  assistantMessage: z.string().trim().min(1).max(2000),
  /** Навык, который проверяет вопрос. */
  skill: placementSkillSchema,
});

/** Первый вопрос сессии. */
export type PlacementQuestionReply = z.infer<typeof placementQuestionSchema>;

/**
 * Оценка ответа и следующий вопрос одним обращением к модели.
 *
 * `assistantMessage` и `skill` пустые, когда модель считает тест законченным
 * (`shouldFinish: true`); сервер всё равно вправе завершить тест раньше.
 */
export const placementEvaluationSchema = z.object({
  /** Насколько ответ верен, 0..1. */
  score: z.number().min(0).max(1),
  /** Разбор ответа на языке объяснений; ученику по ходу теста не показывается. */
  feedback: z.string().trim().min(1).max(2000),
  /** Промежуточная оценка уровня после этого ответа. */
  estimatedLevel: cefrLevelSchema,
  /** Уверенность в промежуточной оценке, 0..1. */
  confidence: levelConfidenceSchema,
  /** Чем обоснована промежуточная оценка; на языке объяснений. */
  rationale: z.string().trim().min(1).max(2000),
  /** `true` — данных достаточно, новый вопрос не нужен. */
  shouldFinish: z.boolean(),
  /** Следующий вопрос на изучаемом языке; пусто, если тест пора заканчивать. */
  assistantMessage: z.string().trim().max(2000).nullish(),
  /** Навык, который проверяет следующий вопрос. */
  skill: placementSkillSchema.nullish(),
});

/** Оценка ответа и следующий вопрос. */
export type PlacementEvaluationReply = z.infer<typeof placementEvaluationSchema>;

/** Итог теста: уровень и резюме сильных и слабых сторон. */
export const placementSummarySchema = z.object({
  level: cefrLevelSchema,
  confidence: levelConfidenceSchema,
  /** Обоснование итогового уровня на языке объяснений. */
  rationale: z.string().trim().min(1).max(2000),
  strengths: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  weaknesses: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  recommendedGoals: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
});

/** Итог теста. */
export type PlacementSummaryReply = z.infer<typeof placementSummarySchema>;

/**
 * Оценка, начиная с которой следующий вопрос задаётся на ступень выше.
 * Порог живёт рядом с промптом намеренно: одно и то же правило и объясняется
 * модели словами, и применяется сервером в `nextPlacementLevel()`.
 */
export const PLACEMENT_PROMOTE_SCORE = 0.75;

/** Оценка, на которой и ниже которой следующий вопрос задаётся на ступень ниже. */
export const PLACEMENT_DEMOTE_SCORE = 0.4;

/** Сдвигает уровень CEFR на заданное число ступеней, не выходя за края шкалы. */
export function shiftLevel(level: CefrLevel, steps: number): CefrLevel {
  const index = CEFR_LEVELS.indexOf(level);
  const shifted = Math.min(CEFR_LEVELS.length - 1, Math.max(0, index + steps));

  return CEFR_LEVELS[shifted] ?? level;
}

/**
 * Уровень следующего вопроса по уровню предыдущего и оценке ответа:
 * верный ответ поднимает сложность, неверный опускает, промежуточный оставляет.
 */
export function nextPlacementLevel(level: CefrLevel, score: number): CefrLevel {
  if (score >= PLACEMENT_PROMOTE_SCORE) {
    return shiftLevel(level, 1);
  }

  return score <= PLACEMENT_DEMOTE_SCORE ? shiftLevel(level, -1) : level;
}

/** Общие для всех обращений сведения о сессии. */
export interface PlacementPromptContext {
  /** Язык, на котором задаются вопросы. */
  learningLanguage: LanguageCode;
  /** Язык служебных полей ответа модели. */
  explanationLanguage: LanguageCode;
  /** Жёсткий предел числа вопросов в сессии. */
  maxTurns: number;
  /** Сводка профиля из `getProfileForPrompt()`. */
  profileSummary: string;
}

/** Английские названия языков пресетов для строк промпта. */
const LANGUAGE_NAMES: Record<string, string | undefined> = Object.fromEntries(
  KNOWN_LANGUAGE_CODES.map((code) => [code, LANGUAGE_LABELS[code].englishName]),
);

/** Название языка для промпта: `German (de)`, для кода вне пресетов — сам код. */
function languageForPrompt(code: LanguageCode): string {
  const name = LANGUAGE_NAMES[code];

  return name === undefined ? code : `${name} (${code})`;
}

/**
 * Системная инструкция теста. Здесь же запрет раскрывать оценку: без него модель
 * начинает хвалить и исправлять ученика, и следующий ответ перестаёт быть измерением.
 */
export function buildPlacementSystemPrompt(context: PlacementPromptContext): string {
  return [
    'You are a placement examiner in a language learning app.',
    'Your goal is to estimate the learner CEFR level (A1..C2) in a short spoken dialogue.',
    '',
    `Question language: ${languageForPrompt(context.learningLanguage)}.`,
    `Explanation language: ${languageForPrompt(context.explanationLanguage)}.`,
    `The dialogue is at most ${String(context.maxTurns)} questions long.`,
    '',
    'Hard rules:',
    '- "assistantMessage" contains ONLY the next question or task for the learner,',
    '  written in the question language, at most two short sentences;',
    '- Never reveal the assessment to the learner: no score, no CEFR level, no praise,',
    '  no criticism, no corrections and no hints inside "assistantMessage";',
    '- "feedback" and "rationale" are internal server fields: write them in the',
    '  explanation language, the learner never sees them during the test;',
    '- ask exactly one question at a time and make it answerable by voice in 1-3 sentences;',
    `- cover different skills across the dialogue: ${PLACEMENT_SKILLS.join(', ')};`,
    '- ask the question at the CEFR level requested by the server, not at your own choice;',
    '- the answer may come from speech recognition: ignore punctuation and casing,',
    '  judge grammar, vocabulary and comprehension, not spelling;',
    '- never switch to the explanation language inside "assistantMessage",',
    '  even if the learner answers in another language.',
    '',
    context.profileSummary,
    '',
    'The profile level is only a starting guess: trust the answers, not the profile.',
  ].join('\n');
}

/** Строки одного заданного вопроса и ответа на него для расшифровки диалога. */
function formatTurn(turn: PlacementTurn, index: number): string {
  const lines = [
    `#${String(index + 1)} [skill: ${turn.skill}, level: ${turn.targetLevel}]`,
    `Q: ${turn.question}`,
    `A: ${turn.answer ?? '(no answer yet)'}`,
  ];

  if (turn.score !== null && turn.score !== undefined) {
    lines.push(
      `Score: ${turn.score.toFixed(2)}; running estimate: ${turn.estimatedLevel ?? 'unknown'}`,
    );
  }

  return lines.join('\n');
}

/** Расшифровка диалога: вопросы, ответы и уже выставленные оценки. */
export function formatPlacementTranscript(turns: readonly PlacementTurn[]): string {
  if (turns.length === 0) {
    return 'No questions have been asked yet.';
  }

  return turns.map((turn, index) => formatTurn(turn, index)).join('\n\n');
}

/** Запрос первого вопроса сессии. */
export function buildFirstQuestionMessages(
  context: PlacementPromptContext,
  options: { targetLevel: CefrLevel },
): ChatMessage[] {
  return [
    { role: 'system', content: buildPlacementSystemPrompt(context) },
    {
      role: 'user',
      content: [
        'Start the placement test.',
        `Ask the first question at CEFR level ${options.targetLevel}.`,
        'Greet the learner in one short sentence and ask the question right after it.',
        'Do not mention levels, scores or the purpose of the measurement.',
      ].join('\n'),
    },
  ];
}

/** Что известно об ответе ученика на момент оценки. */
export interface PlacementEvaluationPromptOptions {
  /** Заданные ранее вопросы вместе с оценками. */
  previousTurns: readonly PlacementTurn[];
  /** Вопрос, на который сейчас отвечает ученик. */
  currentTurn: PlacementTurn;
  /** Ответ ученика текстом (голос уже распознан на клиенте). */
  answer: string;
  /** Сколько вопросов ещё можно задать после этого ответа. */
  questionsLeft: number;
}

/** Запрос оценки ответа и следующего вопроса. */
export function buildEvaluationMessages(
  context: PlacementPromptContext,
  options: PlacementEvaluationPromptOptions,
): ChatMessage[] {
  const closing = options.questionsLeft <= 0;
  const instructions = [
    'Dialogue so far:',
    formatPlacementTranscript(options.previousTurns),
    '',
    'Current question and answer:',
    `Q [skill: ${options.currentTurn.skill}, level: ${options.currentTurn.targetLevel}]: ${options.currentTurn.question}`,
    `A: ${options.answer}`,
    '',
    'Evaluate this answer: fill "score", "feedback", "estimatedLevel", "confidence" and "rationale".',
  ];

  if (closing) {
    instructions.push(
      'This was the last allowed question: set "shouldFinish" to true and leave',
      '"assistantMessage" and "skill" empty.',
    );
  } else {
    const level = options.currentTurn.targetLevel;

    instructions.push(
      'Then ask the next question in "assistantMessage" and name the skill it checks',
      'in "skill"; pick a skill that is still under-tested. Adapt the difficulty to the',
      'score you have just given:',
      `- score ${PLACEMENT_PROMOTE_SCORE.toFixed(2)} or higher: ask at CEFR level ${shiftLevel(level, 1)};`,
      `- score ${PLACEMENT_DEMOTE_SCORE.toFixed(2)} or lower: ask at CEFR level ${shiftLevel(level, -1)};`,
      `- anything in between: stay at CEFR level ${level}.`,
      `At most ${String(options.questionsLeft)} question(s) may still be asked.`,
      'Set "shouldFinish" to true only if the level is already clear; in that case leave',
      '"assistantMessage" and "skill" empty.',
    );
  }

  return [
    { role: 'system', content: buildPlacementSystemPrompt(context) },
    { role: 'user', content: instructions.join('\n') },
  ];
}

/** Запрос итогового резюме теста. */
export function buildSummaryMessages(
  context: PlacementPromptContext,
  options: { turns: readonly PlacementTurn[]; accuracy: number },
): ChatMessage[] {
  return [
    { role: 'system', content: buildPlacementSystemPrompt(context) },
    {
      role: 'user',
      content: [
        'The placement dialogue is over. Here is the full transcript:',
        '',
        formatPlacementTranscript(options.turns),
        '',
        `Share of correct answers: ${options.accuracy.toFixed(2)}.`,
        'Summarise the result: final CEFR level, confidence, a short rationale,',
        'strengths, weaknesses and up to three learning goals for this learner.',
        'Write every string in the explanation language, in plain words, without CEFR jargon',
        'in the goals. Base the summary on the answers above, do not invent facts.',
      ].join('\n'),
    },
  ];
}
