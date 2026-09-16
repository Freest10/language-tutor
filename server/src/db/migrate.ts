/**
 * Раннер SQL-миграций.
 *
 * Миграции — нумерованные файлы `NNN_name.sql` в `src/db/migrations`, применяются
 * по возрастанию версии внутри транзакции; применённая версия хранится в `PRAGMA user_version`.
 * Запуск идемпотентен: повторный вызов на актуальной базе не выполняет ни одного файла.
 *
 * Точки входа: `getDb()` (старт приложения) и `npm run db:migrate` (`migrateCli.ts`).
 *
 * Сам файл ничего не выполняет при импорте: запуск из командной строки живёт
 * в `migrateCli.ts`. Иначе сборка сервера в один файл (десктопная версия)
 * применяла бы миграции просто потому, что модуль оказался внутри бандла.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Взаимный импорт с `connection.ts` намеренный: обе стороны обращаются к чужим функциям
// только во время вызова, поэтому порядок инициализации модулей значения не имеет.
import type { Db } from './connection.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));

// `tsc` не копирует `.sql` в `dist`, поэтому собранный сервер читает миграции из исходников.
const MIGRATIONS_DIR_CANDIDATES = [
  resolve(moduleDir, 'migrations'),
  resolve(moduleDir, '../../../src/db/migrations'),
];

const MIGRATION_FILE_PATTERN = /^(\d{3,})_[a-z0-9_]+\.sql$/;

/** Миграция, готовая к применению. */
export interface Migration {
  /** Номер из имени файла: он же значение `PRAGMA user_version` после применения. */
  version: number;
  /** Имя файла без каталога. */
  name: string;
  sql: string;
}

/** Результат прогона миграций. */
export interface MigrationResult {
  /** Версия схемы до прогона. */
  from: number;
  /** Версия схемы после прогона. */
  to: number;
  /** Применённые миграции в порядке применения; пустой список — база уже актуальна. */
  applied: Migration[];
}

/** Каталог с файлами миграций. */
export function resolveMigrationsDir(): string {
  const found = MIGRATIONS_DIR_CANDIDATES.find((candidate) => existsSync(candidate));

  if (found === undefined) {
    throw new Error(`Каталог миграций не найден: ${MIGRATIONS_DIR_CANDIDATES.join(', ')}`);
  }

  return found;
}

/** Читает файлы миграций и сортирует их по возрастанию версии. */
export function loadMigrations(migrationsDir: string = resolveMigrationsDir()): Migration[] {
  const migrations = readdirSync(migrationsDir)
    .map((name) => ({ name, match: MIGRATION_FILE_PATTERN.exec(name) }))
    .filter((entry) => entry.match !== null)
    .map(({ name, match }) => ({
      version: Number.parseInt(match?.[1] ?? '0', 10),
      name,
      sql: readFileSync(join(migrationsDir, name), 'utf8'),
    }))
    .sort((left, right) => left.version - right.version);

  const versions = new Set<number>();

  for (const migration of migrations) {
    if (migration.version < 1) {
      throw new Error(`Миграция ${migration.name}: номер должен начинаться с 001`);
    }
    if (versions.has(migration.version)) {
      throw new Error(`Дублирующийся номер миграции: ${migration.version}`);
    }
    versions.add(migration.version);
  }

  return migrations;
}

/** Текущая версия схемы: 0 — миграции ещё не применялись. */
export function getSchemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Применяет миграции с версией больше текущей. Каждый файл выполняется в отдельной
 * транзакции вместе с обновлением `user_version`: прерванный прогон не оставит
 * половину схемы с уже поднятой версией.
 */
export function migrate(db: Db, migrations: Migration[] = loadMigrations()): MigrationResult {
  const from = getSchemaVersion(db);
  const applied: Migration[] = [];

  for (const migration of migrations) {
    if (migration.version <= from) {
      continue;
    }

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      // PRAGMA не принимает подстановки, поэтому номер берём из уже разобранного числа.
      db.pragma(`user_version = ${migration.version}`);
    });

    apply();
    applied.push(migration);
  }

  return { from, to: getSchemaVersion(db), applied };
}
