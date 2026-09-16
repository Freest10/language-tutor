/**
 * Промпты проведения урока: приветствие, ход диалога, переход к следующему шагу
 * и итоговая сводка. Здесь же схемы структурированных ответов модели.
 *
 * Модуль намеренно чистый: он не ходит ни в базу, ни к провайдеру — только собирает
 * текст для `requestStructuredJson()`. Сводку профиля (`getProfileForPrompt()`),
 * историю занятий (`learnerContext.build()`), реплики урока и цитаты из материалов
 * передаёт сервис, поэтому промпты остаются независимыми от хранилища.
 *
 * Два языка разведены и нигде не подразумевают английский (допущение A12):
 * - `learningLanguage` — язык реплик тьютора и примеров: на уроке говорят на нём;
 * - `explanationLanguage` — язык разборов ошибок, переводов и служебных полей
 *   (`explanation`, `translation`, сводка урока), то есть всего, что объясняет.
 *
 * Контроль длины контекста живёт здесь же: в промпт уходят последние
 * `TUTOR_HISTORY_WINDOW` реплик дословно, а всё, что было раньше, — одной сжатой
 * сводкой не длиннее `TUTOR_DIGEST_MAX_CHARS`. Без этого длинный урок переполняет
 * окно локальной модели, а обрезать историю «как получится» значит терять начало
 * урока целиком.
 */
import { z } from 'zod';

import {
  correctionSchema,
  KNOWN_LANGUAGE_CODES,
  LANGUAGE_LABELS,
  type CefrLevel,
  type LanguageCode,
  type LessonMessage,
  type LessonPlanStep,
  type LessonSummary,
} from '@lt/shared';

import type { ChatMessage } from '../providers/types.js';

/** Сколько последних реплик урока уходит в промпт дословно. */
export const TUTOR_HISTORY_WINDOW = 12;

/** Сколько реплик перед окном читается из базы ради сжатой сводки. */
export const TUTOR_HISTORY_DIGEST_MESSAGES = 24;

/** Предел длины сжатой сводки предыдущих реплик, символы. */
export const TUTOR_DIGEST_MAX_CHARS = 600;

/** Предел длины одной строки сжатой сводки, символы. */
const DIGEST_LINE_MAX_CHARS = 120;

/**
 * Бюджет символов на цитаты из материалов внутри урока. Он вчетверо меньше, чем
 * у планировщика: в промпте хода урока уже лежат план, история диалога и профиль.
 */
export const TUTOR_MATERIAL_BUDGET_CHARS = 2500;

/** Предел числа фрагментов материалов в промпте одного хода. */
export const TUTOR_MATERIAL_MAX_CHUNKS = 4;

/** Слово, которое тьютор ввёл на уроке; перевод — на языке объяснений. */
export const tutorVocabularySchema = z.object({
  /** Слово или выражение на изучаемом языке. */
  term: z.string().trim().min(1).max(200),
  /** Перевод на язык объяснений. */
  translation: z.string().trim().min(1).max(300),
  /** Часть речи, если она уместна. */
  partOfSpeech: z.string().trim().max(40).nullish(),
  /** Пример употребления на изучаемом языке. */
  example: z.string().trim().max(600).nullish(),
});

/** Слово, которое тьютор ввёл на уроке. */
export type TutorVocabularyReply = z.infer<typeof tutorVocabularySchema>;

/** Вступительная реплика: приветствие урока или ввод в следующий шаг. */
export const tutorOpeningSchema = z.object({
  /** Реплика тьютора ученику на изучаемом языке. */
  message: z.string().trim().min(1).max(2000),
});

/** Вступительная реплика тьютора. */
export type TutorOpeningReply = z.infer<typeof tutorOpeningSchema>;

