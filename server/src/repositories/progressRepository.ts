/**
 * Доступ к данным прогресса: личный словарь (`vocabulary_items`), журнал ошибок
 * (`error_log`), история уровня (`level_history`) и агрегаты занятий по таблицам
 * `lessons` и `exercise_attempts`.
 *
 * Слой знает только про строки таблиц и SQL: перевод в доменные типы `@lt/shared`
 * делают мапперы `db/mappers.ts`, а правила (когда слово считается выученным и когда
 * пересчитывается уровень) — `services/progressService.ts`.
 *
 * Запись истории уровня идёт через `profileRepository.saveProfileRow()`: профиль и
 * обоснование изменения сохраняются одной транзакцией, поэтому здесь история
 * только читается.
 *
 * Даты хранятся каноничным ISO-8601 в UTC, поэтому `substr(created_at, 1, 10)`
 * даёт ту же календарную дату, что и `toIsoDate()`, а сравнение строк совпадает
 * с хронологическим порядком.
 */
import type {
  DailyActivity,
  ErrorCategory,
  ErrorLogEntry,
  Id,
  LanguageCode,
  LevelHistoryEntry,
  ListErrorsQuery,
  ListLevelHistoryQuery,
  ListVocabularyQuery,
  Paginated,
  SortOrder,
  VocabularyItem,
  VocabularySortField,
  VocabularyStats,
  VocabularyStatus,
} from '@lt/shared';

import { getDb } from '../db/connection.js';
import {
  emptyErrorCountsByCategory,
  errorLogEntryToRow,
  rowToErrorLogEntry,
  rowToLevelHistoryEntry,
  rowToVocabularyItem,
  toVocabularyLemma,
  vocabularyItemToRow,
} from '../db/mappers.js';
import type { ErrorLogRow, LevelHistoryRow, VocabularyItemRow } from '../db/rows.js';

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/** Колонки `vocabulary_items` в порядке, в котором их отдаёт `vocabularyItemToRow()`. */
const VOCABULARY_COLUMNS = [
  'id',
  'term',
  'lemma',
  'translation',
  'language',
  'translation_language',
  'part_of_speech',
  'transcription',
  'example',
  'level',
  'status',
  'times_seen',
  'times_correct',
  'lesson_id',
  'material_id',
  'first_seen_at',
  'last_seen_at',
  'created_at',
  'updated_at',
] as const;

const INSERT_VOCABULARY_SQL = `INSERT INTO vocabulary_items (${VOCABULARY_COLUMNS.join(', ')})
  VALUES (${VOCABULARY_COLUMNS.map((column) => `@${column}`).join(', ')})`;

const UPDATE_VOCABULARY_SQL = `UPDATE vocabulary_items SET ${VOCABULARY_COLUMNS.filter(
  (column) => column !== 'id',
)
  .map((column) => `${column} = @${column}`)
  .join(', ')} WHERE id = @id`;

/** Колонки `error_log` в порядке, в котором их отдаёт `errorLogEntryToRow()`. */
const ERROR_LOG_COLUMNS = [
  'id',
  'category',
  'severity',
  'original',
  'corrected',
  'explanation',
  'target_item',
  'language',
  'lesson_id',
  'step_id',
  'exercise_id',
  'message_id',
  'occurred_at',
  'created_at',
] as const;

const INSERT_ERROR_LOG_SQL = `INSERT INTO error_log (${ERROR_LOG_COLUMNS.join(', ')})
  VALUES (${ERROR_LOG_COLUMNS.map((column) => `@${column}`).join(', ')})`;

const SELECT_LEVEL_HISTORY_COLUMNS = `id, from_level, to_level, direction, source,
         confidence, reason, metrics, changed_at, created_at`;

/** Колонка сортировки словаря для каждого поля контракта. */
const VOCABULARY_SORT_COLUMNS: Record<VocabularySortField, string> = {
  recent: 'last_seen_at',
  alphabetical: 'lemma',
  timesSeen: 'times_seen',
};

// ---------------------------------------------------------------------------
// Общие помощники
// ---------------------------------------------------------------------------

/** Значение параметра запроса: SQLite не умеет связывать `undefined`. */
type SqlParameter = string | number;

