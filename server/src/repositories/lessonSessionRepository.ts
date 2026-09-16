/**
 * Доступ к данным идущего урока: реплики диалога (`lesson_messages`), задания
 * (`exercises`) и попытки их выполнения (`exercise_attempts`).
 *
 * Слой знает только про строки таблиц и SQL: перевод в доменные типы `@lt/shared`
 * делают мапперы `db/mappers.js`, а правила занятия — `services/lessonSessionService.js`.
 * Соединение берётся через `getDb()` при каждом обращении — тесты подменяют его `setDb()`.
 *
 * Здесь же лежат точечные мутации урока и шага плана (`updateLesson`,
 * `updateLessonPlanStep`): `repositories/lessonRepository.ts` принадлежит пакету
 * планирования и умеет только вставку урока целиком и замену плана целиком, а ходу
 * урока нужно менять статус одного шага и состояние урока, не переписывая план.
 *
 * Запись хода урока идёт одной транзакцией `saveLessonProgress()`: реплика тьютора
 * без обновлённого шага или попытка без обновлённого урока — это рассогласованная
 * история занятия, поэтому части по разным транзакциям не разносятся.
 *
 * Колонка порядка называется `order` — это зарезервированное слово SQL, поэтому
 * в запросах она всегда в двойных кавычках. A10: `lesson_messages.audio_path`
 * всегда NULL, аудио не хранится.
 */
import type {
  Exercise,
  ExerciseAttempt,
  Id,
  Lesson,
  LessonMessage,
  LessonPlanStep,
  ListLessonMessagesQuery,
  Paginated,
  SortOrder,
} from '@lt/shared';

import { getDb } from '../db/connection.js';
import {
  exerciseAttemptToRow,
  exerciseToRow,
  lessonMessageToRow,
  lessonPlanStepToRow,
  lessonToRow,
  rowToExercise,
  rowToExerciseAttempt,
  rowToLessonMessage,
} from '../db/mappers.js';
import type { ExerciseAttemptRow, ExerciseRow, LessonMessageRow } from '../db/rows.js';

/** Колонки `lesson_messages` в порядке, в котором их отдаёт `lessonMessageToRow()`. */
const MESSAGE_COLUMNS = [
  'id',
  'lesson_id',
  'step_id',
  'role',
  'source',
  'content',
  'language',
  'corrections',
  'audio_path',
  'duration_ms',
  'created_at',
] as const;

const INSERT_MESSAGE_SQL = `INSERT INTO lesson_messages (${MESSAGE_COLUMNS.join(', ')})
  VALUES (${MESSAGE_COLUMNS.map((column) => `@${column}`).join(', ')})`;

const UPDATE_MESSAGE_SQL = `UPDATE lesson_messages SET ${MESSAGE_COLUMNS.filter(
  (column) => column !== 'id',
)
  .map((column) => `${column} = @${column}`)
  .join(', ')} WHERE id = @id`;

/** Колонки `exercises` в порядке, в котором их отдаёт `exerciseToRow()`. */
const EXERCISE_COLUMNS = [
  'id',
  'lesson_id',
  'step_id',
  'order',
  'type',
  'prompt',
  'instructions',
  'options',
  'expected_answer',
  'acceptable_answers',
  'hints',
  'target_items',
  'level',
  'created_at',
] as const;

const INSERT_EXERCISE_SQL = `INSERT INTO exercises
  (${EXERCISE_COLUMNS.map((column) => (column === 'order' ? '"order"' : column)).join(', ')})
  VALUES (${EXERCISE_COLUMNS.map((column) => `@${column}`).join(', ')})`;

/** Колонки `exercise_attempts` в порядке, в котором их отдаёт `exerciseAttemptToRow()`. */
const ATTEMPT_COLUMNS = [
  'id',
  'exercise_id',
  'lesson_id',
  'step_id',
  'answer',
  'source',
  'is_correct',
  'score',
  'corrections',
  'feedback',
  'duration_ms',
  'created_at',
] as const;

