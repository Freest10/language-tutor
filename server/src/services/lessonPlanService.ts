/**
 * Планирование урока: сборка контекста, обращение к модели, сохранение плана.
 *
 * Требование ТЗ — «она строит план мне на урок, я загружаю материалы, мы их
 * проходим» — раскладывается здесь на четыре решения:
 * - **контекст собирает сервер, а не модель.** В промпт уходят сводка профиля
 *   (`getProfileForPrompt()`), история занятий (`learnerContext.build()`) и цитаты
 *   из материалов, отобранные под бюджет символов (`getChunksForLesson()`);
 * - **материалы необязательны.** У нового пользователя их ещё нет, поэтому урок
 *   по целям и интересам профиля — полноценный путь, а не запасной;
 * - **правила плана проверяет сервер.** Число шагов входит в схему ответа (и чинится
 *   ремонтным заходом `requestStructuredJson()`), а сумма минут при необходимости
 *   пересчитывается пропорционально: план, который не укладывается в урок, бесполезен;
 * - **план сохраняется целиком или никак.** Урок, шаги и связи с материалами пишутся
 *   одной транзакцией: урок без шагов хуже, чем отсутствие урока.
 *
 * Язык названий, целей и инструкций — `explanationLanguage` профиля, язык примеров
 * и отрабатываемых слов — `learningLanguage` (допущение A12). Про язык интерфейса
 * сервер не знает и в планировании его не учитывает.
 */
import { randomUUID } from 'node:crypto';

import {
  type CreateLessonRequest,
  type CreateLessonResponse,
  type GetLessonResponse,
  type Id,
  type LearnerProfile,
  type Lesson,
  type LessonPlanStep,
  type ListLessonsQuery,
  type ListLessonsResponse,
  type RegenerateLessonPlanRequest,
  type RegenerateLessonPlanResponse,
} from '@lt/shared';

import { nowIso } from '../db/mappers.js';
import { badRequest, conflict, notFound } from '../lib/httpErrors.js';
import {
  buildLessonPlanMessages,
  LESSON_MATERIAL_BUDGET_CHARS,
  LESSON_MATERIAL_MAX_CHUNKS,
  LESSON_PLAN_MAX_STEPS,
  LESSON_PLAN_MIN_STEPS,
  LESSON_PLAN_MINUTES_TOLERANCE,
  lessonPlanReplySchema,
  materialRefLabel,
  type LessonMaterialExcerpt,
  type LessonPlanPromptContext,
  type LessonPlanRequestOptions,
  type LessonPlanStepReply,
} from '../prompts/lessonPlan.js';
import { requestStructuredJson } from '../providers/structuredJson.js';
import type { ProviderLogger } from '../providers/types.js';
import {
  insertLesson,
  listLessons as selectLessons,
  replaceLessonPlan,
} from '../repositories/lessonRepository.js';
import {
  listLessonAttempts,
  listLessonExercises,
} from '../repositories/lessonSessionRepository.js';
import { findMaterialsByIds } from '../repositories/materialRepository.js';

import * as learnerContext from './learnerContext.js';
import { requireLesson } from './lessonAccess.js';
import { extractKeywords, getChunksForLesson } from './materialService.js';
import { getProfile, getProfileForPrompt } from './profileService.js';

/** Температура генерации: план должен быть предсказуемым, а не разнообразным. */
const LESSON_PLAN_TEMPERATURE = 0.4;

/** Границы длительности шага из `lessonPlanStepSchema`. */
const MIN_STEP_MINUTES = 1;
const MAX_STEP_MINUTES = 120;

/** Границы длительности урока из `lessonSchema.plannedMinutes`. */
const MIN_LESSON_MINUTES = 5;
const MAX_LESSON_MINUTES = 240;

/** Предел числа шагов в плане из `lessonSchema.plan`. */
const MAX_PLAN_STEPS = 20;

/** Общие параметры обращения к сервису. */
export interface LessonPlanServiceOptions {
  /** Логгер запроса: провайдер пишет в него повторы и тайминги. */
  logger?: ProviderLogger | undefined;
}

/** Фрагменты материалов для промпта вместе с разбором меток. */
interface PlanMaterials {
  excerpts: LessonMaterialExcerpt[];
  /** Метка промпта (`C1`) → идентификатор фрагмента материала. */
  chunkIdByRef: Map<string, Id>;
}

/**
 * Проверяет, что каждый выбранный материал годится для урока.
 *
 * Молча выбросить материал нельзя: пользователь загрузил скан PDF, не увидел его
 * в уроке и не понял почему. Поэтому неизвестный материал — это 404, а материал
 * без извлечённого текста (`error_*`, пустой) — 400 с перечнем причин.
 */
