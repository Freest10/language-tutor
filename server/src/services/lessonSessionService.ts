/**
 * Проведение урока: начало занятия, ходы диалога, переходы по шагам плана,
 * попытки выполнения заданий, завершение и история реплик.
 *
 * Требование ТЗ — «мы их будем с ней проходить, она мне будет давать задания» —
 * раскладывается здесь на несколько решений:
 *
 * - **реплика ученика сохраняется ДО обращения к модели.** На локальной модели
 *   отказы регулярны, и терять сказанное учеником недопустимо: при 502 реплика
 *   уже лежит в `lesson_messages`, а повтор хода просто добавляет ответ тьютора.
 *   Всё остальное (ответ тьютора, исправления, задания, шаг, урок) пишется одной
 *   транзакцией уже после успешного ответа модели;
 * - **контекст собирает сервер, а не модель.** В промпт уходят сводка профиля,
 *   история занятий, план урока с пометкой текущего шага, цитаты из материалов
 *   этого шага и история диалога, нарезанная под окно модели: последние
 *   `TUTOR_HISTORY_WINDOW` реплик дословно плюс сжатая сводка предыдущих;
 * - **задания живут внутри хода урока.** Отдельного эндпоинта у них нет: они
 *   рождаются при переходе на новый шаг и внутри хода, когда тьютор считает ученика
 *   готовым, и уезжают клиенту полем `exercises[]`. Отказ модели на генерации
 *   заданий не роняет сам ход: реплика тьютора уже получена и сохранена;
 * - **прогресс пишется через `progressService`.** Новые слова, исправления и итоги
 *   заданий уходят туда же, откуда их читает экран прогресса. Записи, не прошедшие
 *   контракт, этот сервис молча отбрасывает (400 посреди урока хуже), поэтому
 *   расхождение «сколько передали / сколько сохранилось» пишется в лог;
 * - **уровень пересчитывается на завершении урока** (`maybeAdjustLevel()`, A13):
 *   урок уже помечен завершённым, поэтому попадает в окно статистики.
 *
 * Языки разведены как и везде (A12): реплики и примеры — на `learningLanguage`
 * урока, разборы, переводы и итог — на его `explanationLanguage`. Оба поля урок
 * получил из профиля при создании; посреди урока язык объяснений не меняется,
 * даже если профиль отредактировали.
 */
import { randomUUID } from 'node:crypto';

import {
  MAX_PAGE_SIZE,
  type AdvanceLessonStepRequest,
  type AdvanceLessonStepResponse,
  type CompleteLessonRequest,
  type CompleteLessonResponse,
  type Correction,
  type CreateExerciseAttemptRequest,
  type CreateExerciseAttemptResponse,
  type ErrorLogEntry,
  type Exercise,
  type ExerciseAttempt,
  type Id,
  type LearnerProfile,
  type Lesson,
  type LessonMessage,
  type LessonPlanStep,
  type LessonTurnRequest,
  type LessonTurnResponse,
  type ListLessonMessagesQuery,
  type ListLessonMessagesResponse,
  type StartLessonResponse,
} from '@lt/shared';

import { nowIso } from '../db/mappers.js';
import { conflict, notFound } from '../lib/httpErrors.js';
import {
  buildLessonGreetingMessages,
  buildLessonSummaryMessages,
  buildStepIntroMessages,
  buildTutorTurnMessages,
  lessonSummaryReplySchema,
  toLessonSummary,
  TUTOR_HISTORY_DIGEST_MESSAGES,
  TUTOR_HISTORY_WINDOW,
  TUTOR_MATERIAL_BUDGET_CHARS,
  TUTOR_MATERIAL_MAX_CHUNKS,
  tutorOpeningSchema,
  tutorTurnSchema,
  type LessonSummaryStats,
  type TutorMaterialExcerpt,
  type TutorPromptContext,
  type TutorTranscript,
  type TutorVocabularyReply,
} from '../prompts/tutorTurn.js';
import { requestStructuredJson } from '../providers/structuredJson.js';
import { isProviderError, type ProviderLogger } from '../providers/types.js';
import { findLessonById } from '../repositories/lessonRepository.js';
import {
  findAttemptedExerciseIds,
  findLessonExercise,
  findLessonHistory,
  insertLessonMessage,
  listLessonAttempts,
  listLessonMessages as selectLessonMessages,
  listStepExercises,
  nextExerciseOrder,
  saveLessonProgress,
} from '../repositories/lessonSessionRepository.js';
import { findMaterialsByIds, listChunksByMaterialIds } from '../repositories/materialRepository.js';