const INSERT_ATTEMPT_SQL = `INSERT INTO exercise_attempts (${ATTEMPT_COLUMNS.join(', ')})
  VALUES (${ATTEMPT_COLUMNS.map((column) => `@${column}`).join(', ')})`;

/**
 * Обновление урока и шага перечисляет все колонки строки: better-sqlite3 требует,
 * чтобы каждый ключ переданного объекта имел параметр в запросе.
 */
const UPDATE_LESSON_SQL = `
  UPDATE lessons
     SET title                = @title,
         status               = @status,
         learning_language    = @learning_language,
         explanation_language = @explanation_language,
         level                = @level,
         topic                = @topic,
         goals                = @goals,
         current_step_id      = @current_step_id,
         planned_minutes      = @planned_minutes,
         summary              = @summary,
         started_at           = @started_at,
         completed_at         = @completed_at,
         created_at           = @created_at,
         updated_at           = @updated_at
   WHERE id = @id
`;

const UPDATE_STEP_SQL = `
  UPDATE lesson_plan_steps
     SET lesson_id          = @lesson_id,
         "order"            = @order,
         type               = @type,
         title              = @title,
         objectives         = @objectives,
         target_items       = @target_items,
         instructions       = @instructions,
         estimated_minutes  = @estimated_minutes,
         status             = @status,
         material_chunk_ids = @material_chunk_ids,
         exercise_ids       = @exercise_ids,
         started_at         = @started_at,
         completed_at       = @completed_at
   WHERE id = @id
`;

/**
 * Порядок реплик: по времени создания, а при совпадении — по `rowid`, то есть по
 * порядку вставки. Реплика ученика и ответ тьютора нередко попадают в одну и ту же
 * миллисекунду, и без `rowid` их порядок в истории был бы случайным.
 */
function messageOrderBy(order: SortOrder): string {
  return order === 'desc' ? 'created_at DESC, rowid DESC' : 'created_at ASC, rowid ASC';
}

/** Значение параметра запроса: SQLite не умеет связывать `undefined`. */
type SqlParameter = string | number;

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

// ---------------------------------------------------------------------------
// Реплики диалога
// ---------------------------------------------------------------------------

/**
 * Сохраняет реплику урока отдельной транзакцией.
 *
 * Так пишется реплика ученика — ДО обращения к модели: отказ провайдера не должен
 * стоить ученику сказанного, и повтор хода обязан работать.
 */
export function insertLessonMessage(message: LessonMessage): void {
  getDb().prepare(INSERT_MESSAGE_SQL).run(lessonMessageToRow(message));
}

/** Число реплик урока. */
export function countLessonMessages(lessonId: Id): number {
  const { total } = getDb()
    .prepare('SELECT COUNT(*) AS total FROM lesson_messages WHERE lesson_id = ?')
    .get(lessonId) as { total: number };

  return total;
}

/**
 * Число реплик шага с указанной ролью.
 *
 * По репликам ученика считается бюджет шага (`lib/stepBudget.ts`): окно истории
 * для этого не годится — оно ограничено числом реплик и не отличает шаг,
 * который идёт долго, от только что начатого.
 */
export function countStepMessages(lessonId: Id, stepId: Id, role: LessonMessage['role']): number {
  const { total } = getDb()
    .prepare(
      'SELECT COUNT(*) AS total FROM lesson_messages WHERE lesson_id = ? AND step_id = ? AND role = ?',
    )
    .get(lessonId, stepId, role) as { total: number };

  return total;
}

