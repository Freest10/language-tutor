/**
 * Доступ к таблицам `lessons`, `lesson_plan_steps` и `lesson_materials`.
 *
 * Слой знает только про строки таблиц и SQL: перевод в доменные типы `@lt/shared`
 * делают мапперы `db/mappers.js`, а правила планирования — `services/lessonPlanService.js`.
 * Соединение берётся через `getDb()` при каждом обращении — тесты подменяют его `setDb()`.
 *
 * Урок читается всегда вместе с планом и списком материалов: `Lesson.plan` и
 * `Lesson.materialIds` входят в контракт, а отдельных эндпоинтов у них нет.
 * `Lesson.materialIds` хранится только в `lesson_materials`: дублирующей колонки нет.
 *
 * Колонка порядка называется `order` — это зарезервированное слово SQL, поэтому
 * в запросах она всегда в двойных кавычках.
 */
import type { Id, Lesson, LessonPlanStep, ListLessonsQuery, Paginated } from '@lt/shared';

import { getDb } from '../db/connection.js';
import {
  lessonMaterialsToRows,
  lessonPlanStepToRow,
  lessonToRow,
  rowToLesson,
  rowToLessonPlanStep,
  rowsToLessonMaterialIds,
} from '../db/mappers.js';
import type { LessonMaterialRow, LessonPlanStepRow, LessonRow } from '../db/rows.js';

/** Колонки `lessons` в порядке, в котором их отдаёт `lessonToRow()`. */
const LESSON_COLUMNS = [
  'id',
  'title',
  'status',
  'learning_language',
  'explanation_language',
  'level',
  'topic',
  'goals',
  'current_step_id',
  'planned_minutes',
  'summary',
  'started_at',
  'completed_at',
  'created_at',
  'updated_at',
] as const;

const INSERT_LESSON_SQL = `INSERT INTO lessons (${LESSON_COLUMNS.join(', ')})
  VALUES (${LESSON_COLUMNS.map((column) => `@${column}`).join(', ')})`;

/**
 * Обновление урока перечисляет все колонки строки: better-sqlite3 требует,
 * чтобы каждый ключ переданного объекта имел параметр в запросе.
 */
const UPDATE_LESSON_SQL = `UPDATE lessons SET ${LESSON_COLUMNS.filter((column) => column !== 'id')
  .map((column) => `${column} = @${column}`)
  .join(', ')} WHERE id = @id`;

const INSERT_STEP_SQL = `INSERT INTO lesson_plan_steps
  (id, lesson_id, "order", type, title, objectives, target_items, instructions,
   estimated_minutes, status, material_chunk_ids, exercise_ids, started_at, completed_at)
  VALUES (@id, @lesson_id, @order, @type, @title, @objectives, @target_items, @instructions,
   @estimated_minutes, @status, @material_chunk_ids, @exercise_ids, @started_at, @completed_at)`;

/**
 * Сохранение шага: уже существующий шаг обновляется, а не пересоздаётся.
 * Удаление шага обнулило бы `step_id` у реплик, заданий и попыток
 * (`ON DELETE SET NULL`), то есть стоило бы уроку его истории.
 */
const UPSERT_STEP_SQL = `${INSERT_STEP_SQL}
  ON CONFLICT (id) DO UPDATE SET
    lesson_id          = excluded.lesson_id,
    "order"            = excluded."order",
    type               = excluded.type,
    title              = excluded.title,
    objectives         = excluded.objectives,
    target_items       = excluded.target_items,
    instructions       = excluded.instructions,
    estimated_minutes  = excluded.estimated_minutes,
    status             = excluded.status,
    material_chunk_ids = excluded.material_chunk_ids,
    exercise_ids       = excluded.exercise_ids,
    started_at         = excluded.started_at,
    completed_at       = excluded.completed_at`;

const INSERT_LESSON_MATERIAL_SQL = `INSERT INTO lesson_materials
  (lesson_id, material_id, "order", created_at)
  VALUES (@lesson_id, @material_id, @order, @created_at)`;

const SELECT_STEPS_SQL = `SELECT * FROM lesson_plan_steps WHERE lesson_id = ? ORDER BY "order" ASC`;

const SELECT_LESSON_MATERIALS_SQL = `SELECT * FROM lesson_materials WHERE lesson_id = ?`;

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