import {
  checkExerciseAnswer,
  generateStepExercises,
  stepWantsExercises,
  type ExerciseServiceOptions,
} from './exerciseService.js';
import * as learnerContext from './learnerContext.js';
import { getChunksForLesson } from './materialService.js';
import { getProfile, getProfileForPrompt } from './profileService.js';
import {
  listErrors,
  maybeAdjustLevel,
  recordErrors,
  recordExerciseOutcome,
  recordVocabulary,
  type VocabularyInput,
} from './progressService.js';

/** Температура диалога: речь должна быть живой, но в рамках плана. */
const TUTOR_TEMPERATURE = 0.6;

/** Температура итоговой сводки: итог должен быть предсказуемым, а не разнообразным. */
const SUMMARY_TEMPERATURE = 0.3;

/** Короткое слово в ключевые слова отбора фрагментов не берём. */
const MIN_KEYWORD_LENGTH = 4;

/** Предел числа ключевых слов для отбора фрагментов. */
const MAX_KEYWORDS = 24;

/**
 * Предел длительности урока в итоге, минуты. Урок, оставленный открытым на сутки,
 * не должен превращаться в 1440 минут занятий в статистике.
 */
const MAX_LESSON_DURATION_MINUTES = 600;

/** Общие параметры обращения к сервису. */
export interface LessonSessionOptions extends ExerciseServiceOptions {
  /** Логгер запроса: провайдер пишет в него повторы и тайминги. */
  logger?: ProviderLogger | undefined;
}

// ---------------------------------------------------------------------------
// Урок и его шаги
// ---------------------------------------------------------------------------

/** Урок по идентификатору; 404, если его нет. */
function requireLesson(id: Id): Lesson {
  const lesson = findLessonById(id);

  if (lesson === undefined) {
    throw notFound('Урок не найден', { details: { reason: 'lesson_not_found', lessonId: id } });
  }

  return lesson;
}

/** Идущий урок; 409 — урок ещё не начат или уже завершён. */
function requireRunningLesson(id: Id): Lesson {
  const lesson = requireLesson(id);

  if (lesson.status === 'draft') {
    throw conflict('Урок ещё не начат', {
      details: { reason: 'lesson_not_started', lessonId: id, status: lesson.status },
    });
  }

  if (lesson.status === 'completed') {
    throw conflict('Урок уже завершён', {
      details: { reason: 'lesson_completed', lessonId: id, status: lesson.status },
    });
  }

  return lesson;
}

/** Шаг урока по идентификатору; 404 — шаг из другого урока или его нет. */
function requireStep(lesson: Lesson, stepId: Id): LessonPlanStep {
  const step = lesson.plan.find((item) => item.id === stepId);

  if (step === undefined) {
    throw notFound('Шаг не принадлежит этому уроку', {
      details: { reason: 'lesson_step_not_found', lessonId: lesson.id, stepId },
    });
  }

  return step;
}

/** Шаг, на котором стоит урок; `undefined` — план пройден или урок не начат. */
function currentStep(lesson: Lesson): LessonPlanStep | undefined {
  const id = lesson.currentStepId;

  return id === null || id === undefined ? undefined : lesson.plan.find((step) => step.id === id);
}

/** Первый непройденный шаг после указанного; `undefined` — план кончился. */
function nextPendingStep(lesson: Lesson, step: LessonPlanStep): LessonPlanStep | undefined {
  return lesson.plan.find((item) => item.order > step.order && item.status === 'pending');
}

