/**
 * Настройки десктопной сборки: файл `settings.json` в каталоге пользователя.
 *
 * У веб-версии конфигурация лежит в `.env` рядом с исходниками, но у
 * установленного приложения такого каталога нет: код доступен только для
 * чтения, а править переменные окружения у ярлыка пользователь не станет.
 * Поэтому настройки живут в его собственном каталоге, а приложение переводит
 * их в те же переменные окружения, которые понимает сервер, — второй
 * конфигурации у сервера не появляется.
 *
 * Сломанный или частично заполненный файл не мешает запуску: каждое поле имеет
 * значение по умолчанию, а о проблеме сообщает `loadSettings().issues` —
 * приложение покажет её и продолжит работать на умолчаниях. Терять урок из-за
 * лишней запятой в JSON пользователь не должен.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { DesktopPaths } from './paths.js';

/** Кто распознаёт речь. */
export const STT_MODES = ['local', 'openai', 'off'] as const;

/** Кто распознаёт речь: `local` — встроенный whisper.cpp. */
export type SttMode = (typeof STT_MODES)[number];

/** Кто синтезирует речь. */
export const TTS_MODES = ['browser', 'openai'] as const;

/** Кто синтезирует речь: `browser` — системный голос через Web Speech API. */
export type TtsMode = (typeof TTS_MODES)[number];

/** Режимы обработки PDF без текстового слоя; повторяют `SCAN_MODE` сервера. */
export const SCAN_MODES = ['off', 'ocr', 'vision'] as const;

/** Уровни журнала сервера. */
const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;

/** Модель whisper.cpp, которая едет в установщике. */
export const BUNDLED_WHISPER_MODEL = 'ggml-base.bin';

/** Необязательная строка: пустая означает «не задано». */
const optionalText = z.string().trim().default('');

/** Схема файла настроек: каждое поле необязательно, у каждого есть умолчание. */
export const settingsSchema = z.object({
  llm: z
    .object({
      /** Адрес OpenAI-совместимого API: локальная Ollama, LM Studio или облако. */
      baseUrl: z.string().trim().default('http://localhost:11434/v1'),
      model: z.string().trim().default('qwen3:8b'),
      apiKey: optionalText,
      timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
      temperature: z.number().min(0).max(2).default(0.3),
    })
    // `prefault`, а не `default`: значение по умолчанию обязано пройти через
    // схему, иначе пропущенная в файле группа осталась бы пустым объектом
    // вместо набора умолчаний.
    .prefault({}),
  stt: z
    .object({
      /**
       * `local` — встроенный whisper.cpp, работает без сети и без ключей;
       * `openai` — внешний OpenAI-совместимый сервер;
       * `off` — распознавание выключено, остаётся ввод текстом.
       *
       * Значения `browser` здесь нет намеренно: распознавание речи силами
       * браузера в Electron не работает — Chromium отправляет звук в сервис
       * Google по ключам, которых в сборках Electron нет.
       */
      mode: z.enum(STT_MODES).default('local'),
      baseUrl: optionalText,
      model: optionalText,
      apiKey: optionalText,
    })
    // `prefault`, а не `default`: значение по умолчанию обязано пройти через
    // схему, иначе пропущенная в файле группа осталась бы пустым объектом
    // вместо набора умолчаний.
    .prefault({}),
  tts: z
    .object({
      /** `browser` — системный голос (в Electron работает), `openai` — внешний сервис. */
      mode: z.enum(TTS_MODES).default('browser'),
      baseUrl: optionalText,
      model: optionalText,
      apiKey: optionalText,
      voice: optionalText,
    })
    // `prefault`, а не `default`: значение по умолчанию обязано пройти через
    // схему, иначе пропущенная в файле группа осталась бы пустым объектом
    // вместо набора умолчаний.
    .prefault({}),
  whisper: z
    .object({
      /** Имя файла модели в каталоге моделей или абсолютный путь к нему. */
      model: z.string().trim().default(BUNDLED_WHISPER_MODEL),
      /** Потоков распознавания; 0 — выбирает whisper.cpp сам. */
      threads: z.number().int().min(0).max(64).default(0),
      /** Порт распознавателя; 0 — взять свободный. */
      port: z.number().int().min(0).max(65_535).default(0),
    })
    // `prefault`, а не `default`: значение по умолчанию обязано пройти через
    // схему, иначе пропущенная в файле группа осталась бы пустым объектом
    // вместо набора умолчаний.
    .prefault({}),
  scan: z
    .object({
      mode: z.enum(SCAN_MODES).default('ocr'),
      visionModel: z.string().trim().default('qwen3-vl:8b-instruct'),
      /** Сколько первых страниц скана распознавать: учебник целиком — это часы работы. */
      maxPages: z.number().int().min(1).max(2000).default(50),
      /** Разрешение растеризации страниц, точек на дюйм. */
      dpi: z.number().int().min(72).max(400).default(150),
      /** Языки распознавания, коды BCP-47: обычно изучаемый и язык пояснений. */
      ocrLangs: z.array(z.string().trim().min(2).max(10)).default(['en-US', 'ru-RU']),
    })
    // `prefault`, а не `default`: значение по умолчанию обязано пройти через
    // схему, иначе пропущенная в файле группа осталась бы пустым объектом
    // вместо набора умолчаний.
    .prefault({}),
  logLevel: z.enum(LOG_LEVELS).default('info'),
});