/** Шаги плана урока в порядке колонки `"order"`. */
export function findLessonPlan(lessonId: Id): LessonPlanStep[] {
  const rows = getDb().prepare(SELECT_STEPS_SQL).all(lessonId) as LessonPlanStepRow[];

  return rows.map(rowToLessonPlanStep);
}

/** Материалы урока в порядке, в котором их выбрал ученик. */
export function findLessonMaterialIds(lessonId: Id): Id[] {
  const rows = getDb().prepare(SELECT_LESSON_MATERIALS_SQL).all(lessonId) as LessonMaterialRow[];

  return rowsToLessonMaterialIds(rows);
}

/** Настройки выборки пройденного материала. */
export interface CoveredChunkOptions {
  /**
   * Урок, шаги которого в «пройденное» не входят.
   *
   * Нужен пересборке плана: собственные завершённые шаги урока исключать нельзя,
   * иначе урок начнёт избегать материала, на котором сам и построен.
   */
  excludeLessonId?: Id;
}

/**
 * Фрагменты материалов, которые ученик уже отработал, — по всем урокам сразу.
 *
 * Пройденным фрагмент делает только шаг со статусом `completed`. Шаг `skipped`
 * пройденным НЕ считается: ученик его пропустил, а не отработал, и материал
 * обязан вернуться в следующий урок; `pending` и `in_progress` — тем более.
 * То же правило применяет счётчик `coveredChunkCount` в `materialRepository.ts`.
 *
 * Шаги отбираются по материалам урока (`lesson_materials`), поэтому в множество
 * попадают и фрагменты соседних материалов того же урока: как признак «это уже
 * пройдено» они безвредны, а лишнего запроса за принадлежностью фрагментов
 * отбор не стоит. Сами идентификаторы достаются маппером — колонка шага хранит
 * их JSON-массивом, и разбирать её где-то ещё нельзя.
 */