/** План урока с заменёнными шагами: остальные остаются как были. */
function withSteps(lesson: Lesson, steps: readonly LessonPlanStep[]): LessonPlanStep[] {
  const replaced = new Map(steps.map((step) => [step.id, step]));

  return lesson.plan.map((step) => replaced.get(step.id) ?? step);
}

// ---------------------------------------------------------------------------
// Контекст промптов
// ---------------------------------------------------------------------------

/** Сведения об уроке, общие для всех обращений к модели. */
function promptContext(
  lesson: Lesson,
  profile: LearnerProfile,
  currentStepId: Id | null = lesson.currentStepId ?? null,
): TutorPromptContext {
  return {
    learningLanguage: lesson.learningLanguage,
    explanationLanguage: lesson.explanationLanguage,
    level: lesson.level,
    lessonTitle: lesson.title,
    topic: lesson.topic ?? null,
    goals: lesson.goals,
    plannedMinutes: lesson.plannedMinutes,
    plan: lesson.plan,
    currentStepId,
    profileSummary: getProfileForPrompt(profile),
    learnerSummary: learnerContext.build({ language: lesson.learningLanguage, profile }),
  };
}

/**
 * История диалога под предел длины контекста: последние реплики дословно, всё
 * остальное — сжатой сводкой. `exclude` убирает из окна реплику, которая уходит
 * в промпт отдельно (её незачем показывать модели дважды).
 */
function transcriptOf(lessonId: Id, exclude?: Id): TutorTranscript {
  const history = findLessonHistory(lessonId, {
    window: TUTOR_HISTORY_WINDOW,
    digest: TUTOR_HISTORY_DIGEST_MESSAGES,
  });

  return {
    recent: history.recent.filter((message) => message.id !== exclude),
    earlier: history.earlier,
    earlierTotal: history.earlierTotal,
  };
}

/** Ключевые слова для отбора фрагментов: цели шага и тема урока, без коротких слов. */
function stepKeywords(lesson: Lesson, step: LessonPlanStep): string[] {
  const words = [lesson.topic ?? '', ...lesson.goals, ...step.targetItems, ...step.objectives]
    .flatMap((source) => source.toLowerCase().split(/[^\p{L}\p{N}]+/u))
    .filter((word) => word.length >= MIN_KEYWORD_LENGTH);

  return [...new Set(words)].slice(0, MAX_KEYWORDS);
}

/** Строка-источник цитаты: название материала, страница и заголовок. */
function excerptSource(
  title: string,
  page: number | null | undefined,
  heading: string | null | undefined,
): string {
  const parts = [`"${title}"`];

  if (page !== null && page !== undefined) {
    parts.push(`page ${String(page)}`);
  }
  if (heading !== null && heading !== undefined && heading !== '') {
    parts.push(heading);
  }

  return parts.join(', ');
}

/** Отрезает цитаты по бюджету промпта: фрагмент берётся целиком или не берётся. */
function withinBudget(excerpts: readonly TutorMaterialExcerpt[]): TutorMaterialExcerpt[] {
  const selected: TutorMaterialExcerpt[] = [];
  let left = TUTOR_MATERIAL_BUDGET_CHARS;

  for (const excerpt of excerpts.slice(0, TUTOR_MATERIAL_MAX_CHUNKS)) {
    if (excerpt.content.length > left) {
      break;
    }

    selected.push(excerpt);
    left -= excerpt.content.length;
  }

  return selected;
}

/**
 * Цитаты из материалов под текущий шаг.
 *
 * Если план уже закрепил за шагом фрагменты (`materialChunkIds`), берутся они:
 * это выбор планировщика, и переспрашивать его незачем. Иначе фрагменты отбираются
 * под бюджет промпта по ключевым словам шага.
 */