function assertMaterialsUsable(materialIds: readonly Id[]): void {
  if (materialIds.length === 0) {
    return;
  }

  const materials = findMaterialsByIds(materialIds);
  const found = new Set(materials.map((material) => material.id));
  const missing = materialIds.filter((id) => !found.has(id));

  if (missing.length > 0) {
    throw notFound('Материал урока не найден', {
      details: { reason: 'material_not_found', materialIds: missing },
    });
  }

  const unusable = materials.filter(
    (material) => material.status !== 'ready' || material.chunkCount === 0,
  );

  if (unusable.length > 0) {
    throw badRequest('Из выбранных материалов не извлечён текст, урок по ним не построить', {
      details: {
        reason: 'materials_not_ready',
        materials: unusable.map((material) => ({
          id: material.id,
          title: material.title,
          status: material.status,
          statusMessage: material.statusMessage ?? null,
          chunkCount: material.chunkCount,
        })),
      },
    });
  }
}

/**
 * Отбирает цитаты из материалов под бюджет промпта и подписывает их метками,
 * по которым модель ссылается на фрагменты (`materialRefs`).
 */
function selectMaterials(
  materialIds: readonly Id[],
  keywords: readonly string[],
  options: LessonPlanServiceOptions,
): PlanMaterials {
  const selection = getChunksForLesson(materialIds, LESSON_MATERIAL_BUDGET_CHARS, {
    keywords,
    maxChunks: LESSON_MATERIAL_MAX_CHUNKS,
  });

  if (selection.skippedMaterialIds.length > 0 || selection.truncated) {
    // Сюда попадают готовые материалы, чьи фрагменты не влезли в бюджет промпта:
    // непригодные для урока отсеяны раньше, в `assertMaterialsUsable()`.
    options.logger?.warn(
      {
        target: 'llm',
        skippedMaterialIds: selection.skippedMaterialIds,
        truncated: selection.truncated,
        totalChars: selection.totalChars,
      },
      'план урока: в бюджет промпта поместились не все фрагменты материалов',
    );
  }

  const chunkIdByRef = new Map<string, Id>();
  const excerpts = selection.chunks.map((entry, index) => {
    const ref = materialRefLabel(index);

    chunkIdByRef.set(ref, entry.chunk.id);

    return {
      ref,
      materialTitle: entry.materialTitle,
      page: entry.chunk.page,
      heading: entry.chunk.heading,
      content: entry.chunk.content,
    };
  });

  return { excerpts, chunkIdByRef };
}

/** Фрагменты, на которые сослалась модель; выдуманные метки отбрасываются. */
function resolveChunkIds(refs: readonly string[], chunkIdByRef: Map<string, Id>): Id[] {
  const ids = refs
    .map((ref) => chunkIdByRef.get(ref.trim().toUpperCase()))
    .filter((id): id is Id => id !== undefined);

  return [...new Set(ids)];
}

/** Сумма чисел. */
function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Длительность шага в границах контракта. */
function clampStepMinutes(value: number): number {
  return Math.min(MAX_STEP_MINUTES, Math.max(MIN_STEP_MINUTES, value));
}

/** Шаг, которому можно добавить или у которого можно отнять минуту: самый длинный. */
function longestAdjustableIndex(values: readonly number[], delta: number): number {
  let best = -1;

  for (const [index, value] of values.entries()) {
    const fits = delta > 0 ? value < MAX_STEP_MINUTES : value > MIN_STEP_MINUTES;

    if (fits && (best === -1 || value > (values[best] ?? 0))) {
      best = index;
    }
  }

  return best;
}

/**
 * Приводит длительности шагов к длительности урока.
 *
 * Если модель уже уложилась в допуск (`LESSON_PLAN_MINUTES_TOLERANCE`), её числа
 * остаются как есть: пересчитывать удачный план незачем. Иначе минуты
 * масштабируются пропорционально, а остаток от округления раздаётся самым длинным
 * шагам. Отказываться от плана из-за арифметики не стоит — она чинится сервером.
 */
export function fitStepMinutes(values: readonly number[], target: number): number[] {
  if (values.length === 0) {
    return [];
  }

  const total = sum(values);

  if (total > 0 && Math.abs(total - target) <= target * LESSON_PLAN_MINUTES_TOLERANCE) {
    return [...values];
  }

  const scaled =
    total > 0
      ? values.map((value) => clampStepMinutes(Math.round((value * target) / total)))
      : values.map(() => clampStepMinutes(Math.round(target / values.length)));
  let remainder = target - sum(scaled);

  while (remainder !== 0) {
    const delta = remainder > 0 ? 1 : -1;
    const index = longestAdjustableIndex(scaled, delta);

    if (index === -1) {
      break;
    }

    scaled[index] = (scaled[index] ?? 0) + delta;
    remainder -= delta;
  }

  return scaled;
}