/** Настройки десктопной сборки. */
export type DesktopSettings = z.infer<typeof settingsSchema>;

/** Настройки по умолчанию — они же образец файла при первом запуске. */
export function defaultSettings(): DesktopSettings {
  return settingsSchema.parse({});
}

/** Результат чтения файла настроек. */
export interface LoadedSettings {
  settings: DesktopSettings;
  /** Что было не так с файлом; пусто — файл прочитан целиком. */
  issues: string[];
  /** Файла не было и он создан с умолчаниями. */
  created: boolean;
}

/** Пояснение к проблеме разбора — одной строкой на поле. */
function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');

    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
}

/**
 * Читает настройки, создавая файл при первом запуске.
 * Неразбираемый файл не переписывается: пользователь правил его руками,
 * и молча затереть правку хуже, чем поработать на умолчаниях.
 */
export function loadSettings(settingsFile: string): LoadedSettings {
  let raw: string;

  try {
    raw = readFileSync(settingsFile, 'utf8');
  } catch {
    const settings = defaultSettings();

    saveSettings(settingsFile, settings);

    return { settings, issues: [], created: true };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      settings: defaultSettings(),
      issues: [`файл не является JSON: ${(error as Error).message}`],
      created: false,
    };
  }

  const result = settingsSchema.safeParse(parsed);

  if (!result.success) {
    // Разбор поля за полем: верные значения сохраняются, испорченные заменяются
    // умолчаниями — иначе одна опечатка сбрасывала бы всю настройку.
    const partial = settingsSchema.safeParse(dropInvalidFields(parsed, result.error));

    return {
      settings: partial.success ? partial.data : defaultSettings(),
      issues: describeIssues(result.error),
      created: false,
    };
  }

  return { settings: result.data, issues: [], created: false };
}

/** Убирает из объекта поля, на которые пожаловалась схема. */
function dropInvalidFields(value: unknown, error: z.ZodError): unknown {
  if (typeof value !== 'object' || value === null) {
    return {};
  }

  const copy = structuredClone(value) as Record<string, unknown>;

  for (const issue of error.issues) {
    let cursor: Record<string, unknown> = copy;

    for (const key of issue.path.slice(0, -1)) {
      const next: unknown = cursor[String(key)];

      if (typeof next !== 'object' || next === null) {
        cursor = copy;
        break;
      }

      cursor = next as Record<string, unknown>;
    }

    const last = issue.path.at(-1);

    if (last !== undefined) {
      delete cursor[String(last)];
    }
  }

  return copy;
}