function stepExcerpts(lesson: Lesson, step: LessonPlanStep): TutorMaterialExcerpt[] {
  if (lesson.materialIds.length === 0) {
    return [];
  }

  if (step.materialChunkIds.length > 0) {
    const pinned = new Set(step.materialChunkIds);
    const titles = new Map(
      findMaterialsByIds(lesson.materialIds).map((material) => [material.id, material.title]),
    );
    const chunks = listChunksByMaterialIds(lesson.materialIds).filter((chunk) =>
      pinned.has(chunk.id),
    );

    return withinBudget(
      chunks.map((chunk) => ({
        source: excerptSource(titles.get(chunk.materialId) ?? '—', chunk.page, chunk.heading),
        content: chunk.content,
      })),
    );
  }

  const selection = getChunksForLesson(lesson.materialIds, TUTOR_MATERIAL_BUDGET_CHARS, {
    keywords: stepKeywords(lesson, step),
    maxChunks: TUTOR_MATERIAL_MAX_CHUNKS,
  });

  return selection.chunks.map((entry) => ({
    source: excerptSource(entry.materialTitle, entry.chunk.page, entry.chunk.heading),
    content: entry.chunk.content,
  }));
}

// ---------------------------------------------------------------------------
// Реплики и прогресс
// ---------------------------------------------------------------------------

/** Реплика тьютора; A10: аудио не сохраняется. */
function tutorMessage(
  lesson: Lesson,
  step: LessonPlanStep | undefined,
  content: string,
  options: { corrections?: readonly Correction[]; language?: string; createdAt: string },
): LessonMessage {
  return {
    id: randomUUID(),
    lessonId: lesson.id,
    stepId: step?.id ?? null,
    role: 'tutor',
    source: 'text',
    content,
    language: options.language ?? lesson.learningLanguage,
    corrections: [...(options.corrections ?? [])],
    audioPath: null,
    durationMs: null,
    createdAt: options.createdAt,
  };
}

/**
 * Пишет расхождение «передали / сохранилось» в лог.
 *
 * `recordVocabulary()` и `recordErrors()` молча отбрасывают элементы, не прошедшие
 * контракт: вход приходит от модели, и 400 посреди урока хуже потери одного слова.
 * Но без этой записи отладка «почему слово не сохранилось» невозможна.
 */
function logDropped(
  options: LessonSessionOptions,
  kind: 'vocabulary' | 'errors',
  requested: number,
  saved: number,
): void {
  if (saved >= requested) {
    return;
  }

  options.logger?.debug(
    { target: 'progress', kind, requested, saved, dropped: requested - saved },
    'ход урока: часть записей прогресса не прошла контракт и отброшена',
  );
}

/** Слова от модели в виде входа личного словаря. */
function toVocabularyInputs(
  lesson: Lesson,
  items: readonly TutorVocabularyReply[],
): VocabularyInput[] {
  return items.map((item) => ({
    term: item.term,
    translation: item.translation,
    language: lesson.learningLanguage,
    translationLanguage: lesson.explanationLanguage,
    partOfSpeech: item.partOfSpeech ?? null,
    example: item.example ?? null,
    level: lesson.level,
    lessonId: lesson.id,
  }));
}

/** Есть ли на шаге задание, на которое ещё не отвечали. */
function hasPendingExercise(lessonId: Id, step: LessonPlanStep | undefined): boolean {
  if (step === undefined) {
    return false;
  }

  const attempted = findAttemptedExerciseIds(lessonId);

  return listStepExercises(lessonId, step.id).some((exercise) => !attempted.has(exercise.id));
}

/**
 * Задания под шаг; отказ модели здесь не роняет ход урока.
 *
 * Реплика тьютора к этому моменту уже получена, и терять её из-за того, что
 * не сочинились упражнения, нельзя: клиент получит ход без `exercises[]`,
 * а задания появятся на следующем ходе.
 */
