/**
 * Доступ к таблицам `placement_sessions` и `placement_turns`.
 *
 * Слой знает только про строки таблиц и SQL: перевод в доменные типы `@lt/shared`
 * делают мапперы `db/mappers.js`, а правила теста — `services/placementService.js`.
 * Соединение берётся через `getDb()` при каждом обращении — тесты подменяют его `setDb()`.
 *
 * Сессия читается всегда вместе со своими вопросами: `PlacementSession.turns` входит
 * в контракт, и отдельного эндпоинта для вопросов нет.
 *
 * Колонка порядка вопроса называется `order` — это зарезервированное слово SQL,
 * поэтому в запросах она всегда в двойных кавычках.
 */
import type { Id, PlacementSession, PlacementTurn } from '@lt/shared';

import { getDb } from '../db/connection.js';
import {
  placementSessionToRow,
  placementTurnToRow,
  rowToPlacementSession,
  rowToPlacementTurn,
} from '../db/mappers.js';
import type { PlacementSessionRow, PlacementTurnRow } from '../db/rows.js';

/** Колонки `placement_sessions` в порядке, в котором их отдаёт `placementSessionToRow()`. */
const SESSION_COLUMNS = [
  'id',
  'status',
  'learning_language',
  'explanation_language',
  'max_turns',
  'result',
  'started_at',
  'completed_at',
  'created_at',
  'updated_at',
] as const;

const INSERT_SESSION_SQL = `INSERT INTO placement_sessions (${SESSION_COLUMNS.join(', ')})
  VALUES (${SESSION_COLUMNS.map((column) => `@${column}`).join(', ')})`;

/**
 * Обновление сессии перечисляет все колонки строки: better-sqlite3 требует,
 * чтобы каждый ключ переданного объекта имел параметр в запросе.
 */
const UPDATE_SESSION_SQL = `
  UPDATE placement_sessions
     SET status               = @status,
         learning_language    = @learning_language,
         explanation_language = @explanation_language,
         max_turns            = @max_turns,
         result               = @result,
         started_at           = @started_at,
         completed_at         = @completed_at,
         created_at           = @created_at,
         updated_at           = @updated_at
   WHERE id = @id
`;

const INSERT_TURN_SQL = `INSERT INTO placement_turns
  (id, session_id, "order", question, question_language, target_level, skill,
   answer, source, score, feedback, estimated_level, asked_at, answered_at)
  VALUES (@id, @session_id, @order, @question, @question_language, @target_level, @skill,
   @answer, @source, @score, @feedback, @estimated_level, @asked_at, @answered_at)`;

const UPDATE_TURN_SQL = `
  UPDATE placement_turns
     SET session_id        = @session_id,
         "order"           = @order,
         question          = @question,
         question_language = @question_language,
         target_level      = @target_level,
         skill             = @skill,
         answer            = @answer,
         source            = @source,
         score             = @score,
         feedback          = @feedback,
         estimated_level   = @estimated_level,
         asked_at          = @asked_at,
         answered_at       = @answered_at
   WHERE id = @id
`;

const SELECT_TURNS_SQL = `
  SELECT * FROM placement_turns WHERE session_id = ? ORDER BY "order" ASC
`;

/** Вопросы сессии в порядке, в котором их задавали. */
export function findPlacementTurns(sessionId: Id): PlacementTurn[] {
  const rows = getDb().prepare(SELECT_TURNS_SQL).all(sessionId) as PlacementTurnRow[];

  return rows.map(rowToPlacementTurn);
}

/** Сессия вместе с её вопросами; `undefined` — сессии нет. */
export function findPlacementSessionById(id: Id): PlacementSession | undefined {
  const row = getDb().prepare('SELECT * FROM placement_sessions WHERE id = ?').get(id) as
    PlacementSessionRow | undefined;

  return row === undefined ? undefined : rowToPlacementSession(row, findPlacementTurns(id));
}

/** Сохраняет новую сессию вместе с её вопросами (обычно их ещё нет) одной транзакцией. */
export function insertPlacementSession(session: PlacementSession): void {
  const db = getDb();
  const sessionRow = placementSessionToRow(session);
  const turnRows = session.turns.map((turn) => placementTurnToRow(turn));

  const insert = db.transaction((): void => {
    db.prepare(INSERT_SESSION_SQL).run(sessionRow);

    const insertTurn = db.prepare(INSERT_TURN_SQL);

    for (const row of turnRows) {
      insertTurn.run(row);
    }
  });

  insert();
}

/** Добавляет заданный вопрос к сессии и обновляет её `updated_at`. */
export function insertPlacementTurn(session: PlacementSession, turn: PlacementTurn): void {
  const db = getDb();
  const turnRow = placementTurnToRow(turn);
  const sessionRow = placementSessionToRow(session);

  const insert = db.transaction((): void => {
    db.prepare(INSERT_TURN_SQL).run(turnRow);
    db.prepare(UPDATE_SESSION_SQL).run(sessionRow);
  });

  insert();
}

/**
 * Сохраняет ход теста одной транзакцией: оценённый ответ, следующий вопрос
 * (если он есть) и состояние сессии. Ответ без записанной оценки — потерянный
 * вопрос ученика, поэтому части не разносятся по разным транзакциям.
 */
export function savePlacementProgress(
  session: PlacementSession,
  evaluatedTurn: PlacementTurn,
  nextTurn?: PlacementTurn,
): void {
  const db = getDb();
  const sessionRow = placementSessionToRow(session);
  const evaluatedRow = placementTurnToRow(evaluatedTurn);
  const nextRow = nextTurn === undefined ? undefined : placementTurnToRow(nextTurn);

  const save = db.transaction((): void => {
    db.prepare(UPDATE_TURN_SQL).run(evaluatedRow);

    if (nextRow !== undefined) {
      db.prepare(INSERT_TURN_SQL).run(nextRow);
    }

    db.prepare(UPDATE_SESSION_SQL).run(sessionRow);
  });

  save();
}

/** Обновляет изменяемые поля сессии: статус, итог, момент завершения. */
export function updatePlacementSession(session: PlacementSession): void {
  getDb().prepare(UPDATE_SESSION_SQL).run(placementSessionToRow(session));
}
