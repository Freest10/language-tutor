/**
 * Где у десктопной сборки лежат файлы.
 *
 * Два разных места, которые легко перепутать:
 * - код и данные приложения (`app.asar`) — только для чтения, туда нельзя
 *   писать ни базу, ни загруженные материалы;
 * - каталог пользователя (`app.getPath('userData')`) — там живут база, файлы
 *   материалов, настройки и журналы, и он переживает переустановку программы.
 *
 * Бинарник whisper.cpp и файл модели в asar не кладутся: запустить программу
 * из архива нельзя, а модель весом в сотню мегабайт незачем читать через
 * виртуальную файловую систему. Они лежат рядом, в `resources`.
 *
 * Функция `resolvePaths` намеренно ничего не знает про Electron: все каталоги
 * приходят аргументами, поэтому раскладку можно проверить тестом.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Каталоги, от которых считается всё остальное. */
export interface PathsInput {
  /** Каталог приложения: `app.getAppPath()` (в сборке — `…/app.asar`). */
  appDir: string;
  /** Каталог ресурсов рядом с приложением: `process.resourcesPath`. */
  resourcesDir: string;
  /** Каталог пользователя: `app.getPath('userData')`. */
  userDataDir: string;
  /** Платформа: от неё зависит имя исполняемого файла whisper.cpp. */
  platform: NodeJS.Platform;
}

/** Полная раскладка файлов десктопной сборки. */
export interface DesktopPaths {
  /** Файл настроек, который правит пользователь. */
  settingsFile: string;
  /** Каталог с базой и загруженными материалами. */
  dataDir: string;
  /** Файл базы SQLite. */
  dbFile: string;
  /** Каталог загруженных материалов. */
  uploadDir: string;
  /** Каталог журналов сервера и распознавателя. */
  logDir: string;
  /** Журнал сервера. */
  serverLogFile: string;
  /** Журнал whisper.cpp. */
  whisperLogFile: string;
  /** Собранный веб-интерфейс, который раздаёт сервер. */
  webDistDir: string;
  /** Страница-заглушка, которую видно, пока сервер поднимается. */
  loadingFile: string;
  /**
   * Иконка приложения.
   *
   * Установленной версии она не нужна — иконку несёт сам пакет программы.
   * Нужна при запуске из исходников: там в доке иначе висит логотип Electron,
   * и понять, какое из окон твоё, невозможно.
   */
  appIconFile: string;
  /** Исполняемый файл whisper.cpp. */
  whisperBin: string;
  /** Каталог моделей whisper.cpp внутри сборки. */
  whisperModelDir: string;
  /**
   * Каталог вспомогательных скриптов распознавания (`macos-ocr.swift`).
   * Лежит рядом с приложением, а не внутри архива: компилятору Swift нужен
   * обычный файл на диске.
   */
  scriptsDir: string;
  /** Каталог моделей whisper.cpp, куда пользователь кладёт свои. */
  userModelDir: string;
}

/** Имя исполняемого файла whisper.cpp для платформы. */
export function whisperBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
}

/** Считает раскладку файлов от каталогов приложения и пользователя. */
export function resolvePaths(input: PathsInput): DesktopPaths {
  const { appDir, resourcesDir, userDataDir, platform } = input;
  const appBuildDir = join(appDir, 'build', 'app');
  const dataDir = join(userDataDir, 'data');
  const logDir = join(userDataDir, 'logs');
  const whisperDir = join(resourcesDir, 'whisper');

  return {
    settingsFile: join(userDataDir, 'settings.json'),
    dataDir,
    dbFile: join(dataDir, 'app.db'),
    uploadDir: join(dataDir, 'uploads'),
    logDir,
    serverLogFile: join(logDir, 'server.log'),
    whisperLogFile: join(logDir, 'whisper.log'),
    webDistDir: join(appBuildDir, 'web'),
    loadingFile: join(appBuildDir, 'loading.html'),
    appIconFile: join(appDir, 'build-assets', 'icon.png'),
    whisperBin: join(whisperDir, whisperBinaryName(platform)),
    whisperModelDir: join(whisperDir, 'models'),
    scriptsDir: join(resourcesDir, 'scripts'),
    userModelDir: join(userDataDir, 'models'),
  };
}

/** Где искать файл модели распознавания. */
export interface ModelSearchDirs {
  /** Каталог пользователя: сюда кладут свою модель, она в приоритете. */
  userModelDir: string;
  /** Каталог моделей внутри сборки: там лежит модель из установщика. */
  bundledModelDir: string;
}

/**
 * Путь к файлу модели whisper.cpp.
 *
 * Абсолютный путь берётся как есть. Имя файла ищется сначала в каталоге
 * пользователя: так модель побольше, положенную рядом с настройками, не
 * затирает переустановка приложения, а модель из установщика остаётся
 * значением по умолчанию.
 */
export function resolveWhisperModel(model: string, dirs: ModelSearchDirs): string {
  if (isAbsolute(model)) {
    return model;
  }

  const userCopy = join(dirs.userModelDir, model);

  return existsSync(userCopy) ? userCopy : join(dirs.bundledModelDir, model);
}