async function tryGenerateExercises(
  lesson: Lesson,
  step: LessonPlanStep,
  context: TutorPromptContext,
  options: LessonSessionOptions,
): Promise<Exercise[]> {
  if (!stepWantsExercises(step)) {
    return [];
  }

  try {
    return await generateStepExercises(
      {
        lessonId: lesson.id,
        level: lesson.level,
        step,
        context,
        excerpts: stepExcerpts(lesson, step),
        existingPrompts: listStepExercises(lesson.id, step.id).map((exercise) => exercise.prompt),
        startOrder: nextExerciseOrder(lesson.id),
      },
      options,
    );
  } catch (error) {
    if (!isProviderError(error)) {
      throw error;
    }

    options.logger?.warn(
      { target: 'llm', lessonId: lesson.id, stepId: step.id, kind: error.kind },
      'ход урока: задания не сгенерированы, урок продолжается без них',
    );

    return [];
  }
}

// ---------------------------------------------------------------------------
// Эндпоинты
// ---------------------------------------------------------------------------

/**
 * Начинает урок: переводит его в `in_progress`, делает первый шаг активным
 * и отдаёт приветственную реплику тьютора.
 *
 * Повторный старт идущего урока ничего не меняет и к модели не обращается:
 * открыть комнату урока заново — обычное дело, и второе приветствие в истории
 * было бы мусором. История урока читается через `GET /api/lessons/:id/messages`.
 */
export async function startLesson(
  id: Id,
  options: LessonSessionOptions = {},
): Promise<StartLessonResponse> {
  const lesson = requireLesson(id);

  if (lesson.status === 'completed') {
    throw conflict('Урок уже завершён', {
      details: { reason: 'lesson_completed', lessonId: id, status: lesson.status },
    });
  }

  if (lesson.status === 'in_progress') {
    options.logger?.debug(
      { target: 'lesson', lessonId: id },
      'ход урока: повторный старт идущего урока, новое приветствие не создаётся',
    );

    return { lesson, messages: [], currentStep: currentStep(lesson) ?? null };
  }

  const step = lesson.plan[0];

  if (step === undefined) {
    throw conflict('У урока нет ни одного шага плана: проводить нечего', {
      details: { reason: 'lesson_plan_empty', lessonId: id },
    });
  }

  const profile = getProfile();
  const context = promptContext(lesson, profile, step.id);
  const { data } = await requestStructuredJson({
    schema: tutorOpeningSchema,
    messages: buildLessonGreetingMessages(context, {
      step,
      excerpts: stepExcerpts(lesson, step),
    }),
    schemaName: 'tutor_opening',
    temperature: TUTOR_TEMPERATURE,
    logger: options.logger,
  });
  const startedAt = nowIso();
  const startedStep: LessonPlanStep = { ...step, status: 'in_progress', startedAt };
  const message = tutorMessage(lesson, startedStep, data.message, { createdAt: startedAt });
  const updated: Lesson = {
    ...lesson,
    status: 'in_progress',
    plan: withSteps(lesson, [startedStep]),
    currentStepId: startedStep.id,
    startedAt: lesson.startedAt ?? startedAt,
    updatedAt: startedAt,
  };

  saveLessonProgress({ lesson: updated, steps: [startedStep], messages: [message] });

  return { lesson: updated, messages: [message], currentStep: startedStep };
}

/**
 * Принимает реплику ученика и отвечает на неё.
 *
 * Порядок операций здесь важен: реплика ученика сохраняется первой, отдельной
 * транзакцией, и переживает любой отказ модели. Ответ тьютора, исправления к
 * реплике ученика, новые задания и состояние урока пишутся одной транзакцией
 * уже после успешного ответа.
 */