/** Направление сортировки как ключевое слово SQL (значение приходит из enum контракта). */
function toSqlOrder(order: SortOrder): 'ASC' | 'DESC' {
  return order === 'asc' ? 'ASC' : 'DESC';
}

/** Экранирование для `LIKE`: сам шаблон собирается здесь, а не приходит от клиента. */
function toLikePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** Пустая страница: избавляет вызывающий код от ветвления на `total === 0`. */
function emptyPage<Item>(limit: number, offset: number): Paginated<Item> {
  return { items: [], total: 0, limit, offset, hasMore: false };
}

/** Собирает страницу ответа по элементам и общему числу записей. */
function toPage<Item>(
  items: Item[],
  total: number,
  limit: number,
  offset: number,
): Paginated<Item> {
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

/** Часть `WHERE` вместе со значениями подстановок. */
interface SqlFilter {
  where: string;
  parameters: SqlParameter[];
}

/** Собирает `WHERE` из условий; пустой список условий даёт пустую строку. */
function toWhere(conditions: readonly string[], parameters: SqlParameter[]): SqlFilter {
  return {
    where: conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`,
    parameters,
  };
}

/** Целое неотрицательное из агрегата SQL: `NULL` и дробные значения приводятся к `0`. */
function toCount(value: number | null): number {
  return value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.round(value));
}

// ---------------------------------------------------------------------------
// Личный словарь
// ---------------------------------------------------------------------------

/** Слово словаря по языку и форме; сравнение идёт по лемме (`UNIQUE (language, lemma)`). */
export function findVocabularyItem(
  language: LanguageCode,
  term: string,
): VocabularyItem | undefined {
  const row = getDb()
    .prepare('SELECT * FROM vocabulary_items WHERE language = ? AND lemma = ?')
    .get(language, toVocabularyLemma(term)) as VocabularyItemRow | undefined;

  return row === undefined ? undefined : rowToVocabularyItem(row);
}

/**
 * Сохраняет слова одной транзакцией: существующая строка обновляется по `id`,
 * новая вставляется. Дедупликацию по `(language, lemma)` обеспечивает вызывающий
 * код — он же решает, как сливать счётчики.
 */
export function saveVocabularyItems(items: readonly VocabularyItem[]): void {
  if (items.length === 0) {
    return;
  }

  const db = getDb();
  const rows = items.map((item) => vocabularyItemToRow(item));

  const save = db.transaction((): void => {
    const update = db.prepare(UPDATE_VOCABULARY_SQL);
    const insert = db.prepare(INSERT_VOCABULARY_SQL);

    for (const row of rows) {
      if (update.run(row).changes === 0) {
        insert.run(row);
      }
    }
  });

  save();
}

/** Страница личного словаря; фильтры применяются одновременно (логическое И). */
export function listVocabularyItems(query: ListVocabularyQuery): Paginated<VocabularyItem> {
  const { limit, offset } = query;
  const conditions: string[] = [];
  const parameters: SqlParameter[] = [];

  if (query.status !== undefined) {
    conditions.push('status = ?');
    parameters.push(query.status);
  }
  if (query.language !== undefined) {
    conditions.push('language = ?');
    parameters.push(query.language);
  }
  if (query.lessonId !== undefined) {
    conditions.push('lesson_id = ?');
    parameters.push(query.lessonId);
  }
  if (query.search !== undefined) {
    // Ученик ищет слово и по изучаемой форме, и по переводу.
    conditions.push(`(lemma LIKE ? ESCAPE '\\' OR translation LIKE ? ESCAPE '\\')`);
    parameters.push(toLikePattern(query.search.toLowerCase()), toLikePattern(query.search));
  }

  const { where } = toWhere(conditions, parameters);
  const db = getDb();
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM vocabulary_items${where}`)
    .get(...parameters) as { total: number };

  if (total === 0) {
    return emptyPage<VocabularyItem>(limit, offset);
  }

  const direction = toSqlOrder(query.order);
  const column = VOCABULARY_SORT_COLUMNS[query.sort];
  const rows = db
    .prepare(
      `SELECT * FROM vocabulary_items${where}
         ORDER BY ${column} ${direction}, id ${direction} LIMIT ? OFFSET ?`,
    )
    .all(...parameters, limit, offset) as VocabularyItemRow[];

  return toPage(rows.map(rowToVocabularyItem), total, limit, offset);
}

/** Счётчики словаря по стадиям освоения; учитываются слова всех языков. */
export function getVocabularyStats(): VocabularyStats {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) AS total FROM vocabulary_items GROUP BY status')
    .all() as { status: string; total: number }[];

  const stats: VocabularyStats = { total: 0, new: 0, learning: 0, known: 0 };

  for (const row of rows) {
    const total = toCount(row.total);

    stats.total += total;
    stats[row.status as VocabularyStatus] = total;
  }

  return stats;
}