/** Страница истории диалога с фильтрами по шагу и роли. */
export function listLessonMessages(
  lessonId: Id,
  query: ListLessonMessagesQuery,
): Paginated<LessonMessage> {
  const { limit, offset } = query;
  const conditions = ['lesson_id = ?'];
  const parameters: SqlParameter[] = [lessonId];

  if (query.stepId !== undefined) {
    conditions.push('step_id = ?');
    parameters.push(query.stepId);
  }
  if (query.role !== undefined) {
    conditions.push('role = ?');
    parameters.push(query.role);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const db = getDb();
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM lesson_messages ${where}`)
    .get(...parameters) as { total: number };

  if (total === 0) {
    return emptyPage<LessonMessage>(limit, offset);
  }

  const rows = db
    .prepare(
      `SELECT * FROM lesson_messages ${where}
         ORDER BY ${messageOrderBy(query.order)} LIMIT ? OFFSET ?`,
    )
    .all(...parameters, limit, offset) as LessonMessageRow[];

  return toPage(rows.map(rowToLessonMessage), total, limit, offset);
}

/** История урока, нарезанная под предел длины контекста модели. */
export interface LessonHistory {
  /** Последние реплики урока в хронологическом порядке. */
  recent: LessonMessage[];
  /** Реплики перед окном: из них собирается сжатая сводка. */
  earlier: LessonMessage[];
  /** Сколько всего реплик осталось за окном, включая не прочитанные. */
  earlierTotal: number;
}

/**
 * Читает историю урока порциями: окно последних реплик дословно и ограниченное
 * число реплик перед ним. Урок на сотню реплик не должен целиком уезжать ни в
 * память, ни в промпт.
 */
export function findLessonHistory(
  lessonId: Id,
  options: { window: number; digest: number },
): LessonHistory {
  const db = getDb();
  const total = countLessonMessages(lessonId);
  const select = db.prepare(
    `SELECT * FROM lesson_messages WHERE lesson_id = ?
       ORDER BY ${messageOrderBy('desc')} LIMIT ? OFFSET ?`,
  );
  const recentRows = select.all(lessonId, options.window, 0) as LessonMessageRow[];
  const earlierRows =
    total <= options.window
      ? []
      : (select.all(lessonId, options.digest, options.window) as LessonMessageRow[]);

  return {
    recent: recentRows.reverse().map(rowToLessonMessage),
    earlier: earlierRows.reverse().map(rowToLessonMessage),
    earlierTotal: Math.max(0, total - options.window),
  };
}

// ---------------------------------------------------------------------------
// Задания и попытки
// ---------------------------------------------------------------------------

/** Задание урока по идентификатору; `undefined` — задания нет или оно из другого урока. */
export function findLessonExercise(lessonId: Id, exerciseId: Id): Exercise | undefined {
  const row = getDb()
    .prepare('SELECT * FROM exercises WHERE id = ? AND lesson_id = ?')
    .get(exerciseId, lessonId) as ExerciseRow | undefined;

  return row === undefined ? undefined : rowToExercise(row);
}

/** Задания урока в порядке выдачи. */
export function listLessonExercises(lessonId: Id): Exercise[] {
  const rows = getDb()
    .prepare('SELECT * FROM exercises WHERE lesson_id = ? ORDER BY "order" ASC')
    .all(lessonId) as ExerciseRow[];

  return rows.map(rowToExercise);
}

/** Задания одного шага урока в порядке выдачи. */
export function listStepExercises(lessonId: Id, stepId: Id): Exercise[] {
  const rows = getDb()
    .prepare('SELECT * FROM exercises WHERE lesson_id = ? AND step_id = ? ORDER BY "order" ASC')
    .all(lessonId, stepId) as ExerciseRow[];

  return rows.map(rowToExercise);
}

/** Номер следующего задания урока: порядок сквозной по уроку, с нуля. */
export function nextExerciseOrder(lessonId: Id): number {
  const { total } = getDb()
    .prepare('SELECT COUNT(*) AS total FROM exercises WHERE lesson_id = ?')
    .get(lessonId) as { total: number };

  return total;
}

/** Попытки урока в хронологическом порядке. */
export function listLessonAttempts(lessonId: Id): ExerciseAttempt[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM exercise_attempts WHERE lesson_id = ?
         ORDER BY created_at ASC, rowid ASC`,
    )
    .all(lessonId) as ExerciseAttemptRow[];

  return rows.map(rowToExerciseAttempt);
}

