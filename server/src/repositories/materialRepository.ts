/**
 * Доступ к таблицам `materials` и `material_chunks`.
 *
 * Здесь живёт весь SQL материалов: сервис работает только с доменными типами
 * `@lt/shared` и не знает ни про колонки, ни про `file_path` в базе. Соединение
 * берётся через `getDb()` при каждом обращении — тесты подменяют его `setDb()`.
 *
 * Колонка порядка фрагмента называется `order` — это зарезервированное слово SQL,
 * поэтому в запросах она всегда в двойных кавычках.
 */
import type {
  Id,
  LanguageCode,
  ListMaterialsQuery,
  Material,
  MaterialChunk,
  MaterialErrorStatus,
  Paginated,
} from '@lt/shared';

import { getDb } from '../db/connection.js';
import {
  materialChunkToRow,
  materialToRow,
  nowIso,
  rowToMaterial,
  rowToMaterialChunk,
} from '../db/mappers.js';
import {
  PROFILE_ROW_ID,
  type MaterialChunkRow,
  type MaterialRow,
  type ProfileRow,
} from '../db/rows.js';

/** Колонки `materials` в порядке, в котором их отдаёт `materialToRow()`. */
const MATERIAL_COLUMNS = [
  'id',
  'title',
  'source_type',
  'status',
  'status_message',
  'original_file_name',
  'file_path',
  'mime_type',
  'size_bytes',
  'language',
  'level',
  'char_count',
  'chunk_count',
  'page_count',
  'topics',
  'summary',
  'created_at',
  'updated_at',
] as const;

const INSERT_MATERIAL_SQL = `INSERT INTO materials (${MATERIAL_COLUMNS.join(', ')})
  VALUES (${MATERIAL_COLUMNS.map((column) => `@${column}`).join(', ')})`;

const INSERT_CHUNK_SQL = `INSERT INTO material_chunks
  (id, material_id, "order", content, char_count, page, heading, created_at)
  VALUES (@id, @material_id, @order, @content, @char_count, @page, @heading, @created_at)`;

/**
 * Колонки, которые меняет фоновая обработка.
 *
 * `id` и `created_at` не меняются никогда, `file_path` — тоже: исходный файл лежит
 * там же, где его оставила загрузка, и обработка его не перекладывает.
 */
const MATERIAL_UPDATE_COLUMNS = MATERIAL_COLUMNS.filter(
  (column) => column !== 'id' && column !== 'file_path' && column !== 'created_at',
);

const UPDATE_MATERIAL_SQL = `UPDATE materials
  SET ${MATERIAL_UPDATE_COLUMNS.map((column) => `${column} = @${column}`).join(', ')}
  WHERE id = @id`;

const DELETE_CHUNKS_SQL = 'DELETE FROM material_chunks WHERE material_id = ?';

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

/** Сохраняет материал вместе с его фрагментами одной транзакцией. */
export function insertMaterial(
  material: Material,
  chunks: readonly MaterialChunk[],
  filePath: string | null,
): void {
  const db = getDb();
  const materialRow = materialToRow(material, { filePath });
  const chunkRows = chunks.map((chunk) => materialChunkToRow(chunk));

  const insert = db.transaction(() => {
    db.prepare(INSERT_MATERIAL_SQL).run(materialRow);

    const insertChunk = db.prepare(INSERT_CHUNK_SQL);

    for (const row of chunkRows) {
      insertChunk.run(row);
    }
  });

  insert();
}

/**
 * Заменяет содержимое материала: поля записи и все её фрагменты одной транзакцией.
 *
 * Нужна фоновой обработке скана: материал уже сохранён со статусом `processing`,
 * а текст и фрагменты появляются минутами позже. Старые фрагменты удаляются,
 * поэтому повторный проход не оставляет дублей.
 */
export function updateMaterialContent(material: Material, chunks: readonly MaterialChunk[]): void {
  const db = getDb();
  const { file_path: _filePath, created_at: _createdAt, ...materialRow } = materialToRow(material);
  const chunkRows = chunks.map((chunk) => materialChunkToRow(chunk));

  const update = db.transaction(() => {
    db.prepare(UPDATE_MATERIAL_SQL).run(materialRow);
    db.prepare(DELETE_CHUNKS_SQL).run(material.id);

    const insertChunk = db.prepare(INSERT_CHUNK_SQL);

    for (const row of chunkRows) {
      insertChunk.run(row);
    }
  });

  update();
}