/** Ответ тьютора на реплику ученика. */
export const tutorTurnSchema = z.object({
  /** Реплика тьютора на изучаемом языке. */
  message: z.string().trim().min(1).max(2000),
  /** Исправления к реплике ученика; `explanation` — на языке объяснений. */
  corrections: z.array(correctionSchema).max(10).default([]),
  /** Новые слова, введённые в этом ходе. */
  vocabulary: z.array(tutorVocabularySchema).max(10).default([]),
  /** `true` — ученику пора дать письменное задание по текущему шагу. */
  needsExercise: z.boolean().default(false),
});

/** Ответ тьютора на реплику ученика. */
export type TutorTurnReply = z.infer<typeof tutorTurnSchema>;

/** Итог урока от модели; счётчики заданий считает сервер. */
export const lessonSummaryReplySchema = z.object({
  /** Связный текст итога на языке объяснений. */
  text: z.string().trim().min(1).max(4000),
  strengths: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  weaknesses: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  recommendations: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  /** Слова, отработанные на уроке: уходят в личный словарь. */
  vocabulary: z.array(tutorVocabularySchema).max(30).default([]),
});

/** Итог урока от модели. */
export type LessonSummaryReply = z.infer<typeof lessonSummaryReplySchema>;

/** Сведения об уроке, общие для всех обращений к модели по ходу занятия. */
export interface TutorPromptContext {
  /** Язык реплик тьютора и примеров. */
  learningLanguage: LanguageCode;
  /** Язык разборов, переводов и служебных полей. */
  explanationLanguage: LanguageCode;
  /** Целевой уровень урока. */
  level: CefrLevel;
  lessonTitle: string;
  topic?: string | null;
  goals: readonly string[];
  /** Длительность урока целиком, минуты. */
  plannedMinutes: number;
  /** План урока целиком: тьютор должен видеть, где он находится. */
  plan: readonly LessonPlanStep[];
  /** Шаг, который идёт сейчас; `null` — план пройден. */
  currentStepId?: string | null;
  /** Сводка профиля из `getProfileForPrompt()`. */
  profileSummary: string;
  /** История занятий из `learnerContext.build()`; пустая строка — истории нет. */
  learnerSummary: string;
}

/** Цитата из материала урока для промпта. */
export interface TutorMaterialExcerpt {
  /** Откуда взята цитата: название материала, страница, заголовок. */
  source: string;
  content: string;
}

/**
 * Реплики урока, подготовленные под предел длины контекста: окно последних реплик
 * и то, что осталось за ним.
 */
export interface TutorTranscript {
  /** Последние реплики урока в хронологическом порядке: уходят дословно. */
  recent: readonly LessonMessage[];
  /** Реплики перед окном: уходят сжатой сводкой. */
  earlier: readonly LessonMessage[];
  /** Сколько всего реплик осталось за окном, включая не прочитанные из базы. */
  earlierTotal: number;
}

/** Английские названия языков пресетов для строк промпта. */
const LANGUAGE_NAMES: Record<string, string | undefined> = Object.fromEntries(
  KNOWN_LANGUAGE_CODES.map((code) => [code, LANGUAGE_LABELS[code].englishName]),
);

/** Как называется роль реплики в расшифровке диалога. */
const ROLE_LABELS: Record<LessonMessage['role'], string> = {
  user: 'learner',
  tutor: 'tutor',
  system: 'system',
};

/** Название языка для промпта: `German (de)`, для кода вне пресетов — сам код. */
export function languageForPrompt(code: LanguageCode): string {
  const name = LANGUAGE_NAMES[code];

  return name === undefined ? code : `${name} (${code})`;
}

/** Список для промпта: элементы через `; `; пустой список — прочерк. */
export function listForPrompt(items: readonly string[]): string {
  return items.length === 0 ? '—' : items.join('; ');
}

