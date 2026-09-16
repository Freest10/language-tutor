/**
 * Двусторонние мапперы «строка таблицы ↔ доменный тип `@lt/shared`».
 *
 * Весь `JSON.parse`/`JSON.stringify` и вся нормализация дат живут здесь: обработчики
 * и сервисы работают только с доменными типами и не знают про формат хранения.
 *
 * Правила:
 * - даты при записи приводятся к UTC (`2026-09-15T10:20:30.000Z`), поэтому лексикографическая
 *   сортировка колонок с датами совпадает с хронологической;
 * - `undefined` доменных полей превращается в `NULL`, обратно всегда приходит `null`;
 * - коллекции хранятся JSON-массивами и никогда не бывают `NULL` (пустой список — `'[]'`);
 * - значения перечислений проверяются CHECK-ограничениями схемы, поэтому при чтении
 *   выполняется приведение типа без повторной валидации.
 */
import {
  ERROR_CATEGORIES,
  type CefrLevel,
  type Correction,
  type ErrorCategory,
  type ErrorLogEntry,
  type ErrorSeverity,
  type Exercise,
  type ExerciseAttempt,
  type ExerciseType,
  type Id,
  type LearnerProfile,
  type Lesson,
  type LessonMessage,
  type LessonMessageRole,
  type LessonPlanStep,
  type LessonStatus,
  type LessonStepStatus,
  type LessonStepType,
  type LessonSummary,
  type LevelChangeDirection,
  type LevelChangeMetrics,
  type LevelChangeSource,
  type LevelHistoryEntry,
  type Material,
  type MaterialChunk,
  type MaterialSourceType,
  type MaterialStatus,
  type MessageSource,
  type PlacementResult,
  type PlacementSession,
  type PlacementSessionStatus,
  type PlacementSkill,
  type PlacementTurn,
  type VocabularyItem,
  type VocabularyStatus,
} from '@lt/shared';

import {
  type ErrorLogRow,
  type ExerciseAttemptRow,
  type ExerciseRow,
  type LessonMaterialRow,
  type LessonMessageRow,
  type LessonPlanStepRow,
  type LessonRow,
  type LevelHistoryRow,
  type MaterialChunkRow,
  type MaterialRow,
  type PlacementSessionRow,
  type PlacementTurnRow,
  type ProfileRow,
  type SqliteBool,
  type VocabularyItemRow,
} from './rows.js';

// ---------------------------------------------------------------------------
// Общие помощники
// ---------------------------------------------------------------------------

/** Текущий момент в формате хранения. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Приводит момент времени к каноничному ISO-8601 в UTC: `2026-09-15T10:20:30.000Z`. */
export function toIsoDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Ожидался момент времени в ISO-8601, получено: ${String(value)}`);
  }

  return date.toISOString();
}

/** Календарная дата `YYYY-MM-DD` в UTC — формат `DailyActivity.date`. */
export function toIsoDate(value: string | number | Date): string {
  return toIsoDateTime(value).slice(0, 10);
}

function toNullableIsoDateTime(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : toIsoDateTime(value);
}

/** Логическое значение в виде, пригодном для связывания с SQLite. */
export function toSqliteBool(value: boolean): SqliteBool {
  return value ? 1 : 0;
}

/** Логическое значение из колонки INTEGER. */
export function fromSqliteBool(value: number): boolean {
  return value !== 0;
}

function toNullable<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value;
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new Error(`Колонка ${field}: не удалось разобрать JSON`, { cause });
  }
}

function parseJsonArray<T>(value: string, field: string): T[] {
  const parsed = parseJson(value, field);

  if (!Array.isArray(parsed)) {
    throw new Error(`Колонка ${field}: ожидался JSON-массив`);
  }

  return parsed as T[];
}

function parseJsonObject<T>(value: string, field: string): T {
  const parsed = parseJson(value, field);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Колонка ${field}: ожидался JSON-объект`);
  }

  return parsed as T;
}

function parseNullableJsonObject<T>(value: string | null, field: string): T | null {
  return value === null ? null : parseJsonObject<T>(value, field);
}