export async function submitLessonTurn(
  id: Id,
  input: LessonTurnRequest,
  options: LessonSessionOptions = {},
): Promise<LessonTurnResponse> {
  const lesson = requireRunningLesson(id);
  const step = input.stepId === undefined ? currentStep(lesson) : requireStep(lesson, input.stepId);
  const askedAt = nowIso();
  const learnerMessage: LessonMessage = {
    id: randomUUID(),
    lessonId: lesson.id,
    stepId: step?.id ?? null,
    role: 'user',
    source: input.source,
    content: input.text,
    language: lesson.learningLanguage,
    corrections: [],
    audioPath: null,
    durationMs: input.durationMs ?? null,
    createdAt: askedAt,
  };

  // Реплика ученика сохраняется ДО обращения к модели: отказ провайдера не должен
  // стоить ученику сказанного, а повтор хода обязан работать.
  insertLessonMessage(learnerMessage);

  const profile = getProfile();
  const context = promptContext(lesson, profile, step?.id ?? null);
  const pending = hasPendingExercise(lesson.id, step);
  const { data } = await requestStructuredJson({
    schema: tutorTurnSchema,
    messages: buildTutorTurnMessages(context, {
      step,
      transcript: transcriptOf(lesson.id, learnerMessage.id),
      learnerMessage: input.text,
      spoken: input.source === 'voice',
      excerpts: step === undefined ? [] : stepExcerpts(lesson, step),
      hasPendingExercise: pending,
    }),
    schemaName: 'tutor_turn',
    temperature: TUTOR_TEMPERATURE,
    logger: options.logger,
  });
  const exercises =
    data.needsExercise && !pending && step !== undefined
      ? await tryGenerateExercises(lesson, step, context, options)
      : [];
  const answeredAt = nowIso();
  const userMessage: LessonMessage = { ...learnerMessage, corrections: data.corrections };
  const reply = tutorMessage(lesson, step, data.message, { createdAt: answeredAt });
  const updatedStep =
    step === undefined || exercises.length === 0
      ? undefined
      : { ...step, exerciseIds: [...step.exerciseIds, ...exercises.map((item) => item.id)] };
  const updated: Lesson = {
    ...lesson,
    plan: withSteps(lesson, updatedStep === undefined ? [] : [updatedStep]),
    updatedAt: answeredAt,
  };

  saveLessonProgress({
    lesson: updated,
    steps: updatedStep === undefined ? [] : [updatedStep],
    messages: [reply],
    updatedMessages: [userMessage],
    exercises,
  });

  const vocabulary = recordVocabulary(toVocabularyInputs(lesson, data.vocabulary));
  const errors = recordErrors(lesson.id, data.corrections, {
    language: lesson.learningLanguage,
    stepId: step?.id ?? null,
    messageId: userMessage.id,
    occurredAt: answeredAt,
  });

  logDropped(options, 'vocabulary', data.vocabulary.length, vocabulary.length);
  logDropped(options, 'errors', data.corrections.length, errors.length);

  return {
    userMessage,
    tutorMessage: reply,
    corrections: data.corrections,
    lesson: updated,
    currentStep: currentStep(updated) ?? null,
    exercises,
  };
}

/**
 * Закрывает шаг плана и открывает следующий.
 *
 * Модель вызывается только ради вводной реплики нового шага, поэтому у последнего
 * шага плана обращения к ней нет: шаг закрывается, `currentStepId` становится
 * пустым, а урок ждёт `POST /api/lessons/:id/complete`.
 */
export async function advanceLessonStep(
  id: Id,
  stepId: Id,
  input: AdvanceLessonStepRequest,
  options: LessonSessionOptions = {},
): Promise<AdvanceLessonStepResponse> {
  const lesson = requireRunningLesson(id);
  const step = requireStep(lesson, stepId);

  if (step.status === 'completed' || step.status === 'skipped') {
    throw conflict('Этот шаг урока уже закрыт', {
      details: {
        reason: 'lesson_step_already_finished',
        lessonId: id,
        stepId,
        status: step.status,
      },
    });
  }

  const next = nextPendingStep(lesson, step);
  const profile = getProfile();
  const messages: LessonMessage[] = [];
  let exercises: Exercise[] = [];

  if (next !== undefined) {
    const context = promptContext(lesson, profile, next.id);
    const { data } = await requestStructuredJson({
      schema: tutorOpeningSchema,
      messages: buildStepIntroMessages(context, {
        finishedStep: step,
        finishedStatus: input.status,
        nextStep: next,
        note: input.note,
        transcript: transcriptOf(lesson.id),
        excerpts: stepExcerpts(lesson, next),
      }),
      schemaName: 'tutor_opening',
      temperature: TUTOR_TEMPERATURE,
      logger: options.logger,
    });

    exercises = await tryGenerateExercises(lesson, next, context, options);
    messages.push(tutorMessage(lesson, next, data.message, { createdAt: nowIso() }));
  }

  const at = nowIso();
  const finished: LessonPlanStep = {
    ...step,
    status: input.status,
    startedAt: step.startedAt ?? at,
    completedAt: at,
  };
  const started =
    next === undefined
      ? undefined
      : {
          ...next,
          status: 'in_progress' as const,
          startedAt: at,
          exerciseIds: [...next.exerciseIds, ...exercises.map((item) => item.id)],
        };
  const steps = started === undefined ? [finished] : [finished, started];
  const updated: Lesson = {
    ...lesson,
    plan: withSteps(lesson, steps),
    currentStepId: started?.id ?? null,
    updatedAt: at,
  };

  saveLessonProgress({ lesson: updated, steps, messages, exercises });

  return { lesson: updated, currentStep: started ?? null, messages, exercises };
}