/** Переводит шаги из ответа модели в шаги плана: идентификаторы и статусы ставит сервер. */
function toPlanSteps(
  lessonId: Id,
  replies: readonly LessonPlanStepReply[],
  options: { firstOrder: number; minutes: number; chunkIdByRef: Map<string, Id> },
): LessonPlanStep[] {
  const minutes = fitStepMinutes(
    replies.map((reply) => reply.estimatedMinutes),
    options.minutes,
  );

  return replies.map((reply, index) => ({
    id: randomUUID(),
    lessonId,
    order: options.firstOrder + index,
    type: reply.type,
    title: reply.title,
    objectives: reply.objectives,
    targetItems: reply.targetItems,
    instructions: reply.instructions,
    estimatedMinutes: minutes[index] ?? reply.estimatedMinutes,
    status: 'pending',
    materialChunkIds: resolveChunkIds(reply.materialRefs, options.chunkIdByRef),
    exerciseIds: [],
    startedAt: null,
    completedAt: null,
  }));
}

/** Сведения об уроке, общие для всех обращений к модели. */
function promptContext(
  profile: LearnerProfile,
  lesson: { level: Lesson['level']; durationMinutes: number },
): LessonPlanPromptContext {
  return {
    learningLanguage: profile.learningLanguage,
    explanationLanguage: profile.explanationLanguage,
    level: lesson.level,
    durationMinutes: lesson.durationMinutes,
    profileSummary: getProfileForPrompt(profile),
    learnerSummary: learnerContext.build({ language: profile.learningLanguage, profile }),
  };
}

/** План от модели, разобранный схемой `lesson_plan`. */
async function requestPlan(
  context: LessonPlanPromptContext,
  request: LessonPlanRequestOptions,
  options: LessonPlanServiceOptions,
) {
  const { data } = await requestStructuredJson({
    schema: lessonPlanReplySchema({ minSteps: request.minSteps, maxSteps: request.maxSteps }),
    messages: buildLessonPlanMessages(context, request),
    schemaName: 'lesson_plan',
    temperature: LESSON_PLAN_TEMPERATURE,
    logger: options.logger,
  });

  return data;
}

/**
 * Создаёт урок с планом.
 *
 * Всё тело запроса необязательно: без параметров урок планируется по профилю —
 * уровень, дневная норма минут, цели и интересы. Материалы тоже необязательны,
 * но выбранные обязаны быть пригодны: молча пропущенных материалов не бывает.
 */
