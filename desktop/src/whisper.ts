/**
 * Встроенный распознаватель речи: процесс `whisper-server` из whisper.cpp.
 *
 * Зачем отдельный процесс, а не библиотека: whisper.cpp — это нативный код,
 * и запускать его рядом, по HTTP, безопаснее, чем тянуть в главный процесс
 * Electron нативный модуль, который придётся пересобирать под каждую версию.
 * Заодно у сервера приложения не появляется второго пути распознавания:
 * whisper.cpp отвечает по тому же OpenAI-совместимому протоколу
 * (`POST /v1/audio/transcriptions`), что и облачный сервис.
 *
 * Почему браузерное распознавание в десктопной сборке не используется:
 * `webkitSpeechRecognition` в Chromium отправляет звук в сервис Google по
 * ключам, которых у сборок Electron нет, — в окне приложения оно просто
 * не работает.
 *
 * Процесс всегда слушает только петлю: распознаватель принимает файлы без
 * какой-либо аутентификации, и в чужой сети ему делать нечего.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';

/** Сколько ждать готовности модели, миллисекунды. */
const READY_TIMEOUT_MS = 120_000;

/** Пауза между опросами готовности, миллисекунды. */
const READY_POLL_INTERVAL_MS = 250;

/** Сколько ждать штатного завершения процесса, прежде чем убить его. */
const STOP_TIMEOUT_MS = 5000;

/** Сколько последних строк журнала держать в памяти для сообщения об ошибке. */
const LOG_TAIL_LINES = 12;

/** Параметры запуска распознавателя. */
export interface WhisperOptions {
  /** Путь к `whisper-server`. */
  binPath: string;
  /** Путь к файлу модели `ggml-*.bin`. */
  modelPath: string;
  /** Порт; 0 — взять свободный. */
  port: number;
  /** Число потоков; 0 — оставить выбор whisper.cpp. */
  threads: number;
  /** Куда писать вывод процесса. */
  logFile: string;
}

/** Запущенный распознаватель. */
export interface WhisperProcess {
  /** Базовый адрес OpenAI-совместимого API: его получает сервер в `STT_BASE_URL`. */
  baseUrl: string;
  /** Останавливает процесс; повторный вызов безопасен. */
  stop: () => Promise<void>;
}

/** Ошибка запуска распознавателя с хвостом журнала процесса. */
export class WhisperStartError extends Error {
  override readonly name = 'WhisperStartError';

  /** Последние строки вывода процесса — единственная понятная диагностика. */
  readonly output: string;

  constructor(message: string, output = '') {
    super(message);
    this.output = output;
  }
}

/** Свободный порт на петле: его занимает ядро до момента закрытия сокета. */
export async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();

    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();

      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('Не удалось определить свободный порт'));

        return;
      }

      const { port } = address;

      probe.close(() => {
        resolve(port);
      });
    });
  });
}

/** Аргументы командной строки `whisper-server`. */
export function whisperArgs(options: {
  modelPath: string;
  port: number;
  threads: number;
}): string[] {
  const args = [
    '--model',
    options.modelPath,
    '--host',
    '127.0.0.1',
    '--port',
    String(options.port),
    // Приложение обращается к `POST /v1/audio/transcriptions`: тот же путь, что
    // у облачного OpenAI, поэтому провайдер в сервере нужен ровно один.
    '--request-path',
    '/v1',
    '--inference-path',
    '/audio/transcriptions',
    // Вероятности языков — лишний проход по записи на каждую реплику; язык
    // приложение и так передаёт полем `language`.
    '--no-language-probabilities',
  ];

  if (options.threads > 0) {
    args.push('--threads', String(options.threads));
  }

  return args;
}

/** Ждёт, пока распознаватель ответит на `/health`, или объясняет, почему не дождались. */
async function waitForReady(
  baseUrl: string,
  isAlive: () => boolean,
  tail: () => string,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (!isAlive()) {
      throw new WhisperStartError('Распознаватель речи завершился при запуске', tail());
    }

    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });

      if (response.ok) {
        return;
      }
    } catch {
      // Ещё не слушает порт: модель грузится с диска несколько секунд.
    }

    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }

  throw new WhisperStartError(
    `Распознаватель речи не ответил за ${Math.round(READY_TIMEOUT_MS / 1000)} с`,
    tail(),
  );
}

/**
 * Запускает `whisper-server` и возвращает управление, когда модель загружена.
 *
 * @throws {WhisperStartError} если файлов нет, процесс упал или не ответил.
 */
export async function startWhisper(options: WhisperOptions): Promise<WhisperProcess> {
  if (!existsSync(options.binPath)) {
    throw new WhisperStartError(`Не найден распознаватель речи: ${options.binPath}`);
  }

  if (!existsSync(options.modelPath)) {
    throw new WhisperStartError(`Не найден файл модели распознавания: ${options.modelPath}`);
  }

  const port = options.port > 0 ? options.port : await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  mkdirSync(dirname(options.logFile), { recursive: true });

  const logStream = createWriteStream(options.logFile, { flags: 'a' });
  const child: ChildProcess = spawn(
    options.binPath,
    whisperArgs({ modelPath: options.modelPath, port, threads: options.threads }),
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );

  let alive = true;
  let recentLines: string[] = [];

  const remember = (chunk: Buffer): void => {
    logStream.write(chunk);
    recentLines = [...recentLines, ...chunk.toString('utf8').split('\n')].slice(-LOG_TAIL_LINES);
  };

  child.stdout?.on('data', remember);
  child.stderr?.on('data', remember);
  child.once('exit', () => {
    alive = false;
    logStream.end();
  });
  child.once('error', (error) => {
    alive = false;
    recentLines.push(String(error));
  });

  const tail = (): string => recentLines.join('\n').trim();

  try {
    await waitForReady(baseUrl, () => alive, tail);
  } catch (error) {
    child.kill('SIGKILL');

    throw error;
  }

  let stopped = false;

  return {
    baseUrl,
    stop: async (): Promise<void> => {
      if (stopped || !alive) {
        return;
      }

      stopped = true;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, STOP_TIMEOUT_MS);

        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });

        child.kill();
      });
    },
  };
}