/**
 * Принимает ответ ученика на задание: разбирает его моделью, сохраняет попытку
 * и учитывает результат в прогрессе.
 *
 * `recordExerciseOutcome()` вызывается после вставки попытки — иначе она не попала
 * бы в агрегаты верных ответов, по которым пересчитывается уровень (A13).
 */
export async function submitExerciseAttempt(
  id: Id,
  exerciseId: Id,
  input: CreateExerciseAttemptRequest,
  options: LessonSessionOptions = {},
): Promise<CreateExerciseAttemptResponse> {
  const lesson = requireRunningLesson(id);
  const exercise = findLessonExercise(id, exerciseId);

  if (exercise === undefined) {
    throw notFound('Задание не принадлежит этому уроку', {
      details: { reason: 'exercise_not_found', lessonId: id, exerciseId },
    });
  }

  const step =
    exercise.stepId == null ? undefined : lesson.plan.find((item) => item.id === exercise.stepId);
  const profile = getProfile();
  const data = await checkExerciseAnswer(
    {
      context: promptContext(lesson, profile, step?.id ?? null),
      exercise,
      step,
      answer: input.answer,
      spoken: input.source === 'voice',
    },
    options,
  );
  const at = nowIso();
  const attempt: ExerciseAttempt = {
    id: randomUUID(),
    exerciseId: exercise.id,
    lessonId: lesson.id,
    stepId: exercise.stepId ?? null,
    answer: input.answer,
    source: input.source,
    isCorrect: data.isCorrect,
    score: data.score,
    corrections: data.corrections,
    feedback: data.feedback,
    durationMs: input.durationMs ?? null,
    createdAt: at,
  };
  const spoken = data.message?.trim() ?? '';
  const message = tutorMessage(lesson, step, spoken === '' ? data.feedback : spoken, {
    corrections: data.corrections,
    language: spoken === '' ? lesson.explanationLanguage : lesson.learningLanguage,
    createdAt: at,
  });
  const updated: Lesson = { ...lesson, updatedAt: at };

  saveLessonProgress({ lesson: updated, messages: [message], attempt });

  const outcome = recordExerciseOutcome({
    lessonId: lesson.id,
    exerciseId: exercise.id,
    stepId: exercise.stepId ?? null,
    isCorrect: data.isCorrect,
    targetItems: exercise.targetItems,
    corrections: data.corrections,
    language: lesson.learningLanguage,
    occurredAt: at,
  });

  logDropped(options, 'errors', data.corrections.length, outcome.errors.length);

  const attempted = findAttemptedExerciseIds(lesson.id);
  const nextExercise =
    step === undefined
      ? undefined
      : listStepExercises(lesson.id, step.id).find((item) => !attempted.has(item.id));

  return {
    attempt,
    exercise,
    lesson: updated,
    nextExercise: nextExercise ?? null,
    messages: [message],
  };
}