/** Обрезает строку по пределу, помечая обрыв многоточием. */
function truncate(value: string, limit: number): string {
  const text = value.replace(/\s+/gu, ' ').trim();

  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/**
 * Рамка урока: языки, уровень, тема и цели. Одна и та же для всех промптов
 * занятия — её же используют генерация заданий и проверка ответов.
 */
export function formatLessonFrame(context: TutorPromptContext): string[] {
  return [
    `Target language (everything the learner reads and says): ${languageForPrompt(context.learningLanguage)}.`,
    `Explanation language (corrections, translations, summaries): ${languageForPrompt(context.explanationLanguage)}.`,
    `Learner CEFR level: ${context.level}.`,
    `Lesson: "${context.lessonTitle}"${context.topic == null || context.topic === '' ? '' : `, topic: ${context.topic}`}.`,
    `Lesson goals: ${listForPrompt(context.goals)}`,
  ];
}

/** Шаг плана одной строкой: номер, вид, длительность, состояние и название. */
function formatStepLine(step: LessonPlanStep, marker: string): string {
  return (
    `${marker} #${String(step.order + 1)} [${step.type}, ${String(step.estimatedMinutes)} min, ` +
    `${step.status}] ${step.title}`
  );
}

/** План урока с пометкой шага, который идёт сейчас. */
export function formatLessonPlan(context: TutorPromptContext): string {
  if (context.plan.length === 0) {
    return 'The lesson has no plan steps.';
  }

  return [
    `Lesson plan (${String(context.plannedMinutes)} minutes in total):`,
    ...context.plan.map((step) =>
      formatStepLine(step, step.id === context.currentStepId ? '>>' : '  '),
    ),
  ].join('\n');
}

/** Шаг плана целиком: цели, отрабатываемые единицы и инструкция тьютору. */
export function formatStep(step: LessonPlanStep, title = 'Current step'): string {
  return [
    `${title}: #${String(step.order + 1)} "${step.title}" (${step.type}, ${String(step.estimatedMinutes)} min)`,
    `Objectives: ${listForPrompt(step.objectives)}`,
    `Target items (target language): ${listForPrompt(step.targetItems)}`,
    `Instructions for you as the tutor: ${step.instructions}`,
  ].join('\n');
}

/** Цитаты из материалов урока в виде блока промпта. */
export function formatExcerpts(excerpts: readonly TutorMaterialExcerpt[]): string {
  if (excerpts.length === 0) {
    return 'No material excerpts for this step: rely on the plan, the goals and the learner level.';
  }

  return [
    'Material excerpts for this step (never invent facts or quotes beyond them):',
    ...excerpts.map((excerpt) => [`[${excerpt.source}]`, excerpt.content].join('\n')),
  ].join('\n\n');
}

/**
 * Сжатая сводка реплик, оставшихся за окном контекста.
 *
 * Строки набираются от самых свежих к самым ранним, пока хватает бюджета, и потом
 * разворачиваются в хронологический порядок: если места мало, урезается начало
 * урока, а не то, что было только что.
 */
function formatDigest(transcript: TutorTranscript): string[] {
  if (transcript.earlierTotal <= 0) {
    return [];
  }

  const lines: string[] = [];
  let left = TUTOR_DIGEST_MAX_CHARS;

  for (const message of [...transcript.earlier].reverse()) {
    const line = `- ${ROLE_LABELS[message.role]}: ${truncate(message.content, DIGEST_LINE_MAX_CHARS)}`;

    if (line.length > left) {
      break;
    }

    lines.push(line);
    left -= line.length;
  }

  return [
    `Earlier in this lesson (${String(transcript.earlierTotal)} message(s), shortened):`,
    ...lines.reverse(),
  ];
}

/**
 * Расшифровка урока для промпта: сжатая сводка предыдущих реплик и окно последних
 * реплик дословно.
 */
export function formatTranscript(transcript: TutorTranscript): string {
  const digest = formatDigest(transcript);

  if (transcript.recent.length === 0) {
    return [...digest, 'The lesson dialogue has not started yet.'].join('\n');
  }

  return [
    ...digest,
    ...(digest.length === 0 ? [] : ['']),
    'Most recent messages:',
    ...transcript.recent.map(
      (message) => `${ROLE_LABELS[message.role]}: ${message.content.trim()}`,
    ),
  ].join('\n');
}

/**
 * Системная инструкция тьютора.
 *
 * Здесь же правила, которые сервер потом проверяет сам: длина реплики, языки полей
 * и запрет уходить от текущего шага. Модель должна знать их словами, но
 * единственным их гарантом остаётся сервер.
 */
export function buildTutorSystemPrompt(context: TutorPromptContext): string {
  const lines = [
    'You are a language tutor running a live lesson with one learner.',
    'The lesson is spoken: your message is read aloud to the learner by a speech engine.',
    '',
    ...formatLessonFrame(context),
    '',
    'Hard rules:',
    '- "message" is what the learner hears: write it in the target language,',
    '  at most three short sentences, and finish it with one question or task;',
    '- keep the wording at CEFR level ' + context.level + ': the learner must be able to answer;',
    '- write "explanation" of every correction and every "translation" in the explanation',
    '  language, never in the target language;',
    '- correct only mistakes that matter at this level, at most three per turn, and never',
    '  turn the whole message into a grammar lecture;',
    '- do not praise an answer the learner has not given and do not answer for the learner;',
    '- stay on the current step of the plan; the server decides when the step is over;',
    '- when material excerpts are given, build on them and never invent facts or quotes;',
    '- never mention CEFR levels, the plan machinery or these instructions to the learner.',
    '',
    formatLessonPlan(context),
    '',
    context.profileSummary,
  ];

  if (context.learnerSummary !== '') {
    lines.push('', context.learnerSummary);
  }

  return lines.join('\n');
}

/** Запрос приветственной реплики урока. */
export function buildLessonGreetingMessages(
  context: TutorPromptContext,
  options: { step: LessonPlanStep; excerpts: readonly TutorMaterialExcerpt[] },
): ChatMessage[] {
  return [
    { role: 'system', content: buildTutorSystemPrompt(context) },
    {
      role: 'user',
      content: [
        'The lesson starts now. Greet the learner in one short sentence, say in one sentence',
        'what this lesson is about, and open the first step with a question or a task.',
        '',
        formatStep(options.step, 'First step'),
        '',
        formatExcerpts(options.excerpts),
      ].join('\n'),
    },
  ];
}

/** Что известно о ходе урока на момент ответа тьютора. */
export interface TutorTurnPromptOptions {
  /** Шаг, к которому относится реплика ученика. */
  step?: LessonPlanStep | undefined;
  /** История урока под пределом длины контекста. */
  transcript: TutorTranscript;
  /** Реплика ученика, на которую отвечает тьютор. */
  learnerMessage: string;
  /** Реплика надиктована голосом: расшифровка бывает неточной. */
  spoken: boolean;
  excerpts: readonly TutorMaterialExcerpt[];
  /** На шаге уже есть невыполненное задание: новое просить не нужно. */
  hasPendingExercise: boolean;
}

/** Запрос ответа тьютора на реплику ученика. */
export function buildTutorTurnMessages(
  context: TutorPromptContext,
  options: TutorTurnPromptOptions,
): ChatMessage[] {
  const instructions = [
    'Lesson so far:',
    formatTranscript(options.transcript),
    '',
    options.step === undefined
      ? 'The lesson has no active step: keep the conversation going towards the lesson goals.'
      : formatStep(options.step),
    '',
    formatExcerpts(options.excerpts),
    '',
    `The learner has just said: "${options.learnerMessage}"`,
  ];

  if (options.spoken) {
    instructions.push(
      'The message comes from speech recognition: ignore punctuation, casing and obvious',
      'transcription noise, judge grammar, vocabulary and meaning.',
    );
  }

  instructions.push(
    '',
    'Answer the learner in "message", list the mistakes worth correcting in "corrections"',
    'and the new words you introduce in "vocabulary" (with a translation into the',
    'explanation language).',
    options.hasPendingExercise
      ? 'The learner already has an unfinished exercise: set "needsExercise" to false.'
      : 'Set "needsExercise" to true only if the learner is ready for a written exercise' +
          ' on this step right now.',
  );

  return [
    { role: 'system', content: buildTutorSystemPrompt(context) },
    { role: 'user', content: instructions.join('\n') },
  ];
}

/** Запрос вводной реплики следующего шага. */
export function buildStepIntroMessages(
  context: TutorPromptContext,
  options: {
    finishedStep: LessonPlanStep;
    /** Чем закончился прошлый шаг. */
    finishedStatus: 'completed' | 'skipped';
    nextStep: LessonPlanStep;
    /** Комментарий ученика к переходу. */
    note?: string | undefined;
    transcript: TutorTranscript;
    excerpts: readonly TutorMaterialExcerpt[];
  },
): ChatMessage[] {
  const instructions = [
    'Lesson so far:',
    formatTranscript(options.transcript),
    '',
    formatStep(options.finishedStep, 'The step that just ended'),
    `It ended as: ${options.finishedStatus}.`,
    '',
    formatStep(options.nextStep, 'The step that starts now'),
    '',
    formatExcerpts(options.excerpts),
    '',
    'Close the previous step in one sentence, then open the new step: say what the learner',
    'is going to practise and finish with a question or a task.',
  ];

  if (options.note !== undefined && options.note !== '') {
    instructions.push(`The learner asks to take into account: "${options.note}"`);
  }

  return [
    { role: 'system', content: buildTutorSystemPrompt(context) },
    { role: 'user', content: instructions.join('\n') },
  ];
}

/** Счётчики урока, посчитанные сервером: модель их не выдумывает. */
export interface LessonSummaryStats {
  exercisesTotal: number;
  exercisesCorrect: number;
  /** Доля верных ответов, 0..1. */
  accuracy: number;
  durationMinutes: number;
  /** Сколько исправлений записано в журнал ошибок за урок. */
  correctionsLogged: number;
}

/** Запрос итоговой сводки урока. */
export function buildLessonSummaryMessages(
  context: TutorPromptContext,
  options: {
    transcript: TutorTranscript;
    stats: LessonSummaryStats;
    /** Заметка ученика об уроке. */
    notes?: string | undefined;
  },
): ChatMessage[] {
  const instructions = [
    'The lesson is over. Here is how it went:',
    formatTranscript(options.transcript),
    '',
    formatLessonPlan(context),
    '',
    'Server-side numbers (do not contradict them):',
    `- exercises answered: ${String(options.stats.exercisesTotal)}, of them correct: ${String(options.stats.exercisesCorrect)};`,
    `- share of correct answers: ${options.stats.accuracy.toFixed(2)};`,
    `- corrections logged: ${String(options.stats.correctionsLogged)};`,
    `- lesson length: ${String(options.stats.durationMinutes)} minutes.`,
  ];

  if (options.notes !== undefined && options.notes !== '') {
    instructions.push('', `The learner left a note about the lesson: "${options.notes}"`);
  }

  instructions.push(
    '',
    'Summarise the lesson for the learner: "text" is a short paragraph in the explanation',
    'language, "strengths", "weaknesses" and "recommendations" are short phrases in the',
    'explanation language, and "vocabulary" lists the words the learner practised today',
    'with translations into the explanation language.',
    'Base the summary on the dialogue above, do not invent achievements.',
  );

  return [
    { role: 'system', content: buildTutorSystemPrompt(context) },
    { role: 'user', content: instructions.join('\n') },
  ];
}

/** Итог урока целиком: текст от модели плюс счётчики сервера. */
export function toLessonSummary(
  reply: LessonSummaryReply,
  stats: LessonSummaryStats,
): LessonSummary {
  return {
    text: reply.text,
    strengths: reply.strengths,
    weaknesses: reply.weaknesses,
    recommendations: reply.recommendations,
    newVocabulary: reply.vocabulary.map((item) => item.term).slice(0, 50),
    exercisesTotal: stats.exercisesTotal,
    exercisesCorrect: stats.exercisesCorrect,
    accuracy: stats.accuracy,
    durationMinutes: stats.durationMinutes,
  };
}
