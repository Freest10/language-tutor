/**
 * Распознавание текста средствами macOS Vision (`VNRecognizeTextRequest`).
 *
 * Фреймворк доступен только из нативного кода, поэтому работу делает крошечный
 * помощник на Swift (`server/scripts/macos-ocr.swift`), который принимает путь к
 * PNG и печатает распознанные строки.
 *
 * Помощник КОМПИЛИРУЕТСЯ ОДИН РАЗ и кладётся в кэш рядом с каталогом загрузок:
 * запуск через `swift macos-ocr.swift` стоит ~3.5 с на страницу (каждый раз
 * заново поднимается компилятор), собранный бинарь — ~0.3 с. Пересборка нужна
 * только когда исходник новее бинаря.
 */
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { env } from '../../config/env.js';
import { isCommandAvailable, runCommand } from '../exec.js';

import type { OcrBackend } from './types.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Имя исходника помощника. */
const HELPER_SOURCE_NAME = 'macos-ocr.swift';

/** Имя собранного помощника в кэше. */
const HELPER_BINARY_NAME = 'macos-ocr';

/** Компилятор Swift: без него помощника не собрать. */
const SWIFT_COMPILER = 'swiftc';

/** Таймаут сборки помощника, мс (на этой машине укладывается в секунду). */
const COMPILE_TIMEOUT_MS = 120_000;

/** Таймаут распознавания одной страницы, мс. */
const RECOGNIZE_TIMEOUT_MS = 120_000;

// Кандидаты — запуск из исходников (`src/lib/ocr/`) и из сборки (`dist/src/lib/ocr/`).
const SCRIPTS_DIR_CANDIDATES = [
  resolve(moduleDir, '../../../scripts'),
  resolve(moduleDir, '../../../../scripts'),
];

/** Путь к исходнику помощника; `undefined` — файла нет (обрезанная установка). */
function findHelperSource(): string | undefined {
  return SCRIPTS_DIR_CANDIDATES.map((directory) => join(directory, HELPER_SOURCE_NAME)).find(
    (candidate) => existsSync(candidate),
  );
}

/**
 * Каталог собранных помощников.
 *
 * По умолчанию — `bin/` рядом с каталогом загрузок (то есть `data/bin/`): это
 * уже существующий каталог данных приложения, попадающий под общую очистку.
 */
let cacheDir = join(dirname(env.uploadDir), 'bin');

/** Текущий каталог собранных помощников. */
export function getOcrCacheDir(): string {
  return cacheDir;
}

/** Подменяет каталог собранных помощников (тесты) — по образцу `setUploadDir()`. */
export function setOcrCacheDir(directory: string): void {
  cacheDir = resolve(directory);
  compilation = undefined;
}

/** Идущая сборка: параллельные страницы не должны запускать `swiftc` дважды. */
let compilation: Promise<string> | undefined;

/** Время изменения файла; `undefined` — файла нет. */
async function modifiedAt(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Собирает помощника, если бинаря нет или он старше исходника. */
async function compileHelper(): Promise<string> {
  const source = findHelperSource();

  if (source === undefined) {
    throw new Error(`Не найден исходник помощника OCR (${HELPER_SOURCE_NAME})`);
  }

  const binary = join(cacheDir, HELPER_BINARY_NAME);
  const [sourceTime, binaryTime] = await Promise.all([modifiedAt(source), modifiedAt(binary)]);

  if (binaryTime !== undefined && sourceTime !== undefined && binaryTime >= sourceTime) {
    return binary;
  }

  await mkdir(cacheDir, { recursive: true });
  await runCommand(SWIFT_COMPILER, ['-O', source, '-o', binary], {
    timeoutMs: COMPILE_TIMEOUT_MS,
  });

  return binary;
}

/** Путь к готовому помощнику: сборка выполняется не более одного раза на процесс. */
function ensureHelper(): Promise<string> {
  if (compilation === undefined) {
    compilation = compileHelper().catch((error: unknown) => {
      // Неудачную сборку не кэшируем: следующая страница попробует ещё раз
      // (например, после установки Command Line Tools).
      compilation = undefined;

      throw error;
    });
  }

  return compilation;
}

/** Распознавание средствами macOS Vision: только на macOS и только со Swift. */
export const macosVisionBackend: OcrBackend = {
  name: 'macos-vision',

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'darwin' || findHelperSource() === undefined) {
      return false;
    }

    // Готовый бинарь достаточен: компилятор мог быть удалён после сборки.
    if (existsSync(join(cacheDir, HELPER_BINARY_NAME))) {
      return true;
    }

    return isCommandAvailable(SWIFT_COMPILER, ['--version']);
  },

  async recognize(imagePath: string, langs: readonly string[]): Promise<string> {
    const binary = await ensureHelper();
    const args = langs.length === 0 ? [imagePath] : [imagePath, langs.join(',')];
    const { stdout } = await runCommand(binary, args, { timeoutMs: RECOGNIZE_TIMEOUT_MS });

    return stdout;
  },
};