/** Обновляет пояснение к статусу: им показывается ход фоновой обработки. */
export function updateMaterialStatusMessage(id: Id, statusMessage: string | null): void {
  getDb()
    .prepare('UPDATE materials SET status_message = ?, updated_at = ? WHERE id = ?')
    .run(statusMessage, nowIso(), id);
}

/** Переводит материал в статус неудачи с пояснением. */
export function updateMaterialFailure(
  id: Id,
  status: MaterialErrorStatus,
  statusMessage: string,
): void {
  getDb()
    .prepare('UPDATE materials SET status = ?, status_message = ?, updated_at = ? WHERE id = ?')
    .run(status, statusMessage, nowIso(), id);
}

/**
 * Помечает материалы, застрявшие в `processing`, статусом неудачи.
 *
 * Фоновая обработка живёт в памяти процесса, поэтому перезапуск сервера её теряет:
 * без этой уборки материал навсегда остался бы «обрабатывается». Вызывается один
 * раз при старте, когда никакая обработка ещё не идёт.
 *
 * @returns сколько материалов переведено в неудачу
 */
export function failStuckProcessingMaterials(
  status: MaterialErrorStatus,
  statusMessage: string,
): number {
  return getDb()
    .prepare(
      `UPDATE materials SET status = ?, status_message = ?, updated_at = ?
         WHERE status = 'processing'`,
    )
    .run(status, statusMessage, nowIso()).changes;
}

/**
 * Сколько фрагментов каждого материала уже отработано на уроках.
 *
 * Считается одним запросом на весь список материалов: счётчик нужен каждому
 * элементу страницы, а запрос на материал в цикле превратил бы список в N+1.
 * Отработанным фрагмент делает шаг плана со статусом `completed`; `skipped`
 * пройденным НЕ считается — ученик шаг пропустил, а не отработал (то же правило
 * и та же оговорка в `findCoveredChunkIds()` в `lessonRepository.ts`).
 *
 * `material_chunk_ids` шага — JSON-массив, поэтому он разворачивается `json_each()`
 * прямо в запросе: иначе счётчик пришлось бы собирать в памяти по всем урокам.
 * Считаются только существующие фрагменты (`JOIN material_chunks`), поэтому
 * результат не превышает `chunk_count` материала.
 */
function findCoveredChunkCounts(ids: readonly Id[]): Map<Id, number> {
  const counts = new Map<Id, number>();

  if (ids.length === 0) {
    return counts;
  }

  const placeholders = ids.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `SELECT chunks.material_id AS material_id, COUNT(DISTINCT chunks.id) AS total
         FROM lesson_plan_steps steps
         JOIN json_each(steps.material_chunk_ids) AS reference
         JOIN material_chunks chunks ON chunks.id = reference.value
        WHERE steps.status = 'completed' AND chunks.material_id IN (${placeholders})
        GROUP BY chunks.material_id`,
    )
    .all(...ids) as { material_id: Id; total: number }[];

  for (const row of rows) {
    counts.set(row.material_id, row.total);
  }

  return counts;
}

/** Материал по идентификатору; `undefined` — материала нет. */
export function findMaterialById(id: Id): Material | undefined {
  const row = getDb().prepare('SELECT * FROM materials WHERE id = ?').get(id) as
    MaterialRow | undefined;

  return row === undefined
    ? undefined
    : rowToMaterial(row, { coveredChunkCount: findCoveredChunkCounts([id]).get(id) ?? 0 });
}

/**
 * Материалы по списку идентификаторов; порядок результата повторяет порядок списка.
 *
 * `coveredChunkCount` здесь остаётся нулевым: выборка обслуживает планирование
 * урока, которому нужны статус, название и фрагменты, а не счётчик пройденного.
 */
export function findMaterialsByIds(ids: readonly Id[]): Material[] {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(`SELECT * FROM materials WHERE id IN (${placeholders})`)
    .all(...ids) as MaterialRow[];
  const byId = new Map(rows.map((row) => [row.id, rowToMaterial(row)]));

  return ids
    .map((id) => byId.get(id))
    .filter((material): material is Material => material !== undefined);
}

/**
 * Путь к исходному файлу материала: `null` — файла нет (вставленный текст),
 * `undefined` — нет самого материала. В контракт API путь не отдаётся.
 */
