/**
 * Типы строк таблиц: ровно то, что возвращает `SELECT *` и что принимает `INSERT`.
 *
 * Поля названы как колонки (snake_case) и типизированы значениями SQLite:
 * TEXT — `string`, INTEGER — `number`, REAL — `number`, NULL — `null` (не `undefined`:
 * better-sqlite3 не умеет связывать `undefined`), логические значения — `SqliteBool`.
 * JSON-колонки объявлены как `string`: разбирать их должен только `mappers.ts`.
 *
 * Перевод строк в доменные типы `@lt/shared` и обратно — в `mappers.ts`.
 */

/** Логическое значение в SQLite. */
export type SqliteBool = 0 | 1;

/** Таблицы схемы в порядке создания (родители раньше детей). */
export const TABLES = [
  'profile',
  'materials',
  'material_chunks',
  'placement_sessions',
  'placement_turns',
  'lessons',
  'lesson_plan_steps',
  'lesson_materials',
  'lesson_messages',
  'exercises',
  'exercise_attempts',
  'vocabulary_items',
  'error_log',
  'level_history',
] as const;

/** Имя таблицы схемы. */
export type TableName = (typeof TABLES)[number];

/** Идентификатор единственной строки профиля: приложение однопользовательское. */
export const PROFILE_ROW_ID = '1';

/** Строка `profile`. Всегда ровно одна, создаётся миграцией. */
export interface ProfileRow {
  id: string;
  learning_language: string;
  interface_language: string;
  explanation_language: string;
  level: string;
  level_confidence: number;
  /** JSON-массив строк, минимум один элемент. */
  goals: string;
  /** JSON-массив строк. */
  interests: string;
  daily_minutes: number;
  /** 0 — профиль ещё заготовка (онбординг не пройден), 1 — подтверждён пользователем. */
  onboarding_completed: SqliteBool;
  placement_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Строка `materials`. */
export interface MaterialRow {
  id: string;
  title: string;
  source_type: string;
  status: string;
  status_message: string | null;
  original_file_name: string | null;
  /** Путь к исходному файлу в `data/uploads/`; в контракт не отдаётся. */
  file_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  language: string;
  level: string | null;
  char_count: number;
  chunk_count: number;
  page_count: number | null;
  /** JSON-массив строк. */
  topics: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

/** Строка `material_chunks`. */
export interface MaterialChunkRow {
  id: string;
  material_id: string;
  order: number;
  content: string;
  char_count: number;
  page: number | null;
  heading: string | null;
  created_at: string;
}

/** Строка `placement_sessions`. */
export interface PlacementSessionRow {
  id: string;
  status: string;
  learning_language: string;
  explanation_language: string;
  max_turns: number;
  /** JSON-объект `PlacementResult` или NULL. */
  result: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Строка `placement_turns`. */
export interface PlacementTurnRow {
  id: string;
  session_id: string;
  order: number;
  question: string;
  question_language: string;
  target_level: string;
  skill: string;
  answer: string | null;
  source: string | null;
  score: number | null;
  feedback: string | null;
  estimated_level: string | null;
  asked_at: string;
  answered_at: string | null;
}

/** Строка `lessons`. Материалы урока — в `lesson_materials`, план — в `lesson_plan_steps`. */
export interface LessonRow {
  id: string;
  title: string;
  status: string;
  learning_language: string;
  explanation_language: string;
  level: string;
  topic: string | null;
  /** JSON-массив строк. */
  goals: string;
  current_step_id: string | null;
  planned_minutes: number;
  /** JSON-объект `LessonSummary` или NULL. */
  summary: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Строка `lesson_plan_steps`. */
export interface LessonPlanStepRow {
  id: string;
  lesson_id: string;
  order: number;
  type: string;
  title: string;
  /** JSON-массив строк. */
  objectives: string;
  /** JSON-массив строк. */
  target_items: string;
  instructions: string;
  estimated_minutes: number;
  status: string;
  /** JSON-массив идентификаторов фрагментов материалов. */
  material_chunk_ids: string;
  /** JSON-массив идентификаторов заданий. */
  exercise_ids: string;
  started_at: string | null;
  completed_at: string | null;
}

/** Строка `lesson_materials`: связь урока с материалом. */
export interface LessonMaterialRow {
  lesson_id: string;
  material_id: string;
  order: number;
  created_at: string;
}

/** Строка `lesson_messages`. A10: `audio_path` всегда NULL. */
export interface LessonMessageRow {
  id: string;
  lesson_id: string;
  step_id: string | null;
  role: string;
  source: string;
  content: string;
  language: string | null;
  /** JSON-массив `Correction`. */
  corrections: string;
  audio_path: string | null;
  duration_ms: number | null;
  created_at: string;
}

/** Строка `exercises`. */
export interface ExerciseRow {
  id: string;
  lesson_id: string;
  step_id: string | null;
  order: number;
  type: string;
  prompt: string;
  instructions: string | null;
  /** JSON-массив строк. */
  options: string;
  expected_answer: string | null;
  /** JSON-массив строк. */
  acceptable_answers: string;
  /** JSON-массив строк. */
  hints: string;
  /** JSON-массив строк. */
  target_items: string;
  level: string | null;
  created_at: string;
}

/** Строка `exercise_attempts`. */
export interface ExerciseAttemptRow {
  id: string;
  exercise_id: string;
  lesson_id: string;
  step_id: string | null;
  answer: string;
  source: string;
  is_correct: SqliteBool;
  score: number;
  /** JSON-массив `Correction`. */
  corrections: string;
  feedback: string;
  duration_ms: number | null;
  created_at: string;
}

/** Строка `vocabulary_items`. */
export interface VocabularyItemRow {
  id: string;
  term: string;
  /** Нормализованная форма `term`; уникальна в паре с `language`. */
  lemma: string;
  translation: string;
  language: string;
  translation_language: string;
  part_of_speech: string | null;
  transcription: string | null;
  example: string | null;
  level: string | null;
  status: string;
  times_seen: number;
  times_correct: number;
  lesson_id: string | null;
  material_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

/** Строка `error_log`. */
export interface ErrorLogRow {
  id: string;
  category: string;
  severity: string;
  original: string;
  corrected: string;
  explanation: string;
  target_item: string | null;
  language: string;
  lesson_id: string | null;
  step_id: string | null;
  exercise_id: string | null;
  message_id: string | null;
  occurred_at: string;
  created_at: string;
}

/** Строка `level_history`. A13: `reason` и `metrics` обязательны. */
export interface LevelHistoryRow {
  id: string;
  from_level: string | null;
  to_level: string;
  direction: string;
  source: string;
  confidence: number;
  reason: string;
  /** JSON-объект `LevelChangeMetrics`. */
  metrics: string;
  changed_at: string;
  created_at: string;
}