/** Нормализованная форма слова: ключ дедупликации словаря в паре с языком. */
export function toVocabularyLemma(term: string): string {
  return term.trim().toLowerCase();
}

/** Нулевые счётчики по всем категориям ошибок: `errorsByCategory` всегда исчерпывающий. */
export function emptyErrorCountsByCategory(): Record<ErrorCategory, number> {
  return Object.fromEntries(ERROR_CATEGORIES.map((category) => [category, 0])) as Record<
    ErrorCategory,
    number
  >;
}

// ---------------------------------------------------------------------------
// Профиль
// ---------------------------------------------------------------------------

/** Профиль из строки таблицы. */
export function rowToLearnerProfile(row: ProfileRow): LearnerProfile {
  return {
    id: row.id,
    learningLanguage: row.learning_language,
    interfaceLanguage: row.interface_language,
    explanationLanguage: row.explanation_language,
    level: row.level as CefrLevel,
    levelConfidence: row.level_confidence,
    goals: parseJsonArray<string>(row.goals, 'profile.goals'),
    interests: parseJsonArray<string>(row.interests, 'profile.interests'),
    dailyMinutes: row.daily_minutes,
    placementCompletedAt: row.placement_completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Признак пройденного онбординга: доменный профиль его не содержит, он живёт только в базе. */
export function isOnboardingCompleted(row: ProfileRow): boolean {
  return fromSqliteBool(row.onboarding_completed);
}

/**
 * Строка профиля. `onboardingCompleted` по умолчанию выводится из факта завершённого
 * определения уровня; при обновлении профиля вручную его следует передавать явно.
 */
export function learnerProfileToRow(
  profile: LearnerProfile,
  options: { onboardingCompleted?: boolean } = {},
): ProfileRow {
  const placementCompletedAt = toNullableIsoDateTime(profile.placementCompletedAt);

  return {
    id: profile.id,
    learning_language: profile.learningLanguage,
    interface_language: profile.interfaceLanguage,
    explanation_language: profile.explanationLanguage,
    level: profile.level,
    level_confidence: profile.levelConfidence,
    goals: toJson(profile.goals),
    interests: toJson(profile.interests),
    daily_minutes: profile.dailyMinutes,
    onboarding_completed: toSqliteBool(
      options.onboardingCompleted ?? placementCompletedAt !== null,
    ),
    placement_completed_at: placementCompletedAt,
    created_at: toIsoDateTime(profile.createdAt),
    updated_at: toIsoDateTime(profile.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Материалы
// ---------------------------------------------------------------------------

/** Счётчики материала, которых нет в его строке: считаются по другим таблицам. */
export interface MaterialCounters {
  /**
   * Сколько фрагментов материала уже отработано на уроках (`coveredChunkCount`).
   * Считается по шагам планов, поэтому передаётся снаружи; по умолчанию 0 —
   * «ничего не пройдено».
   */
  coveredChunkCount?: number;
}

/** Материал из строки таблицы и счётчиков по связанным таблицам. */
export function rowToMaterial(row: MaterialRow, counters: MaterialCounters = {}): Material {
  return {
    id: row.id,
    title: row.title,
    sourceType: row.source_type as MaterialSourceType,
    status: row.status as MaterialStatus,
    statusMessage: row.status_message,
    originalFileName: row.original_file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    language: row.language,
    level: row.level as CefrLevel | null,
    charCount: row.char_count,
    chunkCount: row.chunk_count,
    coveredChunkCount: counters.coveredChunkCount ?? 0,
    pageCount: row.page_count,
    topics: parseJsonArray<string>(row.topics, 'materials.topics'),
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Строка материала. `filePath` в контракт не входит и передаётся отдельно. */
export function materialToRow(
  material: Material,
  options: { filePath?: string | null } = {},
): MaterialRow {
  return {
    id: material.id,
    title: material.title,
    source_type: material.sourceType,
    status: material.status,
    status_message: toNullable(material.statusMessage),
    original_file_name: toNullable(material.originalFileName),
    file_path: toNullable(options.filePath),
    mime_type: toNullable(material.mimeType),
    size_bytes: toNullable(material.sizeBytes),
    language: material.language,
    level: toNullable(material.level),
    char_count: material.charCount,
    chunk_count: material.chunkCount,
    page_count: toNullable(material.pageCount),
    topics: toJson(material.topics),
    summary: toNullable(material.summary),
    created_at: toIsoDateTime(material.createdAt),
    updated_at: toIsoDateTime(material.updatedAt),
  };
}

/** Фрагмент материала из строки таблицы. */
export function rowToMaterialChunk(row: MaterialChunkRow): MaterialChunk {
  return {
    id: row.id,
    materialId: row.material_id,
    order: row.order,
    content: row.content,
    charCount: row.char_count,
    page: row.page,
    heading: row.heading,
    createdAt: row.created_at,
  };
}

/** Строка фрагмента материала. */
export function materialChunkToRow(chunk: MaterialChunk): MaterialChunkRow {
  return {
    id: chunk.id,
    material_id: chunk.materialId,
    order: chunk.order,
    content: chunk.content,
    char_count: chunk.charCount,
    page: toNullable(chunk.page),
    heading: toNullable(chunk.heading),
    created_at: toIsoDateTime(chunk.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Определение уровня
// ---------------------------------------------------------------------------

/** Вопрос определения уровня из строки таблицы. */
export function rowToPlacementTurn(row: PlacementTurnRow): PlacementTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    order: row.order,
    question: row.question,
    questionLanguage: row.question_language,
    targetLevel: row.target_level as CefrLevel,
    skill: row.skill as PlacementSkill,
    answer: row.answer,
    source: row.source as MessageSource | null,
    score: row.score,
    feedback: row.feedback,
    estimatedLevel: row.estimated_level as CefrLevel | null,
    askedAt: row.asked_at,
    answeredAt: row.answered_at,
  };
}

/** Строка вопроса определения уровня. */
export function placementTurnToRow(turn: PlacementTurn): PlacementTurnRow {
  return {
    id: turn.id,
    session_id: turn.sessionId,
    order: turn.order,
    question: turn.question,
    question_language: turn.questionLanguage,
    target_level: turn.targetLevel,
    skill: turn.skill,
    answer: toNullable(turn.answer),
    source: toNullable(turn.source),
    score: toNullable(turn.score),
    feedback: toNullable(turn.feedback),
    estimated_level: toNullable(turn.estimatedLevel),
    asked_at: toIsoDateTime(turn.askedAt),
    answered_at: toNullableIsoDateTime(turn.answeredAt),
  };
}

/** Сессия определения уровня из строки таблицы и её вопросов (`placement_turns`). */
export function rowToPlacementSession(
  row: PlacementSessionRow,
  turns: PlacementTurn[] = [],
): PlacementSession {
  return {
    id: row.id,
    status: row.status as PlacementSessionStatus,
    learningLanguage: row.learning_language,
    explanationLanguage: row.explanation_language,
    maxTurns: row.max_turns,
    turns,
    result: parseNullableJsonObject<PlacementResult>(row.result, 'placement_sessions.result'),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Строка сессии определения уровня; вопросы сохраняются отдельно. */
export function placementSessionToRow(session: PlacementSession): PlacementSessionRow {
  return {
    id: session.id,
    status: session.status,
    learning_language: session.learningLanguage,
    explanation_language: session.explanationLanguage,
    max_turns: session.maxTurns,
    result: session.result === null || session.result === undefined ? null : toJson(session.result),
    started_at: toIsoDateTime(session.startedAt),
    completed_at: toNullableIsoDateTime(session.completedAt),
    created_at: toIsoDateTime(session.createdAt),
    updated_at: toIsoDateTime(session.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Уроки
// ---------------------------------------------------------------------------

/** Шаг плана урока из строки таблицы. */
export function rowToLessonPlanStep(row: LessonPlanStepRow): LessonPlanStep {
  return {
    id: row.id,
    lessonId: row.lesson_id,
    order: row.order,
    type: row.type as LessonStepType,
    title: row.title,
    objectives: parseJsonArray<string>(row.objectives, 'lesson_plan_steps.objectives'),
    targetItems: parseJsonArray<string>(row.target_items, 'lesson_plan_steps.target_items'),
    instructions: row.instructions,
    estimatedMinutes: row.estimated_minutes,
    status: row.status as LessonStepStatus,
    materialChunkIds: parseJsonArray<Id>(
      row.material_chunk_ids,
      'lesson_plan_steps.material_chunk_ids',
    ),
    exerciseIds: parseJsonArray<Id>(row.exercise_ids, 'lesson_plan_steps.exercise_ids'),
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/** Строка шага плана урока. */
export function lessonPlanStepToRow(step: LessonPlanStep): LessonPlanStepRow {
  return {
    id: step.id,
    lesson_id: step.lessonId,
    order: step.order,
    type: step.type,
    title: step.title,
    objectives: toJson(step.objectives),
    target_items: toJson(step.targetItems),
    instructions: step.instructions,
    estimated_minutes: step.estimatedMinutes,
    status: step.status,
    material_chunk_ids: toJson(step.materialChunkIds),
    exercise_ids: toJson(step.exerciseIds),
    started_at: toNullableIsoDateTime(step.startedAt),
    completed_at: toNullableIsoDateTime(step.completedAt),
  };
}

/** Связи урока, которые хранятся отдельными таблицами. */
export interface LessonRelations {
  /** Материалы урока из `lesson_materials`, в порядке колонки `"order"`. */
  materialIds: Id[];
  /** Шаги плана из `lesson_plan_steps`, в порядке колонки `"order"`. */
  plan: LessonPlanStep[];
}

/** Урок из строки таблицы и связанных с ним материалов и шагов плана. */
export function rowToLesson(row: LessonRow, relations: LessonRelations): Lesson {
  return {
    id: row.id,
    title: row.title,
    status: row.status as LessonStatus,
    learningLanguage: row.learning_language,
    explanationLanguage: row.explanation_language,
    level: row.level as CefrLevel,
    topic: row.topic,
    goals: parseJsonArray<string>(row.goals, 'lessons.goals'),
    materialIds: relations.materialIds,
    plan: relations.plan,
    currentStepId: row.current_step_id,
    plannedMinutes: row.planned_minutes,
    summary: parseNullableJsonObject<LessonSummary>(row.summary, 'lessons.summary'),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Строка урока; материалы и шаги плана сохраняются отдельно. */
export function lessonToRow(lesson: Lesson): LessonRow {
  return {
    id: lesson.id,
    title: lesson.title,
    status: lesson.status,
    learning_language: lesson.learningLanguage,
    explanation_language: lesson.explanationLanguage,
    level: lesson.level,
    topic: toNullable(lesson.topic),
    goals: toJson(lesson.goals),
    current_step_id: toNullable(lesson.currentStepId),
    planned_minutes: lesson.plannedMinutes,
    summary:
      lesson.summary === null || lesson.summary === undefined ? null : toJson(lesson.summary),
    started_at: toNullableIsoDateTime(lesson.startedAt),
    completed_at: toNullableIsoDateTime(lesson.completedAt),
    created_at: toIsoDateTime(lesson.createdAt),
    updated_at: toIsoDateTime(lesson.updatedAt),
  };
}

/** Строки связи урока с материалами: порядок задаётся порядком в массиве. */
export function lessonMaterialsToRows(
  lessonId: Id,
  materialIds: Id[],
  createdAt: string = nowIso(),
): LessonMaterialRow[] {
  return materialIds.map((materialId, index) => ({
    lesson_id: lessonId,
    material_id: materialId,
    order: index,
    created_at: toIsoDateTime(createdAt),
  }));
}

/** Идентификаторы материалов урока в порядке колонки `"order"`. */
export function rowsToLessonMaterialIds(rows: LessonMaterialRow[]): Id[] {
  return [...rows].sort((left, right) => left.order - right.order).map((row) => row.material_id);
}

/** Реплика урока из строки таблицы. */
export function rowToLessonMessage(row: LessonMessageRow): LessonMessage {
  return {
    id: row.id,
    lessonId: row.lesson_id,
    stepId: row.step_id,
    role: row.role as LessonMessageRole,
    source: row.source as MessageSource,
    content: row.content,
    language: row.language,
    corrections: parseJsonArray<Correction>(row.corrections, 'lesson_messages.corrections'),
    audioPath: row.audio_path,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

/** Строка реплики урока. A10: аудио не сохраняется, `audio_path` остаётся NULL. */
export function lessonMessageToRow(message: LessonMessage): LessonMessageRow {
  return {
    id: message.id,
    lesson_id: message.lessonId,
    step_id: toNullable(message.stepId),
    role: message.role,
    source: message.source,
    content: message.content,
    language: toNullable(message.language),
    corrections: toJson(message.corrections),
    audio_path: toNullable(message.audioPath),
    duration_ms: toNullable(message.durationMs),
    created_at: toIsoDateTime(message.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Задания
// ---------------------------------------------------------------------------

/** Задание из строки таблицы. */
export function rowToExercise(row: ExerciseRow): Exercise {
  return {
    id: row.id,
    lessonId: row.lesson_id,
    stepId: row.step_id,
    order: row.order,
    type: row.type as ExerciseType,
    prompt: row.prompt,
    instructions: row.instructions,
    options: parseJsonArray<string>(row.options, 'exercises.options'),
    expectedAnswer: row.expected_answer,
    acceptableAnswers: parseJsonArray<string>(
      row.acceptable_answers,
      'exercises.acceptable_answers',
    ),
    hints: parseJsonArray<string>(row.hints, 'exercises.hints'),
    targetItems: parseJsonArray<string>(row.target_items, 'exercises.target_items'),
    level: row.level as CefrLevel | null,
    createdAt: row.created_at,
  };
}

/** Строка задания. */
export function exerciseToRow(exercise: Exercise): ExerciseRow {
  return {
    id: exercise.id,
    lesson_id: exercise.lessonId,
    step_id: toNullable(exercise.stepId),
    order: exercise.order,
    type: exercise.type,
    prompt: exercise.prompt,
    instructions: toNullable(exercise.instructions),
    options: toJson(exercise.options),
    expected_answer: toNullable(exercise.expectedAnswer),
    acceptable_answers: toJson(exercise.acceptableAnswers),
    hints: toJson(exercise.hints),
    target_items: toJson(exercise.targetItems),
    level: toNullable(exercise.level),
    created_at: toIsoDateTime(exercise.createdAt),
  };
}

/** Попытка выполнения задания из строки таблицы. */
export function rowToExerciseAttempt(row: ExerciseAttemptRow): ExerciseAttempt {
  return {
    id: row.id,
    exerciseId: row.exercise_id,
    lessonId: row.lesson_id,
    stepId: row.step_id,
    answer: row.answer,
    source: row.source as MessageSource,
    isCorrect: fromSqliteBool(row.is_correct),
    score: row.score,
    corrections: parseJsonArray<Correction>(row.corrections, 'exercise_attempts.corrections'),
    feedback: row.feedback,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

/** Строка попытки выполнения задания. */
export function exerciseAttemptToRow(attempt: ExerciseAttempt): ExerciseAttemptRow {
  return {
    id: attempt.id,
    exercise_id: attempt.exerciseId,
    lesson_id: attempt.lessonId,
    step_id: toNullable(attempt.stepId),
    answer: attempt.answer,
    source: attempt.source,
    is_correct: toSqliteBool(attempt.isCorrect),
    score: attempt.score,
    corrections: toJson(attempt.corrections),
    feedback: attempt.feedback,
    duration_ms: toNullable(attempt.durationMs),
    created_at: toIsoDateTime(attempt.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Прогресс
// ---------------------------------------------------------------------------

/** Слово личного словаря из строки таблицы. */
export function rowToVocabularyItem(row: VocabularyItemRow): VocabularyItem {
  return {
    id: row.id,
    term: row.term,
    translation: row.translation,
    language: row.language,
    translationLanguage: row.translation_language,
    partOfSpeech: row.part_of_speech,
    transcription: row.transcription,
    example: row.example,
    level: row.level as CefrLevel | null,
    status: row.status as VocabularyStatus,
    timesSeen: row.times_seen,
    timesCorrect: row.times_correct,
    lessonId: row.lesson_id,
    materialId: row.material_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Строка словаря; `lemma` считается из `term` и участвует в уникальном индексе. */
export function vocabularyItemToRow(item: VocabularyItem): VocabularyItemRow {
  return {
    id: item.id,
    term: item.term,
    lemma: toVocabularyLemma(item.term),
    translation: item.translation,
    language: item.language,
    translation_language: item.translationLanguage,
    part_of_speech: toNullable(item.partOfSpeech),
    transcription: toNullable(item.transcription),
    example: toNullable(item.example),
    level: toNullable(item.level),
    status: item.status,
    times_seen: item.timesSeen,
    times_correct: item.timesCorrect,
    lesson_id: toNullable(item.lessonId),
    material_id: toNullable(item.materialId),
    first_seen_at: toIsoDateTime(item.firstSeenAt),
    last_seen_at: toIsoDateTime(item.lastSeenAt),
    created_at: toIsoDateTime(item.createdAt),
    updated_at: toIsoDateTime(item.updatedAt),
  };
}

/** Запись журнала ошибок из строки таблицы. */
export function rowToErrorLogEntry(row: ErrorLogRow): ErrorLogEntry {
  return {
    id: row.id,
    category: row.category as ErrorCategory,
    severity: row.severity as ErrorSeverity,
    original: row.original,
    corrected: row.corrected,
    explanation: row.explanation,
    targetItem: row.target_item,
    language: row.language,
    lessonId: row.lesson_id,
    stepId: row.step_id,
    exerciseId: row.exercise_id,
    messageId: row.message_id,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

/** Строка журнала ошибок. */
export function errorLogEntryToRow(entry: ErrorLogEntry): ErrorLogRow {
  return {
    id: entry.id,
    category: entry.category,
    severity: entry.severity,
    original: entry.original,
    corrected: entry.corrected,
    explanation: entry.explanation,
    target_item: toNullable(entry.targetItem),
    language: entry.language,
    lesson_id: toNullable(entry.lessonId),
    step_id: toNullable(entry.stepId),
    exercise_id: toNullable(entry.exerciseId),
    message_id: toNullable(entry.messageId),
    occurred_at: toIsoDateTime(entry.occurredAt),
    created_at: toIsoDateTime(entry.createdAt),
  };
}

/** Запись истории уровня из строки таблицы (A13: `reason` и `metrics` всегда заполнены). */
export function rowToLevelHistoryEntry(row: LevelHistoryRow): LevelHistoryEntry {
  return {
    id: row.id,
    fromLevel: row.from_level as CefrLevel | null,
    toLevel: row.to_level as CefrLevel,
    direction: row.direction as LevelChangeDirection,
    source: row.source as LevelChangeSource,
    confidence: row.confidence,
    reason: row.reason,
    metrics: parseJsonObject<LevelChangeMetrics>(row.metrics, 'level_history.metrics'),
    changedAt: row.changed_at,
    createdAt: row.created_at,
  };
}

/** Строка истории уровня. */
export function levelHistoryEntryToRow(entry: LevelHistoryEntry): LevelHistoryRow {
  return {
    id: entry.id,
    from_level: toNullable(entry.fromLevel),
    to_level: entry.toLevel,
    direction: entry.direction,
    source: entry.source,
    confidence: entry.confidence,
    reason: entry.reason,
    metrics: toJson(entry.metrics),
    changed_at: toIsoDateTime(entry.changedAt),
    created_at: toIsoDateTime(entry.createdAt),
  };
}
