/**
 * Доступ к таблицам `profile` и `level_history`.
 *
 * Слой знает только про строки таблиц (`ProfileRow`, `LevelHistoryRow`) и SQL:
 * перевод в доменные типы `@lt/shared` делают мапперы `db/mappers.ts`, а правила
 * (что считать сменой уровня, какие поля сбрасывать) — `services/profileService.ts`.
 *
 * Приложение однопользовательское: строка профиля ровно одна, с `id = PROFILE_ROW_ID`,
 * она создаётся миграцией. `saveProfileRow()` всё же умеет вставить её заново —
 * на случай, если базу правили в обход приложения.
 */
import type { LevelHistoryEntry } from '@lt/shared';

import { getDb } from '../db/connection.js';
import { levelHistoryEntryToRow, rowToLevelHistoryEntry } from '../db/mappers.js';
import { PROFILE_ROW_ID, type LevelHistoryRow, type ProfileRow } from '../db/rows.js';

const SELECT_PROFILE_SQL = `
  SELECT id, learning_language, interface_language, explanation_language,
         level, level_confidence, goals, interests, daily_minutes,
         onboarding_completed, placement_completed_at, created_at, updated_at
    FROM profile
   WHERE id = ?
`;

const UPDATE_PROFILE_SQL = `
  UPDATE profile
     SET learning_language      = @learning_language,
         interface_language     = @interface_language,
         explanation_language   = @explanation_language,
         level                  = @level,
         level_confidence       = @level_confidence,
         goals                  = @goals,
         interests              = @interests,
         daily_minutes          = @daily_minutes,
         onboarding_completed   = @onboarding_completed,
         placement_completed_at = @placement_completed_at,
         created_at             = @created_at,
         updated_at             = @updated_at
   WHERE id = @id
`;

const INSERT_PROFILE_SQL = `
  INSERT INTO profile (
    id, learning_language, interface_language, explanation_language,
    level, level_confidence, goals, interests, daily_minutes,
    onboarding_completed, placement_completed_at, created_at, updated_at
  ) VALUES (
    @id, @learning_language, @interface_language, @explanation_language,
    @level, @level_confidence, @goals, @interests, @daily_minutes,
    @onboarding_completed, @placement_completed_at, @created_at, @updated_at
  )
`;

const INSERT_LEVEL_HISTORY_SQL = `
  INSERT INTO level_history (
    id, from_level, to_level, direction, source,
    confidence, reason, metrics, changed_at, created_at
  ) VALUES (
    @id, @from_level, @to_level, @direction, @source,
    @confidence, @reason, @metrics, @changed_at, @created_at
  )
`;

const SELECT_LATEST_LEVEL_HISTORY_SQL = `
  SELECT id, from_level, to_level, direction, source,
         confidence, reason, metrics, changed_at, created_at
    FROM level_history
   ORDER BY changed_at DESC, created_at DESC
   LIMIT 1
`;

/** Дополнительные записи, которые нужно сохранить вместе с профилем. */
export interface SaveProfileOptions {
  /** Запись истории уровня: пишется в той же транзакции, что и сам профиль. */
  levelChange?: LevelHistoryEntry;
}

/** Строка профиля; `undefined` — строки нет (аномалия: её создаёт миграция). */
export function findProfileRow(): ProfileRow | undefined {
  return getDb().prepare(SELECT_PROFILE_SQL).get(PROFILE_ROW_ID) as ProfileRow | undefined;
}

/** Добавляет запись в историю уровня. */
export function insertLevelHistoryEntry(entry: LevelHistoryEntry): void {
  getDb().prepare(INSERT_LEVEL_HISTORY_SQL).run(levelHistoryEntryToRow(entry));
}

/** Последнее по времени изменение уровня; `undefined` — история пуста. */
export function findLatestLevelHistoryEntry(): LevelHistoryEntry | undefined {
  const row = getDb().prepare(SELECT_LATEST_LEVEL_HISTORY_SQL).get() as LevelHistoryRow | undefined;

  return row === undefined ? undefined : rowToLevelHistoryEntry(row);
}

/**
 * Сохраняет профиль (и, если передана, запись истории уровня) одной транзакцией:
 * изменение уровня не должно оставаться без обоснования в истории.
 */
export function saveProfileRow(row: ProfileRow, options: SaveProfileOptions = {}): void {
  const db = getDb();
  const { levelChange } = options;

  const save = db.transaction((): void => {
    const updated = db.prepare(UPDATE_PROFILE_SQL).run(row);

    if (updated.changes === 0) {
      db.prepare(INSERT_PROFILE_SQL).run(row);
    }

    if (levelChange !== undefined) {
      insertLevelHistoryEntry(levelChange);
    }
  });

  save();
}