export function findCoveredChunkIds(
  materialIds: readonly Id[],
  options: CoveredChunkOptions = {},
): Set<Id> {
  const covered = new Set<Id>();

  if (materialIds.length === 0) {
    return covered;
  }

  const placeholders = materialIds.map(() => '?').join(', ');
  const excluded = options.excludeLessonId;
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT steps.* FROM lesson_plan_steps steps
         JOIN lesson_materials link ON link.lesson_id = steps.lesson_id
        WHERE steps.status = 'completed'
          AND link.material_id IN (${placeholders})
          ${excluded === undefined ? '' : 'AND steps.lesson_id <> ?'}`,
    )
    .all(...materialIds, ...(excluded === undefined ? [] : [excluded])) as LessonPlanStepRow[];

  for (const row of rows) {
    for (const chunkId of rowToLessonPlanStep(row).materialChunkIds) {
      covered.add(chunkId);
    }
  }

  return covered;
}

/** Урок вместе с планом и материалами; `undefined` — урока нет. */
export function findLessonById(id: Id): Lesson | undefined {
  const row = getDb().prepare('SELECT * FROM lessons WHERE id = ?').get(id) as
    LessonRow | undefined;

  return row === undefined
    ? undefined
    : rowToLesson(row, { materialIds: findLessonMaterialIds(id), plan: findLessonPlan(id) });
}

/** Шаги плана для нескольких уроков сразу: избавляет список от запроса на урок. */
function findPlansByLessonIds(ids: readonly Id[]): Map<Id, LessonPlanStep[]> {
  const plans = new Map<Id, LessonPlanStep[]>(ids.map((id) => [id, []]));

  if (ids.length === 0) {
    return plans;
  }

  const placeholders = ids.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `SELECT * FROM lesson_plan_steps WHERE lesson_id IN (${placeholders}) ORDER BY "order" ASC`,
    )
    .all(...ids) as LessonPlanStepRow[];

  for (const row of rows) {
    plans.get(row.lesson_id)?.push(rowToLessonPlanStep(row));
  }

  return plans;
}

/** Материалы для нескольких уроков сразу. */
function findMaterialIdsByLessonIds(ids: readonly Id[]): Map<Id, Id[]> {
  const materialIds = new Map<Id, Id[]>();

  if (ids.length === 0) {
    return materialIds;
  }

  const placeholders = ids.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(`SELECT * FROM lesson_materials WHERE lesson_id IN (${placeholders})`)
    .all(...ids) as LessonMaterialRow[];
  const grouped = new Map<Id, LessonMaterialRow[]>(ids.map((id) => [id, []]));

  for (const row of rows) {
    grouped.get(row.lesson_id)?.push(row);
  }

  for (const [lessonId, lessonRows] of grouped) {
    materialIds.set(lessonId, rowsToLessonMaterialIds(lessonRows));
  }

  return materialIds;
}

/** Страница списка уроков от новых к старым; фильтры применяются одновременно (логическое И). */
export function listLessons(query: ListLessonsQuery): Paginated<Lesson> {
  const { limit, offset } = query;
  const conditions: string[] = [];
  const parameters: string[] = [];

  if (query.status !== undefined) {
    conditions.push('status = ?');
    parameters.push(query.status);
  }
  if (query.language !== undefined) {
    conditions.push('learning_language = ?');
    parameters.push(query.language);
  }
  if (query.search !== undefined) {
    // Урок ищут по названию или по теме: это всё, что видно в списке.
    conditions.push(`(title LIKE ? ESCAPE '\\' OR topic LIKE ? ESCAPE '\\')`);
    parameters.push(toLikePattern(query.search), toLikePattern(query.search));
  }

  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
  const db = getDb();
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM lessons${where}`)
    .get(...parameters) as {
    total: number;
  };

  if (total === 0) {
    return emptyPage<Lesson>(limit, offset);
  }

  const rows = db
    .prepare(`SELECT * FROM lessons${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...parameters, limit, offset) as LessonRow[];
  const ids = rows.map((row) => row.id);
  const plans = findPlansByLessonIds(ids);
  const materials = findMaterialIdsByLessonIds(ids);
  const lessons = rows.map((row) =>
    rowToLesson(row, {
      materialIds: materials.get(row.id) ?? [],
      plan: plans.get(row.id) ?? [],
    }),
  );

  return toPage(lessons, total, limit, offset);
}

/**
 * Сохраняет новый урок целиком: строку урока, шаги плана и связи с материалами —
 * одной транзакцией. Урок без плана хуже, чем отсутствие урока, поэтому части
 * по разным транзакциям не разносятся.
 */
export function insertLesson(lesson: Lesson): void {
  const db = getDb();
  const lessonRow = lessonToRow(lesson);
  const stepRows = lesson.plan.map((step) => lessonPlanStepToRow(step));
  const materialRows = lessonMaterialsToRows(lesson.id, [...lesson.materialIds], lesson.createdAt);

  const insert = db.transaction((): void => {
    db.prepare(INSERT_LESSON_SQL).run(lessonRow);

    const insertStep = db.prepare(INSERT_STEP_SQL);

    for (const row of stepRows) {
      insertStep.run(row);
    }

    const insertMaterial = db.prepare(INSERT_LESSON_MATERIAL_SQL);

    for (const row of materialRows) {
      insertMaterial.run(row);
    }
  });

  insert();
}

/**
 * Заменяет план урока на `lesson.plan` и обновляет строку урока — одной транзакцией.
 *
 * Шаги, которых в новом плане нет, удаляются; оставшиеся обновляются на месте,
 * поэтому пересборка плана не плодит дубликатов и не рвёт связи уже пройденных
 * шагов с репликами, заданиями и попытками.
 */
export function replaceLessonPlan(lesson: Lesson): void {
  const db = getDb();
  const lessonRow = lessonToRow(lesson);
  const stepRows = lesson.plan.map((step) => lessonPlanStepToRow(step));
  const keptIds = stepRows.map((row) => row.id);

  const replace = db.transaction((): void => {
    if (keptIds.length === 0) {
      db.prepare('DELETE FROM lesson_plan_steps WHERE lesson_id = ?').run(lesson.id);
    } else {
      const placeholders = keptIds.map(() => '?').join(', ');

      db.prepare(
        `DELETE FROM lesson_plan_steps WHERE lesson_id = ? AND id NOT IN (${placeholders})`,
      ).run(lesson.id, ...keptIds);
    }

    const upsertStep = db.prepare(UPSERT_STEP_SQL);

    for (const row of stepRows) {
      upsertStep.run(row);
    }

    db.prepare(UPDATE_LESSON_SQL).run(lessonRow);
  });

  replace();
}
