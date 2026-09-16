/**
 * Подключение к SQLite (better-sqlite3).
 *
 * На процесс приходится одно соединение: приложение однопользовательское и работает
 * с локальным файлом базы. `getDb()` открывает его лениво и сразу доводит схему
 * до актуальной версии, поэтому вызывающему коду не нужно помнить про миграции.
 * Тестам предназначены `openDatabase(IN_MEMORY_DB_PATH)` и `setDb()`.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { config } from 'dotenv';

import { migrate } from './migrate.js';

/** Соединение с базой. */
export type Db = Database.Database;

const moduleDir = dirname(fileURLToPath(import.meta.url));

// `npm run db:migrate` запускается отдельным процессом, без bootstrap из `src/index.ts`,
// поэтому `.env` читаем и здесь: dotenv не перетирает уже заданные переменные окружения.
// Кандидаты — запуск из исходников (`src/db/`) и из сборки (`dist/src/db/`).
// В тестах файл не читается — см. пояснение в `config/env.ts`.
if (process.env['NODE_ENV'] !== 'test') {
  config({
    path: [resolve(moduleDir, '../../../.env'), resolve(moduleDir, '../../../../.env')],
    quiet: true,
  });
}

/** Значение `DB_PATH`, включающее базу в памяти (используется в тестах). */
export const IN_MEMORY_DB_PATH = ':memory:';

/** Путь к файлу базы по умолчанию — относительно корня монорепо (каталог `data/` в .gitignore). */
export const DEFAULT_DB_RELATIVE_PATH = join('data', 'app.db');

/** Ищет корень монорепо: ближайший вверх по дереву `package.json` с полем `workspaces`. */
function findWorkspaceRoot(startDir: string): string | undefined {
  let current = startDir;

  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = join(current, 'package.json');

    if (existsSync(manifestPath)) {
      try {
        const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));

        if (typeof manifest === 'object' && manifest !== null && 'workspaces' in manifest) {
          return current;
        }
      } catch {
        // Нечитаемый package.json — не повод останавливать поиск, идём выше.
      }
    }

    const parent = dirname(current);

    if (parent === current) {
      break;
    }
    current = parent;
  }

  return undefined;
}

/** Проверяет, что путь означает базу в памяти, а не файл на диске. */
export function isInMemoryPath(dbPath: string): boolean {
  return dbPath === IN_MEMORY_DB_PATH || dbPath.startsWith('file::memory:');
}

/**
 * Путь к файлу базы: `DB_PATH` (относительный — от рабочего каталога процесса)
 * или `<корень монорепо>/data/app.db`.
 */
export function resolveDbPath(): string {
  const configured = process.env.DB_PATH?.trim();

  if (configured === undefined || configured === '') {
    return resolve(findWorkspaceRoot(moduleDir) ?? process.cwd(), DEFAULT_DB_RELATIVE_PATH);
  }

  return isInMemoryPath(configured) ? configured : resolve(configured);
}

/**
 * Открывает новое соединение и включает обязательные PRAGMA.
 * Миграции не применяет — это делает `getDb()` или `npm run db:migrate`.
 */
export function openDatabase(dbPath: string = resolveDbPath()): Db {
  const inMemory = isInMemoryPath(dbPath);

  if (!inMemory) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  if (!inMemory) {
    // WAL: чтения не блокируются записью; для базы в памяти журнал не применим.
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
  }
  // Без этого SQLite игнорирует внешние ключи и ON DELETE CASCADE.
  db.pragma('foreign_keys = ON');

  return db;
}

let instance: Db | undefined;

/** Соединение процесса: открывается при первом обращении и мигрируется до актуальной схемы. */
export function getDb(): Db {
  if (instance === undefined) {
    const db = openDatabase();

    migrate(db);
    instance = db;
  }

  return instance;
}

/** Подменяет соединение процесса (тесты). Предыдущее закрывается. */
export function setDb(db: Db): void {
  if (instance !== undefined && instance !== db) {
    instance.close();
  }
  instance = db;
}

/** Закрывает соединение процесса, если оно было открыто. */
export function closeDb(): void {
  if (instance !== undefined) {
    instance.close();
    instance = undefined;
  }
}
