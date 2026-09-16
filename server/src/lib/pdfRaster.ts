/**
 * Растеризация страниц PDF во временные PNG — первый шаг распознавания сканов.
 *
 * Работу делает `pdftoppm` из poppler: рисовать PDF самостоятельно приложение не
 * умеет и не должно, а poppler уже стоит везде, где есть просмотрщик PDF.
 * Отсутствие утилиты — не сбой, а отключённая возможность: `isRasterizerAvailable()`
 * проверяется до начала работы, чтобы пользователь увидел «поставьте poppler»,
 * а не стек вызова.
 *
 * Картинки страниц живут только на время обработки: они не хранятся рядом с
 * материалом (приложение не копит бинарные данные) и удаляются вместе с
 * временным каталогом — см. `withRasterizedPdf()`.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isCommandAvailable, runCommand, type RunCommandOptions } from './exec.js';

/** Имя утилиты растеризации; подменяется только тестами. */
let rasterizerCommand = 'pdftoppm';

/** Текущее имя утилиты растеризации. */
export function getRasterizerCommand(): string {
  return rasterizerCommand;
}

/** Подменяет утилиту растеризации (тесты) — по образцу `setUploadDir()`. */
export function setRasterizerCommand(command: string): void {
  rasterizerCommand = command;
}

/** Префикс имени выходных файлов: `page-1.png`, `page-01.png` и так далее. */
const OUTPUT_PREFIX = 'page';

/** Имя страницы, которое даёт `pdftoppm`: ширина номера зависит от числа страниц. */
const OUTPUT_PATTERN = new RegExp(String.raw`^${OUTPUT_PREFIX}-(\d+)\.png$`, 'u');

/** Запас времени на страницу, мс: на медленном диске 150 dpi укладываются в доли секунды. */
const MS_PER_PAGE = 5000;

/** Нижняя граница таймаута растеризации, мс. */
const MIN_TIMEOUT_MS = 60_000;

/** Растеризованная страница. */
export interface RasterizedPage {
  /** Номер страницы в документе, с единицы. */
  page: number;
  /** Путь к PNG во временном каталоге. */
  path: string;
}

/** Параметры растеризации. */
export interface RasterizeOptions {
  /** Разрешение, точек на дюйм. */
  dpi: number;
  /** Сколько первых страниц растеризовать. */
  maxPages: number;
  /** Каталог для PNG: создаётся и удаляется вызывающим кодом. */
  outDir: string;
  /** Отмена извне. */
  signal?: AbortSignal | undefined;
}

/** Есть ли в системе утилита растеризации. */
export function isRasterizerAvailable(): Promise<boolean> {
  return isCommandAvailable(rasterizerCommand);
}

/**
 * Растеризует первые `maxPages` страниц PDF в PNG внутри `outDir`.
 *
 * Путь к файлу уходит отдельным аргументом `execFile`, без оболочки: имя файла
 * не может стать частью команды.
 */
export async function rasterizePdf(
  filePath: string,
  options: RasterizeOptions,
): Promise<RasterizedPage[]> {
  const commandOptions: RunCommandOptions = {
    timeoutMs: Math.max(MIN_TIMEOUT_MS, options.maxPages * MS_PER_PAGE),
    signal: options.signal,
  };

  await runCommand(
    rasterizerCommand,
    [
      '-r',
      String(options.dpi),
      '-png',
      '-f',
      '1',
      '-l',
      String(options.maxPages),
      filePath,
      join(options.outDir, OUTPUT_PREFIX),
    ],
    commandOptions,
  );

  const entries = await readdir(options.outDir);
  const pages: RasterizedPage[] = [];

  for (const entry of entries) {
    const match = OUTPUT_PATTERN.exec(entry);

    if (match !== null) {
      pages.push({ page: Number(match[1]), path: join(options.outDir, entry) });
    }
  }

  return pages.sort((left, right) => left.page - right.page);
}

/**
 * Растеризует PDF во временный каталог, отдаёт страницы обработчику и убирает
 * каталог за собой — независимо от того, чем закончилась обработка.
 */
export async function withRasterizedPdf<Result>(
  filePath: string,
  options: Omit<RasterizeOptions, 'outDir'>,
  handler: (pages: RasterizedPage[]) => Promise<Result>,
): Promise<Result> {
  const outDir = await mkdtemp(join(tmpdir(), 'lt-scan-'));

  try {
    return await handler(await rasterizePdf(filePath, { ...options, outDir }));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}