/** Отбор слов для текстового контекста ученика. */
export interface RecentVocabularyOptions {
  language?: LanguageCode;
  /** Стадии освоения; по умолчанию учитываются все. */
  statuses?: readonly VocabularyStatus[];
  limit: number;
}

/** Слова, которые встречались последними; первым идёт самое свежее. */
export function listRecentVocabularyItems(options: RecentVocabularyOptions): VocabularyItem[] {
  const conditions: string[] = [];
  const parameters: SqlParameter[] = [];

  if (options.language !== undefined) {
    conditions.push('language = ?');
    parameters.push(options.language);
  }
  if (options.statuses !== undefined && options.statuses.length > 0) {
    conditions.push(`status IN (${options.statuses.map(() => '?').join(', ')})`);
    parameters.push(...options.statuses);
  }

  const { where } = toWhere(conditions, parameters);
  const rows = getDb()
    .prepare(`SELECT * FROM vocabulary_items${where} ORDER BY last_seen_at DESC, id DESC LIMIT ?`)
    .all(...parameters, options.limit) as VocabularyItemRow[];

  return rows.map(rowToVocabularyItem);
}

// ---------------------------------------------------------------------------
// Журнал ошибок
// ---------------------------------------------------------------------------

/** Фильтры журнала ошибок; действуют одновременно (логическое И). */
export interface ErrorLogFilters {
  category?: ErrorCategory;
  lessonId?: Id;
  language?: LanguageCode;
  /** Нижняя граница по `occurredAt`, включительно. */
  since?: string;
  /** Верхняя граница по `occurredAt`, включительно. */
  until?: string;
}

/** Условия `WHERE` журнала ошибок. */
function errorLogFilter(filters: ErrorLogFilters): SqlFilter {
  const conditions: string[] = [];
  const parameters: SqlParameter[] = [];

  if (filters.category !== undefined) {
    conditions.push('category = ?');
    parameters.push(filters.category);
  }
  if (filters.lessonId !== undefined) {
    conditions.push('lesson_id = ?');
    parameters.push(filters.lessonId);
  }
  if (filters.language !== undefined) {
    conditions.push('language = ?');
    parameters.push(filters.language);
  }
  if (filters.since !== undefined) {
    conditions.push('occurred_at >= ?');
    parameters.push(filters.since);
  }
  if (filters.until !== undefined) {
    conditions.push('occurred_at <= ?');
    parameters.push(filters.until);
  }

  return toWhere(conditions, parameters);
}

/** Добавляет записи журнала ошибок одной транзакцией. */
export function insertErrorLogEntries(entries: readonly ErrorLogEntry[]): void {
  if (entries.length === 0) {
    return;
  }

  const db = getDb();
  const rows = entries.map((entry) => errorLogEntryToRow(entry));

  const insert = db.transaction((): void => {
    const statement = db.prepare(INSERT_ERROR_LOG_SQL);

    for (const row of rows) {
      statement.run(row);
    }
  });

  insert();
}