export function findMaterialFilePath(id: Id): string | null | undefined {
  const row = getDb().prepare('SELECT file_path FROM materials WHERE id = ?').get(id) as
    Pick<MaterialRow, 'file_path'> | undefined;

  return row === undefined ? undefined : row.file_path;
}

/** Страница списка материалов; фильтры применяются одновременно (логическое И). */
export function listMaterials(query: ListMaterialsQuery): Paginated<Material> {
  const { limit, offset } = query;
  const conditions: string[] = [];
  const parameters: string[] = [];

  if (query.status !== undefined) {
    conditions.push('status = ?');
    parameters.push(query.status);
  }
  if (query.sourceType !== undefined) {
    conditions.push('source_type = ?');
    parameters.push(query.sourceType);
  }
  if (query.language !== undefined) {
    conditions.push('language = ?');
    parameters.push(query.language);
  }
  if (query.search !== undefined) {
    // Поиск идёт и по названию, и по тексту фрагментов: пользователь ищет материал
    // по запомнившейся фразе не реже, чем по заголовку.
    conditions.push(
      `(title LIKE ? ESCAPE '\\' OR EXISTS (
         SELECT 1 FROM material_chunks WHERE material_chunks.material_id = materials.id
           AND material_chunks.content LIKE ? ESCAPE '\\'))`,
    );
    parameters.push(toLikePattern(query.search), toLikePattern(query.search));
  }

  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
  const db = getDb();
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM materials${where}`)
    .get(...parameters) as {
    total: number;
  };

  if (total === 0) {
    return emptyPage<Material>(limit, offset);
  }

  const rows = db
    .prepare(`SELECT * FROM materials${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...parameters, limit, offset) as MaterialRow[];
  const covered = findCoveredChunkCounts(rows.map((row) => row.id));
  const materials = rows.map((row) =>
    rowToMaterial(row, { coveredChunkCount: covered.get(row.id) ?? 0 }),
  );

  return toPage(materials, total, limit, offset);
}

/** Число фрагментов материала. */
export function countMaterialChunks(materialId: Id): number {
  const { total } = getDb()
    .prepare('SELECT COUNT(*) AS total FROM material_chunks WHERE material_id = ?')
    .get(materialId) as { total: number };

  return total;
}

/** Страница фрагментов материала в порядке чтения. */
export function listMaterialChunks(
  materialId: Id,
  pagination: { limit: number; offset: number },
): Paginated<MaterialChunk> {
  const { limit, offset } = pagination;
  const total = countMaterialChunks(materialId);

  if (total === 0) {
    return emptyPage<MaterialChunk>(limit, offset);
  }

  const rows = getDb()
    .prepare(
      `SELECT * FROM material_chunks WHERE material_id = ?
         ORDER BY "order" ASC LIMIT ? OFFSET ?`,
    )
    .all(materialId, limit, offset) as MaterialChunkRow[];

  return toPage(rows.map(rowToMaterialChunk), total, limit, offset);
}

/** Все фрагменты перечисленных материалов в порядке чтения внутри каждого материала. */
export function listChunksByMaterialIds(materialIds: readonly Id[]): MaterialChunk[] {
  if (materialIds.length === 0) {
    return [];
  }

  const placeholders = materialIds.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `SELECT * FROM material_chunks WHERE material_id IN (${placeholders})
         ORDER BY material_id ASC, "order" ASC`,
    )
    .all(...materialIds) as MaterialChunkRow[];

  return rows.map(rowToMaterialChunk);
}

/**
 * Язык изучения из профиля: им помечается материал, если клиент не прислал язык.
 *
 * Профиль однострочный и создаётся миграцией, поэтому это единственное обращение
 * к чужой таблице здесь — только чтение одной колонки, без записи и без маппинга.
 */
export function findLearningLanguage(): LanguageCode | undefined {
  const row = getDb()
    .prepare('SELECT learning_language FROM profile WHERE id = ?')
    .get(PROFILE_ROW_ID) as Pick<ProfileRow, 'learning_language'> | undefined;

  return row?.learning_language;
}

/** Удаляет материал; фрагменты уходят каскадом. `false` — материала не было. */
export function deleteMaterialById(id: Id): boolean {
  return getDb().prepare('DELETE FROM materials WHERE id = ?').run(id).changes > 0;
}