/** Идентификаторы заданий урока, на которые уже отвечали. */
export function findAttemptedExerciseIds(lessonId: Id): Set<Id> {
  const rows = getDb()
    .prepare('SELECT DISTINCT exercise_id FROM exercise_attempts WHERE lesson_id = ?')
    .all(lessonId) as { exercise_id: string }[];

  return new Set(rows.map((row) => row.exercise_id));
}

// ---------------------------------------------------------------------------
// Запись хода урока
// ---------------------------------------------------------------------------

/** Что сохраняется одним ходом урока. Все части необязательны. */
export interface LessonProgressWrite {
  /** Урок: статус, текущий шаг, итог, `updatedAt`. */
  lesson?: Lesson | undefined;
  /** Изменённые шаги плана: статус, времена начала и завершения, `exerciseIds`. */
  steps?: readonly LessonPlanStep[] | undefined;
  /** Новые реплики диалога. */
  messages?: readonly LessonMessage[] | undefined;
  /** Уже сохранённые реплики, которым появились исправления. */
  updatedMessages?: readonly LessonMessage[] | undefined;
  /** Новые задания урока. */
  exercises?: readonly Exercise[] | undefined;
  /** Попытка выполнения задания. */
  attempt?: ExerciseAttempt | undefined;
}

/**
 * Сохраняет ход урока одной транзакцией.
 *
 * Порядок внутри транзакции задан внешними ключами: задания ссылаются на шаг,
 * попытка — на задание, поэтому сначала пишутся задания, затем реплики и попытка,
 * и только потом обновляются шаг и урок.
 */
export function saveLessonProgress(write: LessonProgressWrite): void {
  const db = getDb();
  const exerciseRows = (write.exercises ?? []).map((exercise) => exerciseToRow(exercise));
  const messageRows = (write.messages ?? []).map((message) => lessonMessageToRow(message));
  const updatedRows = (write.updatedMessages ?? []).map((message) => lessonMessageToRow(message));
  const attemptRow = write.attempt === undefined ? undefined : exerciseAttemptToRow(write.attempt);
  const stepRows = (write.steps ?? []).map((step) => lessonPlanStepToRow(step));
  const lessonRow = write.lesson === undefined ? undefined : lessonToRow(write.lesson);

  const save = db.transaction((): void => {
    if (exerciseRows.length > 0) {
      const insertExercise = db.prepare(INSERT_EXERCISE_SQL);

      for (const row of exerciseRows) {
        insertExercise.run(row);
      }
    }

    if (messageRows.length > 0) {
      const insertMessage = db.prepare(INSERT_MESSAGE_SQL);

      for (const row of messageRows) {
        insertMessage.run(row);
      }
    }

    if (updatedRows.length > 0) {
      const updateMessage = db.prepare(UPDATE_MESSAGE_SQL);

      for (const row of updatedRows) {
        updateMessage.run(row);
      }
    }

    if (attemptRow !== undefined) {
      db.prepare(INSERT_ATTEMPT_SQL).run(attemptRow);
    }

    if (stepRows.length > 0) {
      const updateStep = db.prepare(UPDATE_STEP_SQL);

      for (const row of stepRows) {
        updateStep.run(row);
      }
    }

    if (lessonRow !== undefined) {
      db.prepare(UPDATE_LESSON_SQL).run(lessonRow);
    }
  });

  save();
}

/** Обновляет строку урока: статус, текущий шаг, итог и времена. */
export function updateLesson(lesson: Lesson): void {
  saveLessonProgress({ lesson });
}

/** Обновляет один шаг плана, не трогая остальные. */
export function updateLessonPlanStep(step: LessonPlanStep): void {
  saveLessonProgress({ steps: [step] });
}
