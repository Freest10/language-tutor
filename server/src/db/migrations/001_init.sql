-- Начальная схема базы: профиль, материалы, определение уровня, уроки, задания, прогресс.
--
-- Соглашения:
--   * идентификаторы — TEXT (UUID v4 из `crypto.randomUUID()`);
--   * даты — TEXT в ISO-8601 с зоной (`2026-09-15T10:20:30.000Z`), нормализуются мапперами к UTC,
--     поэтому сравнение и сортировка строк совпадают со сравнением моментов времени;
--   * массивы и объекты — TEXT с JSON (`'[]'` для пустого списка);
--   * логические значения — INTEGER 0/1;
--   * колонка `"order"` — зарезервированное слово SQLite, в запросах всегда в двойных кавычках;
--   * CHECK-ограничения повторяют перечисления из `@lt/shared`: расхождение схемы и контракта
--     падает на вставке, а не на отдаче ответа клиенту.

-- Профиль ученика. Приложение однопользовательское: в таблице ровно одна строка с id = '1',
-- она создаётся этой миграцией. Значения — дефолты из `GET /api/config` (A12: три языка).
-- `onboarding_completed` = 0 означает, что пользователь ещё не подтверждал профиль:
-- строка валидна по `learnerProfileSchema`, но её содержимое — заготовка.
CREATE TABLE IF NOT EXISTS profile (
  id                     TEXT    PRIMARY KEY CHECK (id = '1'),
  learning_language      TEXT    NOT NULL,
  interface_language     TEXT    NOT NULL,
  explanation_language   TEXT    NOT NULL,
  level                  TEXT    NOT NULL CHECK (level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  level_confidence       REAL    NOT NULL DEFAULT 0 CHECK (level_confidence BETWEEN 0 AND 1),
  -- JSON-массив строк; минимум одна цель (`learnerProfileSchema.goals.min(1)`).
  goals                  TEXT    NOT NULL DEFAULT '[]',
  interests              TEXT    NOT NULL DEFAULT '[]',
  daily_minutes          INTEGER NOT NULL DEFAULT 20 CHECK (daily_minutes BETWEEN 5 AND 240),
  onboarding_completed   INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_completed IN (0, 1)),
  -- NULL — определение уровня ни разу не завершено.
  placement_completed_at TEXT,
  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL
);

