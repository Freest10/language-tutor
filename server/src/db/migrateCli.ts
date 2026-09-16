/**
 * `npm run db:migrate`: применяет миграции к файлу базы из `DB_PATH`.
 *
 * Отдельный файл, а не хвост `migrate.ts`: раннер миграций импортирует и сервер
 * при старте, и тесты, поэтому запуск из командной строки обязан жить там, где
 * его не подхватит ни один импорт.
 */
import { openDatabase, resolveDbPath } from './connection.js';
import { migrate } from './migrate.js';

/** Применяет миграции и рассказывает, что именно сделано. */
export function main(): void {
  const dbPath = resolveDbPath();
  const db = openDatabase(dbPath);

  try {
    const { from, to, applied } = migrate(db);

    if (applied.length === 0) {
      console.log(`[db:migrate] схема актуальна (версия ${to}), база: ${dbPath}`);

      return;
    }

    for (const migration of applied) {
      console.log(`[db:migrate] применена ${migration.name}`);
    }
    console.log(`[db:migrate] версия схемы ${from} → ${to}, база: ${dbPath}`);
  } finally {
    db.close();
  }
}

main();
