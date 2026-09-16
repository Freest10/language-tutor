/**
 * Запуск системных утилит (`pdftoppm`, `swiftc`, `tesseract`).
 *
 * Единственная точка, где приложение обращается к внешним программам, поэтому
 * правила заданы здесь один раз:
 * - только `execFile`, никогда `exec`: пути и аргументы уходят массивом и не
 *   проходят через оболочку, поэтому имя файла с `;` или `$(…)` остаётся именем
 *   файла, а не командой;
 * - у каждого запуска есть таймаут и предел вывода: зависший или разговорчивый
 *   процесс не должен подвешивать обработку материала;
 * - отсутствие программы (`ENOENT`) — это не сбой, а признак «возможность
 *   недоступна»: вызывающий код показывает человеку, чего не хватает.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Таймаут запуска по умолчанию, мс. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Предел вывода программы, байты: всё сверх него обрывает процесс. */
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Таймаут проверки наличия программы, мс: она должна отвечать сразу. */
const PROBE_TIMEOUT_MS = 5000;

/** Сколько символов вывода программы попадает в сообщение об ошибке. */
const MAX_DETAIL_LENGTH = 300;

/** Параметры запуска программы. */
export interface RunCommandOptions {
  /** Таймаут запуска, мс. */
  timeoutMs?: number;
  /** Предел суммарного вывода, байты. */
  maxOutputBytes?: number;
  /** Отмена извне. */
  signal?: AbortSignal | undefined;
}

/** Результат запуска программы. */
export interface CommandResult {
  stdout: string;
  stderr: string;
}

/** Неудачный запуск программы: несёт имя, код завершения и обрезанный вывод. */
export class CommandError extends Error {
  /** Имя программы, как её звали. */
  readonly command: string;
  /** Код завершения или системный код ошибки (`ENOENT`, `ETIMEDOUT`). */
  readonly code: string | number | null;
  /** Обрезанный `stderr`: попадает в лог, но не в ответ пользователю. */
  readonly stderr: string;

  constructor(
    command: string,
    message: string,
    options: { code?: string | number | null; stderr?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CommandError';
    this.command = command;
    this.code = options.code ?? null;
    this.stderr = options.stderr ?? '';
  }
}

/** Признак «программы нет в PATH»: единственная причина, которую лечат установкой. */
export function isCommandMissing(error: unknown): boolean {
  if (error instanceof CommandError) {
    return error.code === 'ENOENT';
  }

  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Обрезает вывод программы до длины, пригодной для сообщения об ошибке. */
function clampOutput(value: string): string {
  const text = value.trim();

  return text.length <= MAX_DETAIL_LENGTH ? text : `${text.slice(0, MAX_DETAIL_LENGTH)}…`;
}

/**
 * Запускает программу и возвращает её вывод.
 *
 * Аргументы передаются массивом: конкатенации пользовательского ввода в строку
 * команды здесь нет и быть не может.
 */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      maxBuffer: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      encoding: 'utf8',
      windowsHide: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    return { stdout, stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const stderr = clampOutput(failure.stderr ?? '');
    const code = failure.code ?? null;

    if (isCommandMissing(error)) {
      throw new CommandError(command, `Программа «${command}» не найдена в PATH`, {
        code: 'ENOENT',
        stderr,
        cause: error,
      });
    }

    throw new CommandError(
      command,
      `Программа «${command}» завершилась неудачей (${String(code)})` +
        (stderr === '' ? '' : `: ${stderr}`),
      { code, stderr, cause: error },
    );
  }
}

/** Кэш проверок наличия программ: `which` на каждую страницу PDF не нужен. */
const availability = new Map<string, Promise<boolean>>();

/**
 * Есть ли программа в PATH.
 *
 * Проверка — это сам запуск с безобидным аргументом: «нет программы» означает
 * ровно `ENOENT`, а ненулевой код возврата (у многих утилит `-v` пишет справку
 * и выходит с ошибкой) означает, что программа на месте.
 */
export async function isCommandAvailable(
  command: string,
  probeArgs: readonly string[] = ['-v'],
): Promise<boolean> {
  const cached = availability.get(command);

  if (cached !== undefined) {
    return cached;
  }

  const probe = runCommand(command, probeArgs, { timeoutMs: PROBE_TIMEOUT_MS })
    .then(() => true)
    .catch((error: unknown) => !isCommandMissing(error));

  availability.set(command, probe);

  return probe;
}

/** Сбрасывает кэш проверок (тесты и смена PATH внутри процесса). */
export function resetCommandAvailability(): void {
  availability.clear();
}