/** Доля верных ответов, 0..1; без попыток — 0, а не деление на ноль. */
function accuracyOf(correct: number, total: number): number {
  return total === 0 ? 0 : Math.min(1, Math.max(0, correct / total));
}

/** Фактическая длительность урока в минутах, ограниченная сверху. */
function lessonDurationMinutes(lesson: Lesson, completedAt: string): number {
  if (lesson.startedAt === null || lesson.startedAt === undefined) {
    return 0;
  }

  const minutes = Math.round((Date.parse(completedAt) - Date.parse(lesson.startedAt)) / 60_000);

  return Math.min(MAX_LESSON_DURATION_MINUTES, Math.max(0, minutes));
}

/** Записи журнала ошибок, накопленные за урок. */
function lessonErrors(lessonId: Id): ErrorLogEntry[] {
  return listErrors({ lessonId, limit: MAX_PAGE_SIZE, offset: 0, order: 'asc' }).items;
}

/**
 * Завершает урок: сохраняет итог, закрывает начатый шаг и пересчитывает уровень.
 *
 * Шаги, к которым так и не приступили, остаются `pending`: урок, пройденный
 * наполовину, честнее показать как есть, чем дорисовать ему пройденный план.
 */
export async function completeLesson(
  id: Id,
  input: CompleteLessonRequest,
  options: LessonSessionOptions = {},
): Promise<CompleteLessonResponse> {
  const lesson = requireRunningLesson(id);
  const attempts = listLessonAttempts(id);
  const errorsLogged = lessonErrors(id);
  const correct = attempts.filter((attempt) => attempt.isCorrect).length;
  const completedAt = nowIso();
  const stats: LessonSummaryStats = {
    exercisesTotal: attempts.length,
    exercisesCorrect: correct,
    accuracy: accuracyOf(correct, attempts.length),
    durationMinutes: input.durationMinutes ?? lessonDurationMinutes(lesson, completedAt),
    correctionsLogged: errorsLogged.length,
  };
  const profile = getProfile();
  const { data } = await requestStructuredJson({
    schema: lessonSummaryReplySchema,
    messages: buildLessonSummaryMessages(promptContext(lesson, profile), {
      transcript: transcriptOf(id),
      stats,
      notes: input.notes,
    }),
    schemaName: 'lesson_summary',
    temperature: SUMMARY_TEMPERATURE,
    logger: options.logger,
  });
  const summary = toLessonSummary(data, stats);
  const at = nowIso();
  const steps = lesson.plan
    .filter((step) => step.status === 'in_progress')
    .map((step) => ({ ...step, status: 'completed' as const, completedAt: at }));
  // Итог урока — тоже часть истории комнаты: он должен остаться в диалоге.
  const message = tutorMessage(lesson, undefined, summary.text, {
    language: lesson.explanationLanguage,
    createdAt: at,
  });
  const updated: Lesson = {
    ...lesson,
    status: 'completed',
    plan: withSteps(lesson, steps),
    currentStepId: null,
    summary,
    completedAt: at,
    updatedAt: at,
  };

  saveLessonProgress({ lesson: updated, steps, messages: [message] });

  const vocabularyAdded = recordVocabulary(toVocabularyInputs(lesson, data.vocabulary));

  logDropped(options, 'vocabulary', data.vocabulary.length, vocabularyAdded.length);

  // Уровень пересчитывается после того, как урок помечен завершённым: иначе он
  // не попал бы в окно статистики `LEVEL_CHANGE_POLICY` (A13).
  const adjustment = maybeAdjustLevel();

  return {
    lesson: updated,
    summary,
    levelChange: adjustment.entry,
    vocabularyAdded,
    errorsLogged,
  };
}

/**
 * История диалога урока: по ней клиент восстанавливает комнату после перезагрузки.
 * Порядок по умолчанию — от старых реплик к новым.
 */
export function listLessonMessages(
  id: Id,
  query: ListLessonMessagesQuery,
): ListLessonMessagesResponse {
  requireLesson(id);

  return selectLessonMessages(id, query);
}
