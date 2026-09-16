/**
 * Главный процесс Electron: поднимает сервер и распознаватель, открывает окно.
 *
 * Порядок запуска важен и виден целиком:
 *   настройки → whisper.cpp → сервер приложения → окно на его адресе.
 * Сервер получает адрес уже запущенного распознавателя, потому что разбирает
 * конфигурацию один раз при первом импорте, — после старта менять её нечем.
 *
 * Окно открывает `http://127.0.0.1:<порт>`, а не файл со сборкой: интерфейс
 * и API оказываются на одном источнике, поэтому нет ни прокси, ни CORS, а
 * микрофон работает — `127.0.0.1` браузер считает надёжным источником, в
 * отличие от `file://`.
 *
 * Отказ распознавателя не мешает уроку: приложение продолжает работу с текстовым
 * вводом и говорит, что именно сломалось. Отказ сервера — это отказ всего:
 * окно показывать нечего, приложение объясняет причину и закрывается.
 */
import { join } from 'node:path';

import { app, BrowserWindow, dialog, Menu, nativeImage, session, shell } from 'electron';

import { existsSync } from 'node:fs';

import { startBackend, type Backend } from './backend.js';
import { buildMenu } from './menu.js';
import { resolvePaths, resolveWhisperModel, type DesktopPaths } from './paths.js';
import { loadSettings, settingsToEnv, type DesktopSettings } from './settings.js';
import { withCommonToolPaths } from './toolPath.js';
import { startWhisper, WhisperStartError, type WhisperProcess } from './whisper.js';

/**
 * Имя приложения: от него зависит каталог с базой и настройками.
 * Задаётся явно, чтобы у сборки и у запуска из исходников он был один и тот же.
 */
const APP_NAME = 'language-tutor';

/** Размеры окна: меньше 900 точек интерфейс урока верстается тесно. */
const WINDOW_SIZE = { width: 1280, height: 860, minWidth: 900, minHeight: 640 };

// Имя и каталог данных задаются до готовности приложения: Electron считает путь
// к данным один раз, и после `whenReady` менять его поздно. Без этого запуск из
// исходников уехал бы в каталог с именем пакета (`@lt/desktop`), а установленная
// версия — в свой: одно и то же приложение работало бы с двумя разными базами.
app.setName(APP_NAME);
app.setPath('userData', join(app.getPath('appData'), APP_NAME));

let mainWindow: BrowserWindow | null = null;
let backend: Backend | null = null;
let whisper: WhisperProcess | null = null;
let paths: DesktopPaths;

/** Разрешения, которые окно может запрашивать: только микрофон. */
function restrictPermissions(): void {
  const granted = new Set(['media', 'audioCapture']);

  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    // Камера приложению не нужна ни для чего: разрешаем только звук.
    const wantsVideo =
      'mediaTypes' in details && (details.mediaTypes ?? []).includes('video' as never);

    callback(granted.has(permission) && !wantsVideo);
  });

  session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
    granted.has(permission),
  );
}

/** Открывает внешние ссылки в системном браузере, а не внутри приложения. */
function keepNavigationInside(window: BrowserWindow, appUrl: string): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }

    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(appUrl)) {
      return;
    }

    event.preventDefault();

    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
  });
}

/**
 * Иконка приложения для запуска из исходников; `undefined` — в сборке.
 *
 * У установленной версии иконку несёт сам пакет программы, а при запуске из
 * исходников её место занимает логотип Electron — и приложение в доке выглядит
 * чужим. Windows и Linux берут иконку из окна, macOS — из дока.
 */
function developmentIcon(): Electron.NativeImage | undefined {
  if (app.isPackaged || !existsSync(paths.appIconFile)) {
    return undefined;
  }

  const icon = nativeImage.createFromPath(paths.appIconFile);

  return icon.isEmpty() ? undefined : icon;
}