-- Учебные материалы пользователя (A16: причина неудачи — машиночитаемый статус).
-- `file_path` — исходный загруженный файл в `data/uploads/`; в контракт не отдаётся.
CREATE TABLE IF NOT EXISTS materials (
  id                 TEXT    PRIMARY KEY,
  title              TEXT    NOT NULL,
  source_type        TEXT    NOT NULL CHECK (source_type IN ('pdf', 'txt', 'text')),
  status             TEXT    NOT NULL CHECK (status IN (
                       'pending', 'processing', 'ready',
                       'error_no_text_layer', 'error_unsupported_format',
                       'error_too_large', 'error_extraction_failed')),
  status_message     TEXT,
  original_file_name TEXT,
  file_path          TEXT,
  mime_type          TEXT,
  size_bytes         INTEGER,
  language           TEXT    NOT NULL,
  level              TEXT    CHECK (level IS NULL OR level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  char_count         INTEGER NOT NULL DEFAULT 0,
  chunk_count        INTEGER NOT NULL DEFAULT 0,
  page_count         INTEGER,
  topics             TEXT    NOT NULL DEFAULT '[]',
  summary            TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);

-- Фрагменты материала: удаляются вместе с материалом.
CREATE TABLE IF NOT EXISTS material_chunks (
  id          TEXT    PRIMARY KEY,
  material_id TEXT    NOT NULL REFERENCES materials (id) ON DELETE CASCADE,
  "order"     INTEGER NOT NULL,
  content     TEXT    NOT NULL,
  char_count  INTEGER NOT NULL DEFAULT 0,
  page        INTEGER,
  heading     TEXT,
  created_at  TEXT    NOT NULL
);

-- Сессия определения исходного уровня. `result` — JSON `PlacementResult` или NULL.
CREATE TABLE IF NOT EXISTS placement_sessions (
  id                   TEXT    PRIMARY KEY,
  status               TEXT    NOT NULL CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  learning_language    TEXT    NOT NULL,
  explanation_language TEXT    NOT NULL,
  max_turns            INTEGER NOT NULL CHECK (max_turns BETWEEN 1 AND 30),
  result               TEXT,
  started_at           TEXT    NOT NULL,
  completed_at         TEXT,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
);

-- Вопрос сессии определения уровня вместе с ответом и оценкой.
CREATE TABLE IF NOT EXISTS placement_turns (
  id                TEXT    PRIMARY KEY,
  session_id        TEXT    NOT NULL REFERENCES placement_sessions (id) ON DELETE CASCADE,
  "order"           INTEGER NOT NULL,
  question          TEXT    NOT NULL,
  question_language TEXT    NOT NULL,
  target_level      TEXT    NOT NULL CHECK (target_level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  skill             TEXT    NOT NULL CHECK (skill IN ('grammar', 'vocabulary', 'comprehension', 'speaking')),
  answer            TEXT,
  source            TEXT    CHECK (source IS NULL OR source IN ('voice', 'text')),
  score             REAL    CHECK (score IS NULL OR score BETWEEN 0 AND 1),
  feedback          TEXT,
  estimated_level   TEXT    CHECK (estimated_level IS NULL OR estimated_level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  asked_at          TEXT    NOT NULL,
  answered_at       TEXT
);

-- Урок. Материалы урока хранятся в `lesson_materials`, план — в `lesson_plan_steps`,
-- поэтому в этой таблице их нет. `summary` — JSON `LessonSummary` или NULL.
CREATE TABLE IF NOT EXISTS lessons (
  id                   TEXT    PRIMARY KEY,
  title                TEXT    NOT NULL,
  status               TEXT    NOT NULL CHECK (status IN ('draft', 'in_progress', 'completed')),
  learning_language    TEXT    NOT NULL,
  explanation_language TEXT    NOT NULL,
  level                TEXT    NOT NULL CHECK (level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  topic                TEXT,
  goals                TEXT    NOT NULL DEFAULT '[]',
  current_step_id      TEXT,
  planned_minutes      INTEGER NOT NULL CHECK (planned_minutes BETWEEN 5 AND 240),
  summary              TEXT,
  started_at           TEXT,
  completed_at         TEXT,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
);

-- Шаг плана урока: удаляется вместе с уроком.
-- `material_chunk_ids` и `exercise_ids` — JSON-массивы идентификаторов, задающие порядок внутри шага.
CREATE TABLE IF NOT EXISTS lesson_plan_steps (
  id                 TEXT    PRIMARY KEY,
  lesson_id          TEXT    NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  "order"            INTEGER NOT NULL,
  type               TEXT    NOT NULL CHECK (type IN (
                       'warmup', 'vocabulary', 'grammar', 'reading',
                       'listening', 'speaking', 'exercise', 'wrapup')),
  title              TEXT    NOT NULL,
  objectives         TEXT    NOT NULL DEFAULT '[]',
  target_items       TEXT    NOT NULL DEFAULT '[]',
  instructions       TEXT    NOT NULL,
  estimated_minutes  INTEGER NOT NULL CHECK (estimated_minutes BETWEEN 1 AND 120),
  status             TEXT    NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped')),
  material_chunk_ids TEXT    NOT NULL DEFAULT '[]',
  exercise_ids       TEXT    NOT NULL DEFAULT '[]',
  started_at         TEXT,
  completed_at       TEXT
);

-- Материалы, на которых построен урок: единственный источник `Lesson.materialIds`.
CREATE TABLE IF NOT EXISTS lesson_materials (
  lesson_id   TEXT    NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  material_id TEXT    NOT NULL REFERENCES materials (id) ON DELETE CASCADE,
  "order"     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  PRIMARY KEY (lesson_id, material_id)
);

-- Реплики диалога урока. A10: аудио не сохраняется, `audio_path` зарезервирован и всегда NULL.
CREATE TABLE IF NOT EXISTS lesson_messages (
  id          TEXT    PRIMARY KEY,
  lesson_id   TEXT    NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  step_id     TEXT    REFERENCES lesson_plan_steps (id) ON DELETE SET NULL,
  role        TEXT    NOT NULL CHECK (role IN ('user', 'tutor', 'system')),
  source      TEXT    NOT NULL CHECK (source IN ('voice', 'text')),
  content     TEXT    NOT NULL,
  language    TEXT,
  corrections TEXT    NOT NULL DEFAULT '[]',
  audio_path  TEXT,
  duration_ms INTEGER,
  created_at  TEXT    NOT NULL
);

-- Задания урока: удаляются вместе с уроком.
CREATE TABLE IF NOT EXISTS exercises (
  id                 TEXT    PRIMARY KEY,
  lesson_id          TEXT    NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  step_id            TEXT    REFERENCES lesson_plan_steps (id) ON DELETE SET NULL,
  "order"            INTEGER NOT NULL,
  type               TEXT    NOT NULL CHECK (type IN (
                       'translate', 'fill_blank', 'qa', 'free_speech', 'multiple_choice')),
  prompt             TEXT    NOT NULL,
  instructions       TEXT,
  options            TEXT    NOT NULL DEFAULT '[]',
  expected_answer    TEXT,
  acceptable_answers TEXT    NOT NULL DEFAULT '[]',
  hints              TEXT    NOT NULL DEFAULT '[]',
  target_items       TEXT    NOT NULL DEFAULT '[]',
  level              TEXT    CHECK (level IS NULL OR level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  created_at         TEXT    NOT NULL
);

-- Попытки выполнения задания: удаляются вместе с заданием и вместе с уроком.
CREATE TABLE IF NOT EXISTS exercise_attempts (
  id          TEXT    PRIMARY KEY,
  exercise_id TEXT    NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,
  lesson_id   TEXT    NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  step_id     TEXT    REFERENCES lesson_plan_steps (id) ON DELETE SET NULL,
  answer      TEXT    NOT NULL,
  source      TEXT    NOT NULL CHECK (source IN ('voice', 'text')),
  is_correct  INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
  score       REAL    NOT NULL CHECK (score BETWEEN 0 AND 1),
  corrections TEXT    NOT NULL DEFAULT '[]',
  feedback    TEXT    NOT NULL DEFAULT '',
  duration_ms INTEGER,
  created_at  TEXT    NOT NULL
);

-- Личный словарь. `lemma` — нормализованная форма `term` (нижний регистр, без краёв-пробелов),
-- служит ключом дедупликации в паре с языком; заполняется маппером `vocabularyItemToRow`.
-- Ссылки на урок и материал гасятся в NULL, чтобы история словаря переживала удаление источника.
CREATE TABLE IF NOT EXISTS vocabulary_items (
  id                   TEXT    PRIMARY KEY,
  term                 TEXT    NOT NULL,
  lemma                TEXT    NOT NULL,
  translation          TEXT    NOT NULL,
  language             TEXT    NOT NULL,
  translation_language TEXT    NOT NULL,
  part_of_speech       TEXT,
  transcription        TEXT,
  example              TEXT,
  level                TEXT    CHECK (level IS NULL OR level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  status               TEXT    NOT NULL CHECK (status IN ('new', 'learning', 'known')),
  times_seen           INTEGER NOT NULL DEFAULT 0,
  times_correct        INTEGER NOT NULL DEFAULT 0,
  lesson_id            TEXT    REFERENCES lessons (id) ON DELETE SET NULL,
  material_id          TEXT    REFERENCES materials (id) ON DELETE SET NULL,
  first_seen_at        TEXT    NOT NULL,
  last_seen_at         TEXT    NOT NULL,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
);

-- Журнал ошибок: исправление плюс контекст. `category` ограничена пятью значениями контракта,
-- поэтому `errorsByCategory` всегда собирается по исчерпывающему набору ключей.
-- Ссылки на контекст гасятся в NULL: статистика ошибок переживает удаление урока или задания.
CREATE TABLE IF NOT EXISTS error_log (
  id          TEXT PRIMARY KEY,
  category    TEXT NOT NULL CHECK (category IN (
                'grammar', 'vocabulary', 'pronunciation', 'fluency', 'spelling')),
  severity    TEXT NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor', 'major')),
  original    TEXT NOT NULL,
  corrected   TEXT NOT NULL DEFAULT '',
  explanation TEXT NOT NULL,
  target_item TEXT,
  language    TEXT NOT NULL,
  lesson_id   TEXT REFERENCES lessons (id) ON DELETE SET NULL,
  step_id     TEXT REFERENCES lesson_plan_steps (id) ON DELETE SET NULL,
  exercise_id TEXT REFERENCES exercises (id) ON DELETE SET NULL,
  message_id  TEXT REFERENCES lesson_messages (id) ON DELETE SET NULL,
  occurred_at TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- История уровня (A13). `reason` и `metrics` обязательны: решение о смене уровня
-- всегда сопровождается и человекочитаемым обоснованием, и метрикой, по которой оно принято.
-- `metrics` — JSON `LevelChangeMetrics`.
CREATE TABLE IF NOT EXISTS level_history (
  id         TEXT PRIMARY KEY,
  from_level TEXT CHECK (from_level IS NULL OR from_level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  to_level   TEXT NOT NULL CHECK (to_level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
  direction  TEXT NOT NULL CHECK (direction IN ('initial', 'up', 'down')),
  source     TEXT NOT NULL CHECK (source IN ('placement', 'progress', 'manual')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reason     TEXT NOT NULL,
  metrics    TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Индексы: выборки по родителю, сортировки списков и дедупликация словаря.
CREATE INDEX IF NOT EXISTS idx_materials_status ON materials (status, created_at);
CREATE INDEX IF NOT EXISTS idx_material_chunks_material_id ON material_chunks (material_id, "order");
CREATE INDEX IF NOT EXISTS idx_placement_turns_session_id ON placement_turns (session_id, "order");
CREATE INDEX IF NOT EXISTS idx_lessons_status ON lessons (status, created_at);
CREATE INDEX IF NOT EXISTS idx_lesson_plan_steps_lesson_id_order ON lesson_plan_steps (lesson_id, "order");
CREATE INDEX IF NOT EXISTS idx_lesson_materials_material_id ON lesson_materials (material_id);
CREATE INDEX IF NOT EXISTS idx_lesson_messages_lesson_id ON lesson_messages (lesson_id, created_at);
CREATE INDEX IF NOT EXISTS idx_lesson_messages_step_id ON lesson_messages (step_id);
CREATE INDEX IF NOT EXISTS idx_exercises_lesson_id ON exercises (lesson_id, "order");
CREATE INDEX IF NOT EXISTS idx_exercises_step_id ON exercises (step_id);
CREATE INDEX IF NOT EXISTS idx_exercise_attempts_exercise_id ON exercise_attempts (exercise_id);
CREATE INDEX IF NOT EXISTS idx_exercise_attempts_lesson_id ON exercise_attempts (lesson_id, created_at);
CREATE INDEX IF NOT EXISTS idx_exercise_attempts_step_id ON exercise_attempts (step_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vocabulary_items_language_lemma ON vocabulary_items (language, lemma);
CREATE INDEX IF NOT EXISTS idx_vocabulary_items_status ON vocabulary_items (status, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_vocabulary_items_lesson_id ON vocabulary_items (lesson_id);
CREATE INDEX IF NOT EXISTS idx_vocabulary_items_material_id ON vocabulary_items (material_id);
CREATE INDEX IF NOT EXISTS idx_error_log_lesson_id ON error_log (lesson_id);
CREATE INDEX IF NOT EXISTS idx_error_log_category ON error_log (category, occurred_at);
CREATE INDEX IF NOT EXISTS idx_error_log_step_id ON error_log (step_id);
CREATE INDEX IF NOT EXISTS idx_error_log_exercise_id ON error_log (exercise_id);
CREATE INDEX IF NOT EXISTS idx_error_log_message_id ON error_log (message_id);
CREATE INDEX IF NOT EXISTS idx_level_history_changed_at ON level_history (changed_at);

-- Профиль-заготовка: приложение однопользовательское, строка должна существовать всегда,
-- иначе `GET /api/profile` нечего отдавать. Значения совпадают с дефолтами `GET /api/config`,
-- цель-плейсхолдер нужна, чтобы строка проходила `learnerProfileSchema` (goals.min(1)).
INSERT OR IGNORE INTO profile (
  id, learning_language, interface_language, explanation_language,
  level, level_confidence, goals, interests, daily_minutes,
  onboarding_completed, placement_completed_at, created_at, updated_at
) VALUES (
  '1', 'en', 'ru', 'ru',
  'A1', 0, '["Научиться общаться на повседневные темы"]', '[]', 20,
  0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