export async function createLesson(
  input: CreateLessonRequest,
  options: LessonPlanServiceOptions = {},
): Promise<CreateLessonResponse> {
  const profile = getProfile();
  const level = input.level ?? profile.level;
  const durationMinutes = input.durationMinutes ?? profile.dailyMinutes;
  const goals = input.goals ?? profile.goals;
  // Повтор материала в запросе — не ошибка пользователя, но в `lesson_materials`
  // пара (урок, материал) уникальна, поэтому список приводится к множеству.
  const materialIds = [...new Set(input.materialIds ?? [])];

  assertMaterialsUsable(materialIds);

  const materials = selectMaterials(
    materialIds,
    extractKeywords([input.topic, ...goals, ...profile.interests]),
    options,
  );
  const context = promptContext(profile, { level, durationMinutes });
  const reply = await requestPlan(
    context,
    {
      goals,
      topic: input.topic ?? null,
      focus: input.focus ?? [],
      excerpts: materials.excerpts,
      minSteps: LESSON_PLAN_MIN_STEPS,
      maxSteps: LESSON_PLAN_MAX_STEPS,
      minutes: durationMinutes,
    },
    options,
  );
  const timestamp = nowIso();
  const lessonId = randomUUID();
  const lesson: Lesson = {
    id: lessonId,
    title: input.title ?? reply.title,
    status: 'draft',
    learningLanguage: profile.learningLanguage,
    explanationLanguage: profile.explanationLanguage,
    level,
    topic: input.topic ?? reply.topic ?? null,
    goals: [...goals],
    materialIds: [...materialIds],
    plan: toPlanSteps(lessonId, reply.steps, {
      firstOrder: 0,
      minutes: durationMinutes,
      chunkIdByRef: materials.chunkIdByRef,
    }),
    currentStepId: null,
    plannedMinutes: durationMinutes,
    summary: null,
    startedAt: null,
    completedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  insertLesson(lesson);

  return lesson;
}

/** Страница списка уроков от новых к старым. */
export function listLessons(query: ListLessonsQuery): ListLessonsResponse {
  return selectLessons(query);
}

/**
 * Урок целиком: план и материалы лежат в самом уроке, задания и попытки
 * накапливаются по ходу занятия.
 *
 * Читать их здесь обязательно: комната урока восстанавливается после
 * перезагрузки именно отсюда, и с пустыми списками панель заданий осталась бы
 * пустой до следующего хода.
 */
export function getLesson(id: Id): GetLessonResponse {
  return {
    lesson: requireLesson(id),
    exercises: listLessonExercises(id),
    attempts: listLessonAttempts(id),
  };
}

/** Шаг, к которому уже приступили: такой шаг — часть истории урока, а не заготовка. */
function isStarted(step: LessonPlanStep): boolean {
  return step.status !== 'pending';
}

/**
 * Идентификатор текущего шага после пересборки плана.
 *
 * Шаг, на котором стоит урок, мог исчезнуть из плана; тогда идущий урок
 * переставляется на первый непройденный шаг нового плана, а черновик остаётся
 * без текущего шага, как и был.
 */
function nextCurrentStepId(lesson: Lesson, plan: readonly LessonPlanStep[]): Id | null {
  const current = lesson.currentStepId;

  if (current !== null && current !== undefined && plan.some((step) => step.id === current)) {
    return current;
  }

  if (lesson.status !== 'in_progress') {
    return null;
  }

  return plan.find((step) => !isStarted(step))?.id ?? null;
}

/**
 * Пересобирает план урока с учётом пожеланий ученика.
 *
 * `keepCompletedSteps` (по умолчанию `true`) сохраняет всё, к чему уже приступали:
 * пройденные, пропущенные и текущий шаг. Они остаются в плане как есть, а модель
 * планирует только то, что идёт после них, на оставшиеся минуты. Старые шаги,
 * не попавшие в новый план, удаляются, а сохранённые обновляются на месте —
 * дубликатов пересборка не оставляет.
 */
export async function regenerateLessonPlan(
  id: Id,
  input: RegenerateLessonPlanRequest,
  options: LessonPlanServiceOptions = {},
): Promise<RegenerateLessonPlanResponse> {
  const lesson = requireLesson(id);

  if (lesson.status === 'completed') {
    throw conflict('Урок уже завершён: пересобирать его план поздно', {
      details: { reason: 'lesson_completed', lessonId: id },
    });
  }

  const profile = getProfile();
  const keptSteps = (input.keepCompletedSteps ? lesson.plan.filter(isStarted) : []).map(
    (step, index) => ({ ...step, order: index }),
  );
  const minutes = Math.max(
    MIN_LESSON_MINUTES,
    lesson.plannedMinutes - sum(keptSteps.map((step) => step.estimatedMinutes)),
  );
  const room = MAX_PLAN_STEPS - keptSteps.length;

  if (room < 1) {
    throw conflict('В плане урока не осталось места для новых шагов', {
      details: { reason: 'lesson_plan_full', lessonId: id, steps: keptSteps.length },
    });
  }

  const minSteps = Math.min(room, Math.max(1, LESSON_PLAN_MIN_STEPS - keptSteps.length));
  const maxSteps = Math.min(room, Math.max(minSteps, LESSON_PLAN_MAX_STEPS - keptSteps.length));
  const materials = selectMaterials(
    lesson.materialIds,
    extractKeywords([lesson.topic, input.feedback, ...lesson.goals, ...profile.interests]),
    options,
  );
  const context = promptContext(profile, {
    level: lesson.level,
    durationMinutes: lesson.plannedMinutes,
  });
  const reply = await requestPlan(
    context,
    {
      goals: lesson.goals,
      topic: lesson.topic ?? null,
      excerpts: materials.excerpts,
      minSteps,
      maxSteps,
      minutes,
      keptSteps,
      feedback: input.feedback,
    },
    options,
  );
  const plan = [
    ...keptSteps,
    ...toPlanSteps(lesson.id, reply.steps, {
      firstOrder: keptSteps.length,
      minutes,
      chunkIdByRef: materials.chunkIdByRef,
    }),
  ];
  // Название и тема урока не меняются: пересобирается план, а не сам урок.
  const updated: Lesson = {
    ...lesson,
    plan,
    currentStepId: nextCurrentStepId(lesson, plan),
    plannedMinutes: Math.min(
      MAX_LESSON_MINUTES,
      Math.max(lesson.plannedMinutes, sum(plan.map((step) => step.estimatedMinutes))),
    ),
    updatedAt: nowIso(),
  };

  replaceLessonPlan(updated);

  return updated;
}