/** Записывает настройки, создавая каталог при необходимости. */
export function saveSettings(settingsFile: string, settings: DesktopSettings): void {
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

/** Что уже известно о запущенных службах к моменту сборки окружения. */
export interface RuntimeEndpoints {
  /** Адрес встроенного распознавателя; `null` — он не запускался. */
  whisperBaseUrl: string | null;
}

/**
 * Переводит настройки в переменные окружения сервера.
 *
 * Пустая строка означает «переменная не задана» — так же, как в `.env`.
 * Заполняются все ключи, включая пустые: сервер читает `.env` из каталога
 * разработчика, если запущен из исходников, и явные значения не дают чужой
 * конфигурации протечь в десктопный запуск.
 */
export function settingsToEnv(
  settings: DesktopSettings,
  paths: DesktopPaths,
  runtime: RuntimeEndpoints,
): Record<string, string> {
  const usesLocalStt = settings.stt.mode === 'local' && runtime.whisperBaseUrl !== null;
  const usesRemoteStt = settings.stt.mode === 'openai';

  return {
    NODE_ENV: 'production',
    // Порт выбирает главный процесс при запуске, HOST — петля: у приложения нет
    // аутентификации, и слушать чужие интерфейсы оно не должно (допущение A6).
    HOST: '127.0.0.1',
    LOG_LEVEL: settings.logLevel,
    // Подсказки интерфейса должны вести в меню приложения, а не в файл `.env`,
    // которого в установленной версии не существует.
    CONFIG_SOURCE: 'desktop',

    DB_PATH: paths.dbFile,
    UPLOAD_DIR: paths.uploadDir,
    WEB_DIST_DIR: paths.webDistDir,
    CORS_ORIGIN: '',

    SCAN_MODE: settings.scan.mode,
    SCAN_VISION_MODEL: settings.scan.visionModel,
    SCAN_MAX_PAGES: String(settings.scan.maxPages),
    SCAN_DPI: String(settings.scan.dpi),
    SCAN_OCR_LANGS: settings.scan.ocrLangs.join(','),
    OCR_SCRIPTS_DIR: paths.scriptsDir,

    LLM_BASE_URL: settings.llm.baseUrl,
    LLM_MODEL: settings.llm.model,
    LLM_API_KEY: settings.llm.apiKey,
    LLM_TIMEOUT_MS: String(settings.llm.timeoutMs),
    LLM_TEMPERATURE: String(settings.llm.temperature),

    // Провайдер всегда `openai`: и встроенный whisper.cpp, и внешний сервис
    // отвечают по одному протоколу, различаются только адресом.
    STT_PROVIDER: 'openai',
    STT_BASE_URL: usesLocalStt
      ? (runtime.whisperBaseUrl ?? '')
      : usesRemoteStt
        ? settings.stt.baseUrl
        : '',
    STT_MODEL: usesLocalStt ? settings.whisper.model : usesRemoteStt ? settings.stt.model : '',
    STT_API_KEY: usesRemoteStt ? settings.stt.apiKey : '',
    // Встроенный whisper.cpp не распаковывает Opus, которым пишет браузер:
    // перекодировать запись придётся на стороне интерфейса.
    STT_REQUIRE_WAV16: usesLocalStt ? 'true' : 'false',

    TTS_PROVIDER: settings.tts.mode,
    TTS_BASE_URL: settings.tts.mode === 'openai' ? settings.tts.baseUrl : '',
    TTS_MODEL: settings.tts.mode === 'openai' ? settings.tts.model : '',
    TTS_API_KEY: settings.tts.mode === 'openai' ? settings.tts.apiKey : '',
    TTS_VOICE: settings.tts.mode === 'openai' ? settings.tts.voice : '',
  };
}