/** Создаёт окно приложения с заглушкой на время запуска сервера. */
function createWindow(): BrowserWindow {
  const icon = developmentIcon();
  const window = new BrowserWindow({
    ...WINDOW_SIZE,
    title: APP_NAME,
    ...(icon === undefined ? {} : { icon }),
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      // Своего кода в странице нет: окно открывает обычный веб-интерфейс,
      // поэтому ни доступа к Node, ни preload-моста ему не нужно.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  return window;
}

/** Запускает распознаватель; `null` — он выключен или не смог запуститься. */
async function startSpeechRecognition(
  settings: DesktopSettings,
): Promise<{ process: WhisperProcess | null; failure: string | null }> {
  if (settings.stt.mode !== 'local') {
    return { process: null, failure: null };
  }

  try {
    const process = await startWhisper({
      binPath: paths.whisperBin,
      modelPath: resolveWhisperModel(settings.whisper.model, {
        userModelDir: paths.userModelDir,
        bundledModelDir: paths.whisperModelDir,
      }),
      port: settings.whisper.port,
      threads: settings.whisper.threads,
      logFile: paths.whisperLogFile,
    });

    return { process, failure: null };
  } catch (error) {
    const details =
      error instanceof WhisperStartError && error.output.length > 0 ? `\n\n${error.output}` : '';

    return { process: null, failure: `${(error as Error).message}${details}` };
  }
}

/** Поднимает всё, что нужно окну, и открывает его. */
async function bootstrap(): Promise<void> {
  paths = resolvePaths({
    appDir: app.getAppPath(),
    // В установленном приложении распознаватель кладёт рядом `extraResources`,
    // при запуске из исходников он лежит в `desktop/resources`.
    resourcesDir: app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'),
    userDataDir: app.getPath('userData'),
    platform: process.platform,
  });

  const { settings, issues, created } = loadSettings(paths.settingsFile);

  const icon = developmentIcon();

  if (icon !== undefined && process.platform === 'darwin') {
    app.dock?.setIcon(icon);
  }

  restrictPermissions();
  Menu.setApplicationMenu(
    buildMenu(
      { settingsFile: paths.settingsFile, dataDir: paths.dataDir, logDir: paths.logDir },
      () => mainWindow,
    ),
  );

  mainWindow = createWindow();
  await mainWindow.loadFile(paths.loadingFile);

  const speech = await startSpeechRecognition(settings);

  whisper = speech.process;

  try {
    backend = await startBackend({
      env: {
        ...settingsToEnv(settings, paths, { whisperBaseUrl: whisper?.baseUrl ?? null }),
        // Распознавание сканов зовёт системные утилиты (`pdftoppm`, `tesseract`,
        // `swiftc`), а приложению из Dock достаётся короткий системный PATH
        // без каталогов пакетных менеджеров.
        PATH: withCommonToolPaths(process.env.PATH),
      },
      logFile: paths.serverLogFile,
      logLevel: settings.logLevel,
      directories: [paths.dataDir, paths.uploadDir, paths.logDir],
    });
  } catch (error) {
    dialog.showErrorBox(
      'Приложение не запустилось',
      [
        'Не удалось запустить сервер приложения.',
        String((error as Error).message),
        '',
        `Журнал: ${paths.serverLogFile}`,
      ].join('\n'),
    );
    app.quit();

    return;
  }

  keepNavigationInside(mainWindow, backend.url);
  await mainWindow.loadURL(backend.url);

  // Разговор с окном начинается только после того, как оно уже открыто:
  // модальное окно поверх заглушки выглядело бы как отказ запуска.
  if (issues.length > 0) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Настройки прочитаны не полностью',
      message: 'Часть настроек заменена значениями по умолчанию.',
      detail: [...issues, '', `Файл: ${paths.settingsFile}`].join('\n'),
    });
  }

  if (speech.failure !== null) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Распознавание речи недоступно',
      message: 'Голосовой ввод в этом запуске работать не будет; текстом — как обычно.',
      detail: [speech.failure, '', `Журнал: ${paths.whisperLogFile}`].join('\n'),
    });
  }

  if (created) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Первый запуск',
      message: 'Создан файл настроек со значениями по умолчанию.',
      detail: [
        'Языковая модель по умолчанию — Ollama на этом же компьютере',
        `(${settings.llm.baseUrl}, модель ${settings.llm.model}).`,
        'Другой адрес или облачный ключ задаются в меню «Файл → Настройки…».',
        '',
        `Файл: ${paths.settingsFile}`,
      ].join('\n'),
    });
  }
}

/** Останавливает сервер и распознаватель перед выходом. */
async function shutdown(): Promise<void> {
  await backend?.stop().catch(() => undefined);
  await whisper?.stop().catch(() => undefined);
  backend = null;
  whisper = null;
}

/**
 * Второй экземпляр приложения работать не должен: база SQLite одна, и два
 * процесса писали бы в неё наперегонки. Вместо запуска — окно уже открытого.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    // На macOS приложение принято оставлять в доке живым; на остальных
    // платформах закрытое окно означает выход.
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (mainWindow !== null || backend === null) {
      return;
    }

    mainWindow = createWindow();
    keepNavigationInside(mainWindow, backend.url);
    void mainWindow.loadURL(backend.url);
  });

  let shuttingDown = false;

  app.on('before-quit', (event) => {
    if (shuttingDown) {
      return;
    }

    // Завершение асинхронное: базе нужно закрыть журнал WAL, а распознавателю —
    // получить сигнал и не остаться висеть процессом без окна.
    shuttingDown = true;
    event.preventDefault();

    void shutdown().finally(() => {
      app.quit();
    });
  });

  app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      dialog.showErrorBox('Приложение не запустилось', String((error as Error).message));
      app.quit();
    });
}