/** Страница журнала ошибок в порядке возникновения. */
export function listErrorLogEntries(query: ListErrorsQuery): Paginated<ErrorLogEntry> {
  const { limit, offset } = query;
  const { where, parameters } = errorLogFilter({
    ...(query.category === undefined ? {} : { category: query.category }),
    ...(query.lessonId === undefined ? {} : { lessonId: query.lessonId }),
    ...(query.since === undefined ? {} : { since: query.since }),
    ...(query.until === undefined ? {} : { until: query.until }),
  });
  const db = getDb();
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM error_log${where}`)
    .get(...parameters) as {
    total: number;
  };

  if (total === 0) {
    return emptyPage<ErrorLogEntry>(limit, offset);
  }

  const direction = toSqlOrder(query.order);
  const rows = db
    .prepare(
      `SELECT * FROM error_log${where}
         ORDER BY occurred_at ${direction}, id ${direction} LIMIT ? OFFSET ?`,
    )
    .all(...parameters, limit, offset) as ErrorLogRow[];

  return toPage(rows.map(rowToErrorLogEntry), total, limit, offset);
}

/**
 * Счётчики ошибок по категориям. Набор ключей исчерпывающий: категории без записей
 * остаются нулевыми, поэтому результат всегда проходит `z.record(errorCategorySchema, …)`.
 */
export function countErrorsByCategory(filters: ErrorLogFilters): Record<ErrorCategory, number> {
  const { where, parameters } = errorLogFilter(filters);
  const rows = getDb()
    .prepare(`SELECT category, COUNT(*) AS total FROM error_log${where} GROUP BY category`)
    .all(...parameters) as { category: string; total: number }[];

  const counts = emptyErrorCountsByCategory();

  for (const row of rows) {
    counts[row.category as ErrorCategory] = toCount(row.total);
  }

  return counts;
}

/** Последние записи журнала ошибок; первой идёт самая свежая. */
export function listRecentErrorLogEntries(
  filters: ErrorLogFilters & { limit: number },
): ErrorLogEntry[] {
  const { limit, ...rest } = filters;
  const { where, parameters } = errorLogFilter(rest);
  const rows = getDb()
    .prepare(`SELECT * FROM error_log${where} ORDER BY occurred_at DESC, id DESC LIMIT ?`)
    .all(...parameters, limit) as ErrorLogRow[];

  return rows.map(rowToErrorLogEntry);
}

// ---------------------------------------------------------------------------
// История уровня
// ---------------------------------------------------------------------------

/** Страница истории уровня. */
export function listLevelHistory(query: ListLevelHistoryQuery): Paginated<LevelHistoryEntry> {
  const { limit, offset } = query;
  const db = getDb();
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM level_history').get() as {
    total: number;
  };

  if (total === 0) {
    return emptyPage<LevelHistoryEntry>(limit, offset);
  }

  const direction = toSqlOrder(query.order);
  const rows = db
    .prepare(
      `SELECT ${SELECT_LEVEL_HISTORY_COLUMNS} FROM level_history
         ORDER BY changed_at ${direction}, created_at ${direction} LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as LevelHistoryRow[];

  return toPage(rows.map(rowToLevelHistoryEntry), total, limit, offset);
}

// ---------------------------------------------------------------------------
// Занятия: уроки и попытки
// ---------------------------------------------------------------------------

/** Счётчики уроков по состояниям, попадающие в сводку. */
export interface LessonCounts {
  completed: number;
  inProgress: number;
}

/** Агрегат попыток: сколько всего и сколько верных. */
export interface ExerciseTotals {
  total: number;
  correct: number;
}

/** Завершённый урок в окне пересчёта уровня. */
export interface CompletedLessonRef {
  id: Id;
  completedAt: string;
}

/** Сколько уроков завершено и сколько идёт прямо сейчас. */
export function countLessonsByStatus(): LessonCounts {
  const row = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
         COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) AS in_progress
       FROM lessons`,
    )
    .get() as { completed: number; in_progress: number };

  return { completed: toCount(row.completed), inProgress: toCount(row.in_progress) };
}

/**
 * Сколько уроков завершено после момента `changedAt`. `null` — считаются все
 * завершённые уроки (изменений уровня ещё не было).
 */
export function countCompletedLessonsSince(changedAt: string | null): number {
  const db = getDb();
  const row =
    changedAt === null
      ? (db
          .prepare(
            `SELECT COUNT(*) AS total FROM lessons
               WHERE status = 'completed' AND completed_at IS NOT NULL`,
          )
          .get() as { total: number })
      : (db
          .prepare(
            `SELECT COUNT(*) AS total FROM lessons
               WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at > ?`,
          )
          .get(changedAt) as { total: number });

  return toCount(row.total);
}

/** Последние завершённые уроки; первым идёт самый свежий. */
export function findRecentCompletedLessons(limit: number): CompletedLessonRef[] {
  const rows = getDb()
    .prepare(
      `SELECT id, completed_at FROM lessons
         WHERE status = 'completed' AND completed_at IS NOT NULL
         ORDER BY completed_at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as { id: string; completed_at: string }[];

  return rows.map((row) => ({ id: row.id, completedAt: row.completed_at }));
}

