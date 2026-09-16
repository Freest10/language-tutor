/**
 * Файл настроек десктопной сборки и его перевод в переменные окружения сервера.
 *
 * Два свойства, ради которых тест и написан:
 * - испорченный файл не мешает запуску: неверные поля заменяются умолчаниями,
 *   а верные сохраняются — иначе опечатка стоила бы пользователю всей настройки;
 * - переменные окружения заполняются всегда все: сервер при запуске из
 *   исходников читает `.env` разработчика, и пропущенный ключ означал бы, что
 *   в десктопный запуск протекла чужая конфигурация.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolvePaths, type DesktopPaths } from '../src/paths.js';
import { defaultSettings, loadSettings, saveSettings, settingsToEnv } from '../src/settings.js';
import { withCommonToolPaths } from '../src/toolPath.js';

let workDir: string;
let settingsFile: string;
let paths: DesktopPaths;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'lt-desktop-'));
  settingsFile = join(workDir, 'settings.json');
  paths = resolvePaths({
    appDir: join(workDir, 'app'),
    resourcesDir: join(workDir, 'resources'),
    userDataDir: workDir,
    platform: 'darwin',
  });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('loadSettings', () => {
  it('создаёт файл с умолчаниями при первом запуске', () => {
    const { settings, created, issues } = loadSettings(settingsFile);

    expect(created).toBe(true);
    expect(issues).toEqual([]);
    expect(settings.stt.mode).toBe('local');
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual(settings);
  });

  it('читает заполненный файл как есть', () => {
    saveSettings(settingsFile, {
      ...defaultSettings(),
      llm: { ...defaultSettings().llm, model: 'llama3.1:8b' },
    });

    const { settings, created } = loadSettings(settingsFile);

    expect(created).toBe(false);
    expect(settings.llm.model).toBe('llama3.1:8b');
  });

  it('дополняет неполный файл умолчаниями', () => {
    writeFileSync(settingsFile, JSON.stringify({ llm: { model: 'qwen3:14b' } }), 'utf8');

    const { settings, issues } = loadSettings(settingsFile);

    expect(issues).toEqual([]);
    expect(settings.llm.model).toBe('qwen3:14b');
    expect(settings.llm.baseUrl).toBe(defaultSettings().llm.baseUrl);
    expect(settings.tts.mode).toBe('browser');
  });

  it('сохраняет верные поля, заменяя только испорченные', () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({ llm: { model: 'qwen3:14b', temperature: 42 }, logLevel: 'info' }),
      'utf8',
    );

    const { settings, issues } = loadSettings(settingsFile);

    expect(issues.join(' ')).toContain('llm.temperature');
    expect(settings.llm.model).toBe('qwen3:14b');
    expect(settings.llm.temperature).toBe(defaultSettings().llm.temperature);
  });

  it('переживает файл, который не является JSON, и не переписывает его', () => {
    writeFileSync(settingsFile, '{ это не json', 'utf8');

    const { settings, issues } = loadSettings(settingsFile);

    expect(issues).toHaveLength(1);
    expect(settings).toEqual(defaultSettings());
    // Правку пользователя молча затирать нельзя: он вернётся её чинить.
    expect(readFileSync(settingsFile, 'utf8')).toBe('{ это не json');
  });
});

describe('settingsToEnv', () => {
  it('отправляет распознавание во встроенный whisper.cpp и просит перекодировать звук', () => {
    const env = settingsToEnv(defaultSettings(), paths, {
      whisperBaseUrl: 'http://127.0.0.1:51234/v1',
    });

    expect(env.STT_PROVIDER).toBe('openai');
    expect(env.STT_BASE_URL).toBe('http://127.0.0.1:51234/v1');
    expect(env.STT_MODEL).toBe('ggml-base.bin');
    expect(env.STT_REQUIRE_WAV16).toBe('true');
    expect(env.STT_API_KEY).toBe('');
  });

  it('оставляет распознавание ненастроенным, если whisper.cpp не запустился', () => {
    // Пустой адрес сервер видит как «не настроено» и честно говорит об этом
    // в `GET /api/config`; выдумывать адрес нельзя — клиент ушёл бы в никуда.
    const env = settingsToEnv(defaultSettings(), paths, { whisperBaseUrl: null });

    expect(env.STT_BASE_URL).toBe('');
    expect(env.STT_REQUIRE_WAV16).toBe('false');
  });

  it('передаёт внешний распознаватель как есть, без перекодирования', () => {
    const settings = defaultSettings();

    settings.stt = {
      mode: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'whisper-1',
      apiKey: 'sk-test',
    };

    const env = settingsToEnv(settings, paths, { whisperBaseUrl: 'http://127.0.0.1:1/v1' });

    expect(env.STT_BASE_URL).toBe('https://api.openai.com/v1');
    expect(env.STT_MODEL).toBe('whisper-1');
    expect(env.STT_API_KEY).toBe('sk-test');
    expect(env.STT_REQUIRE_WAV16).toBe('false');
  });

  it('выключает распознавание в режиме off', () => {
    const settings = defaultSettings();

    settings.stt = { ...settings.stt, mode: 'off' };

    const env = settingsToEnv(settings, paths, { whisperBaseUrl: 'http://127.0.0.1:1/v1' });

    expect(env.STT_BASE_URL).toBe('');
    expect(env.STT_MODEL).toBe('');
  });

  it('уводит базу и материалы в каталог пользователя', () => {
    const env = settingsToEnv(defaultSettings(), paths, { whisperBaseUrl: null });

    expect(env.DB_PATH).toBe(paths.dbFile);
    expect(env.UPLOAD_DIR).toBe(paths.uploadDir);
    expect(env.WEB_DIST_DIR).toBe(paths.webDistDir);
    expect(env.HOST).toBe('127.0.0.1');
  });

  it('не оставляет ключи без значения', () => {
    const env = settingsToEnv(defaultSettings(), paths, { whisperBaseUrl: null });

    for (const [name, value] of Object.entries(env)) {
      expect(typeof value, name).toBe('string');
    }

    // Ключи голосовых провайдеров обязаны присутствовать даже пустыми.
    expect(Object.keys(env)).toEqual(
      expect.arrayContaining([
        'TTS_PROVIDER',
        'TTS_BASE_URL',
        'TTS_MODEL',
        'TTS_API_KEY',
        'TTS_VOICE',
      ]),
    );
  });
});

describe('withCommonToolPaths', () => {
  it('добавляет каталоги пакетных менеджеров, которых нет в PATH', () => {
    // Приложению из Dock достаётся короткий системный PATH, и poppler,
    // поставленный через Homebrew, оказывается «не найден».
    const extended = withCommonToolPaths('/usr/bin:/bin', 'darwin', () => true);

    expect(extended.split(':')).toContain('/opt/homebrew/bin');
    expect(extended.startsWith('/usr/bin:/bin')).toBe(true);
  });

  it('не добавляет каталоги, которых нет на диске', () => {
    expect(withCommonToolPaths('/usr/bin', 'darwin', () => false)).toBe('/usr/bin');
  });

  it('не дублирует уже перечисленные каталоги', () => {
    const extended = withCommonToolPaths('/opt/homebrew/bin:/usr/bin', 'darwin', () => true);

    expect(extended.split(':').filter((part) => part === '/opt/homebrew/bin')).toHaveLength(1);
  });

  it('переживает пустой PATH', () => {
    expect(withCommonToolPaths(undefined, 'darwin', () => true).length).toBeGreaterThan(0);
  });
});

describe('настройки распознавания сканов', () => {
  it('передаёт пределы и языки серверу', () => {
    const settings = defaultSettings();

    settings.scan = { ...settings.scan, maxPages: 215, dpi: 200, ocrLangs: ['de-DE', 'ru-RU'] };

    const env = settingsToEnv(settings, paths, { whisperBaseUrl: null });

    expect(env.SCAN_MAX_PAGES).toBe('215');
    expect(env.SCAN_DPI).toBe('200');
    expect(env.SCAN_OCR_LANGS).toBe('de-DE,ru-RU');
  });

  it('сообщает серверу, что настройки живут в меню, а не в .env', () => {
    // Подсказки интерфейса ведут пользователя туда, где настройки действительно
    // лежат: файла `.env` в установленном приложении нет.
    expect(settingsToEnv(defaultSettings(), paths, { whisperBaseUrl: null }).CONFIG_SOURCE).toBe(
      'desktop',
    );
  });

  it('показывает серверу, где лежит помощник распознавания', () => {
    // В установленном приложении скрипт лежит рядом с программой, а не внутри
    // архива: компилятору Swift нужен обычный файл на диске.
    const env = settingsToEnv(defaultSettings(), paths, { whisperBaseUrl: null });

    expect(env.OCR_SCRIPTS_DIR).toBe(paths.scriptsDir);
  });
});
