/**
 * Поиск системных утилит, которыми пользуется сервер (`pdftoppm`, `tesseract`,
 * `swiftc`).
 *
 * Приложение, запущенное из Dock или меню «Пуск», наследует не ту переменную
 * PATH, что терминал: в macOS графическим программам достаётся короткий
 * системный список без `/opt/homebrew/bin`, и установленный через Homebrew
 * poppler оказывается «не найден» — при том, что в терминале он прекрасно
 * работает. Поэтому к PATH добавляются обычные места установки.
 *
 * Список закрытый и добавляется в конец: подменить системную утилиту чем-то
 * посторонним это не позволяет, а найти установленную — да.
 */
import { existsSync } from 'node:fs';

/** Где на macOS и Linux обычно лежат утилиты, поставленные пакетным менеджером. */
const UNIX_TOOL_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  '/usr/bin',
  '/bin',
];

/** Где их обычно ставят в Windows. */
const WINDOWS_TOOL_DIRS = [
  'C:\\Program Files\\Tesseract-OCR',
  'C:\\Program Files\\poppler\\Library\\bin',
  'C:\\ProgramData\\chocolatey\\bin',
];

/**
 * Чем разделяются каталоги в PATH: в Windows точкой с запятой.
 *
 * Берётся у платформы из аргумента, а не у той, где запущен код: иначе
 * функцию нельзя проверить тестом для чужой платформы.
 */
function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

/** Каталоги, в которые стоит заглянуть на этой платформе. */
export function commonToolDirs(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? WINDOWS_TOOL_DIRS : UNIX_TOOL_DIRS;
}

/**
 * Дополняет PATH обычными местами установки утилит.
 *
 * @param currentPath значение PATH процесса; `undefined` — его нет вовсе.
 * @param platform платформа, определяющая список каталогов.
 * @param exists проверка существования каталога (подменяется в тестах).
 * @returns PATH, в котором каждый каталог встречается один раз.
 */
export function withCommonToolPaths(
  currentPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  const separator = pathDelimiter(platform);
  const parts = (currentPath ?? '').split(separator).filter((part) => part.length > 0);
  const known = new Set(parts);

  for (const directory of commonToolDirs(platform)) {
    if (!known.has(directory) && exists(directory)) {
      parts.push(directory);
      known.add(directory);
    }
  }

  return parts.join(separator);
}