/** Агрегат всех попыток за всё время. */
export function getExerciseTotals(): ExerciseTotals {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct FROM exercise_attempts`,
    )
    .get() as { total: number; correct: number };

  return { total: toCount(row.total), correct: toCount(row.correct) };
}

/** Агрегат попыток по перечисленным урокам. */
export function getExerciseTotalsForLessons(lessonIds: readonly Id[]): ExerciseTotals {
  if (lessonIds.length === 0) {
    return { total: 0, correct: 0 };
  }

  const placeholders = lessonIds.map(() => '?').join(', ');
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct
         FROM exercise_attempts WHERE lesson_id IN (${placeholders})`,
    )
    .get(...lessonIds) as { total: number; correct: number };

  return { total: toCount(row.total), correct: toCount(row.correct) };
}

/**
 * Суммарное время занятий в минутах: берётся `durationMinutes` из итога урока
 * (`lessons.summary`), поэтому незавершённые уроки в сумму не входят.
 */
export function sumPracticeMinutes(): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(json_extract(summary, '$.durationMinutes')), 0) AS minutes
         FROM lessons WHERE summary IS NOT NULL`,
    )
    .get() as { minutes: number | null };

  return toCount(row.minutes);
}

/**
 * Активность по дням (UTC) для графика занятий: завершённые уроки, минуты из их
 * итогов и число попыток. Результат отсортирован по возрастанию даты, длина —
 * не больше `limit` последних дней с активностью.
 */
export function listDailyActivity(limit: number): DailyActivity[] {
  const rows = getDb()
    .prepare(
      `WITH activity AS (
         SELECT substr(completed_at, 1, 10) AS day,
                1 AS lessons,
                COALESCE(json_extract(summary, '$.durationMinutes'), 0) AS minutes,
                0 AS exercises
           FROM lessons
          WHERE status = 'completed' AND completed_at IS NOT NULL
          UNION ALL
         SELECT substr(created_at, 1, 10) AS day, 0 AS lessons, 0 AS minutes, 1 AS exercises
           FROM exercise_attempts
       )
       SELECT day,
              SUM(lessons) AS lessons,
              SUM(minutes) AS minutes,
              SUM(exercises) AS exercises
         FROM activity
        GROUP BY day
        ORDER BY day DESC
        LIMIT ?`,
    )
    .all(limit) as { day: string; lessons: number; minutes: number; exercises: number }[];

  return rows
    .map((row) => ({
      date: row.day,
      minutes: toCount(row.minutes),
      lessons: toCount(row.lessons),
      exercises: toCount(row.exercises),
    }))
    .reverse();
}

/** Дни с занятиями (UTC), от самого свежего к самому раннему: основа для серий. */
export function listActivityDates(limit: number): string[] {
  const rows = getDb()
    .prepare(
      `SELECT day FROM (
         SELECT substr(completed_at, 1, 10) AS day FROM lessons
          WHERE status = 'completed' AND completed_at IS NOT NULL
          UNION
         SELECT substr(created_at, 1, 10) AS day FROM exercise_attempts
       )
       ORDER BY day DESC LIMIT ?`,
    )
    .all(limit) as { day: string }[];

  return rows.map((row) => row.day);
}

/** Темы последних уроков; если темы нет, берётся название урока. */
export function listRecentLessonTopics(options: {
  language?: LanguageCode;
  limit: number;
}): string[] {
  const conditions: string[] = [];
  const parameters: SqlParameter[] = [];

  if (options.language !== undefined) {
    conditions.push('learning_language = ?');
    parameters.push(options.language);
  }

  const { where } = toWhere(conditions, parameters);
  const rows = getDb()
    .prepare(
      `SELECT COALESCE(NULLIF(topic, ''), title) AS topic FROM lessons${where}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...parameters, options.limit) as { topic: string }[];

  return rows.map((row) => row.topic);
}
