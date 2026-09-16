/**
 * Запуск сервера приложения внутри главного процесса Electron.
 *
 * Сервер — обычный Fastify из `@lt/server`, собранный в один файл. Отдельным
 * процессом он не запускается намеренно: тогда пришлось бы следить за его
 * жизнью, портом и завершением, а выигрыша нет — главный процесс Electron это
 * тот же Node.
 *
 * Порт всегда выбирает ядро (`port: 0`): фиксированный номер рано или поздно
 * оказывается занят другой программой, а окно всё равно открывает тот адрес,
 * который вернул сервер.
 *
 * Конфигурация приходит переменными окружения — теми же, что у веб-версии
 * (см. `settingsToEnv`): своего пути настройки у сервера не появляется.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Минимум того, что нужно от собранного приложения Fastify. */
interface FastifyLike {
  listen: (options: { host: string; port: number }) => Promise<string>;
  close: () => Promise<void>;
  server: { address: () => { port: number } | string | null };
  log: { warn: (details: unknown, message: string) => void };
}

/** Что оболочка берёт у серверного бандла (см. `serverEntry.ts`). */
interface ServerModule {
  buildApp: (options?: { logger?: unknown }) => Promise<FastifyLike>;
  closeDb: () => void;
  recoverStuckMaterials: () => number;
}

/** Параметры запуска сервера. */
export interface BackendOptions {
  /** Переменные окружения сервера: результат `settingsToEnv`. */
  env: Record<string, string>;
  /** Файл журнала сервера. */
  logFile: string;
  /** Уровень журнала. */
  logLevel: string;
  /** Каталоги, которые нужно создать до старта (база, загрузки). */
  directories: string[];
}

/** Запущенный сервер. */
export interface Backend {
  /** Адрес, который открывает окно приложения. */
  url: string;
  /** Останавливает сервер и закрывает базу. */
  stop: () => Promise<void>;
}

/** Загружает серверный бандл, лежащий рядом с главным процессом. */
async function loadServerModule(): Promise<ServerModule> {
  // Адрес собирается на ходу: статический импорт сборщик попытался бы втянуть
  // сервер внутрь бандла оболочки, а он собирается отдельно.
  const moduleUrl = new URL('./server.mjs', import.meta.url).href;

  return (await import(moduleUrl)) as ServerModule;
}

/**
 * Поднимает сервер на свободном порту петли.
 *
 * @returns адрес сервера и способ его остановить.
 */
export async function startBackend(options: BackendOptions): Promise<Backend> {
  // Переменные проставляются до загрузки сервера: конфигурацию он разбирает
  // при первом импорте и запомнит её навсегда.
  Object.assign(process.env, options.env);

  for (const directory of options.directories) {
    mkdirSync(directory, { recursive: true });
  }

  mkdirSync(dirname(options.logFile), { recursive: true });

  const server = await loadServerModule();
  const app = await server.buildApp({
    // Вывод процесса в установленном приложении никто не видит, поэтому журнал
    // пишется в файл рядом с базой — его можно приложить к вопросу о проблеме.
    logger: { level: options.logLevel, file: options.logFile },
  });

  // Фоновая обработка материалов живёт в памяти процесса: закрытое посреди
  // распознавания окно оставило бы материал в статусе «обрабатывается» навсегда.
  const interrupted = server.recoverStuckMaterials();

  if (interrupted > 0) {
    app.log.warn({ materials: interrupted }, 'Обработка материалов прервана прошлым запуском');
  }

  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();

  if (address === null || typeof address === 'string') {
    await app.close();

    throw new Error('Сервер не сообщил порт, на котором он слушает');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: async (): Promise<void> => {
      await app.close();
      server.closeDb();
    },
  };
}
