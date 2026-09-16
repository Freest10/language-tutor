/**
 * Конфигурация сервера из переменных окружения.
 *
 * Набор переменных зафиксирован здесь целиком и дальше не расширяется: фичевые
 * пакеты читают готовый `env` и не правят этот файл (см. шапку `app.ts`).
 *
 * Значения разбираются один раз при первом импорте модуля. Некорректное окружение —
 * это ошибка старта: `EnvValidationError` перечисляет, какие переменные и чем плохи.
 * Пустое значение (`VAR=`) допустимо только у необязательных переменных и означает
 * «не задано»; у переменной со значением по умолчанию пустая строка — ошибка,
 * строку нужно либо заполнить, либо удалить из `.env`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from 'dotenv';
import { z } from 'zod';

import {
  AUDIO_FORMATS,
  DEFAULT_TTS_FORMAT,
  VOICE_PROVIDERS,
  type AudioFormat,
  type VoiceProvider,
} from '@lt/shared';

const moduleDir = dirname(fileURLToPath(import.meta.url));

// Кандидаты — запуск из исходников (`src/config/`) и из сборки (`dist/src/config/`).
const SERVER_ROOT_CANDIDATES = [resolve(moduleDir, '../..'), resolve(moduleDir, '../../..')];

/** Каталог пакета `@lt/server` (в нём лежит `package.json` сервера). */
const serverRoot =
  SERVER_ROOT_CANDIDATES.find((candidate) => existsSync(join(candidate, 'package.json'))) ??
  process.cwd();

/** Корень монорепо: пакет сервера всегда лежит в `<корень>/server`. */
const workspaceRoot = dirname(serverRoot);

// `.env` лежит в корне монорепо: путь считаем от текущего файла, чтобы не зависеть от cwd
// (dev — из `server/`, prod — из `server/dist/`). dotenv не перетирает заданные переменные.
//
// В тестах файл НЕ читается: иначе результат прогона зависел бы от `.env` на машине
// разработчика — свой LLM_MODEL или STT_PROVIDER молча ронял бы чужие тесты.
if (process.env['NODE_ENV'] !== 'test') {
  config({ path: join(workspaceRoot, '.env'), quiet: true });
}

/** Версия сервера из `package.json`: отдаётся в `/api/health` и `/api/config`. */
export const APP_VERSION = readPackageVersion();

function readPackageVersion(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(serverRoot, 'package.json'), 'utf8'));

    if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
      const { version } = manifest as { version: unknown };

      if (typeof version === 'string' && version.length > 0) {
        return version;
      }
    }
  } catch {
    // Нечитаемый манифест не должен мешать старту: версия — справочное значение.
  }

  return '0.0.0';
}

/** Режимы работы процесса. */
const NODE_ENVS = ['development', 'test', 'production'] as const;

/** Уровни логирования pino. */
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * Как обрабатывается PDF без текстового слоя (скан учебника):
 * - `off` — не обрабатывается: материал получает `error_no_text_layer`;
 * - `ocr` — страницы растеризуются и распознаются локальным OCR: быстро, только текст;
 * - `vision` — страницы уходят картинками в зрячую модель: медленно, зато понимает
 *   вёрстку и описывает иллюстрации словами.
 */
export const SCAN_MODES = ['off', 'ocr', 'vision'] as const;

/** Режим обработки PDF без текстового слоя. */
export type ScanMode = (typeof SCAN_MODES)[number];

/** Языки распознавания по умолчанию: коды BCP-47, как их ждёт macOS Vision. */
export const DEFAULT_SCAN_OCR_LANGS = ['en-US', 'ru-RU'] as const;

/** Пустая строка в `.env` означает «переменная не задана». */
function emptyToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

/**
 * Необязательное число: `VAR=` и отсутствие переменной равнозначны.
 *
 * Без `preprocess` пустая строка коэрцится в `0` и проваливает нижнюю границу —
 * то есть `VAR=` ломает старт, хотя именно так `.env.example` и предлагает
 * оставлять необязательные переменные.
 */
function optionalNumber(
  min: number,
  max: number,
  error: string,
): z.ZodType<number | undefined, unknown> {
  return z.preprocess(
    emptyToUndefined,
    z.coerce.number({ error }).int().min(min).max(max).optional(),
  );
}

/** Необязательная строка: `VAR=` и отсутствие переменной равнозначны. */
function optionalString(max: number, error: string): z.ZodType<string | undefined, unknown> {
  return z.preprocess(
    emptyToUndefined,
    z
      .string({ error })
      .trim()
      .min(1)
      .max(max, `длина не должна превышать ${max} символов`)
      .optional(),
  );
}

/** Сообщение об ошибке для перечислимой переменной. */
function oneOf(values: readonly string[]): string {
  return `ожидается одно из: ${values.join(', ')}`;
}

/** Схема переменных окружения: ключи совпадают с именами в `.env`. */
export const envSchema = z.object({
  // ---------- Приложение ----------
  NODE_ENV: z.enum(NODE_ENVS, { error: oneOf(NODE_ENVS) }).default('development'),
  // Петля, а не 0.0.0.0: аутентификации в приложении нет по замыслу (допущение A6),
  // поэтому сетевая привязка — единственная граница доступа. Слушать все интерфейсы
  // значит отдать профиль, материалы и расшифровки уроков любому в той же сети.
  HOST: z.string({ error: 'ожидается имя хоста' }).trim().min(1).max(255).default('127.0.0.1'),
  PORT: z.coerce
    .number({ error: 'ожидается номер порта 1..65535' })
    .int()
    .min(1)
    .max(65_535)
    .default(8787),
  LOG_LEVEL: z.enum(LOG_LEVELS, { error: oneOf(LOG_LEVELS) }).default('info'),
  // Порт дев-сервера Vite. Серверу нужен только чтобы разрешить ему CORS.
  WEB_PORT: z.coerce
    .number({ error: 'ожидается номер порта 1..65535' })
    .int()
    .min(1)
    .max(65_535)
    .default(5173),

  // ---------- Хранилище ----------
  DB_PATH: optionalString(1024, 'ожидается путь к файлу базы'),
  UPLOAD_DIR: z
    .string({ error: 'ожидается путь к каталогу загрузок' })
    .trim()
    .min(1)
    .max(1024)
    .default('./data/uploads'),
  MAX_UPLOAD_MB: z.coerce
    .number({ error: 'ожидается размер в мегабайтах от 1 до 1024' })
    .int()
    .min(1)
    .max(1024)
    .default(200),
  // Предел ИЗВЛЕЧЁННОГО текста, а не файла. Пусто — вывести из MAX_UPLOAD_MB.
  // Держать два независимых числа нельзя: иначе файл проходит по размеру и
  // умирает на символах, причём уже после успешной загрузки.
  MAX_MATERIAL_TEXT_CHARS: optionalNumber(
    1000,
    250_000_000,
    'ожидается число символов от 1 000 до 250 000 000',
  ),

  // ---------- Распознавание сканов ----------
  SCAN_MODE: z.enum(SCAN_MODES, { error: oneOf(SCAN_MODES) }).default('ocr'),
  SCAN_DPI: z.coerce
    .number({ error: 'ожидается разрешение от 72 до 400 точек на дюйм' })
    .int()
    .min(72)
    .max(400)
    .default(150),
  // Защита от 500-страничных сканов: превышение — не ошибка, а обработка первых
  // N страниц с честной пометкой в statusMessage материала.
  SCAN_MAX_PAGES: z.coerce
    .number({ error: 'ожидается число страниц от 1 до 2000' })
    .int()
    .min(1)
    .max(2000)
    .default(50),
  SCAN_OCR_LANGS: optionalString(200, 'ожидается список кодов языка через запятую'),
  // Модель обязана принимать изображения: обычная текстовая модель на запрос со
  // страницей-картинкой ответит ошибкой или выдумает текст.
  SCAN_VISION_MODEL: z
    .string({ error: 'ожидается имя модели со зрением' })
    .trim()
    .min(1)
    .max(200)
    .default('qwen3-vl:8b-instruct'),

  // ---------- HTTP ----------
  CORS_ORIGIN: optionalString(2048, 'ожидается список источников через запятую'),

  // ---------- LLM (OpenAI-совместимый HTTP API) ----------
  LLM_BASE_URL: z
    .url({ error: 'ожидается URL, например http://localhost:11434/v1' })
    .default('http://localhost:11434/v1'),
  LLM_MODEL: z.string({ error: 'ожидается имя модели' }).trim().min(1).max(200).default('qwen3:8b'),
  LLM_API_KEY: optionalString(500, 'ожидается ключ API'),
  LLM_TIMEOUT_MS: z.coerce
    .number({ error: 'ожидается таймаут в миллисекундах (целое число ≥ 1000)' })
    .int()
    .min(1000)
    .max(600_000)
    .default(120_000),
  LLM_TEMPERATURE: z.coerce
    .number({ error: 'ожидается число от 0 до 2' })
    .min(0)
    .max(2)
    .default(0.3),

  // ---------- STT: распознавание речи ----------
  STT_PROVIDER: z.enum(VOICE_PROVIDERS, { error: oneOf(VOICE_PROVIDERS) }).default('browser'),
  STT_BASE_URL: z.preprocess(emptyToUndefined, z.url({ error: 'ожидается URL' }).optional()),
  STT_MODEL: optionalString(200, 'ожидается имя модели'),
  STT_API_KEY: optionalString(500, 'ожидается ключ API'),

  // ---------- TTS: синтез речи ----------
  TTS_PROVIDER: z.enum(VOICE_PROVIDERS, { error: oneOf(VOICE_PROVIDERS) }).default('browser'),
  TTS_BASE_URL: z.preprocess(emptyToUndefined, z.url({ error: 'ожидается URL' }).optional()),
  TTS_MODEL: optionalString(200, 'ожидается имя модели'),
  TTS_API_KEY: optionalString(500, 'ожидается ключ API'),
  TTS_VOICE: optionalString(60, 'ожидается имя голоса'),
  TTS_FORMAT: z.enum(AUDIO_FORMATS, { error: oneOf(AUDIO_FORMATS) }).default(DEFAULT_TTS_FORMAT),
});

/** Разобранные переменные окружения (ключи — как в `.env`). */
export type RawEnv = z.infer<typeof envSchema>;

/** Конфигурация сервера. */
export interface Env {
  /** Режим процесса: `development` | `test` | `production`. */
  nodeEnv: (typeof NODE_ENVS)[number];
  isDevelopment: boolean;
  isTest: boolean;
  isProduction: boolean;
  host: string;
  port: number;
  logLevel: (typeof LOG_LEVELS)[number];
  /** `DB_PATH` как задан в окружении; `undefined` — путь по умолчанию из `db/connection.ts`. */
  dbPath: string | undefined;
  /** Абсолютный путь к каталогу загруженных файлов. */
  uploadDir: string;
  /** Предел размера одной загружаемой части multipart, МиБ. */
  maxUploadMb: number;
  /** Тот же предел в байтах: значение для `@fastify/multipart`. */
  maxUploadBytes: number;
  /** Предел извлечённого из файла текста в символах (не размер файла). */
  maxMaterialTextChars: number;
  /** Как обрабатывается PDF без текстового слоя: `off` — никак. */
  scanMode: ScanMode;
  /** Разрешение растеризации страниц скана, точек на дюйм. */
  scanDpi: number;
  /** Сколько первых страниц скана обрабатывается. */
  scanMaxPages: number;
  /** Языки локального распознавания: коды BCP-47. */
  scanOcrLangs: string[];
  /** Модель режима `vision`: обязана принимать изображения. */
  scanVisionModel: string;
  /** Разрешённые источники CORS; пусто в env — только собственный веб. */
  corsOrigin: string[];
  /** Базовый URL OpenAI-совместимого API языковой модели. */
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string | undefined;
  llmTimeoutMs: number;
  llmTemperature: number;
  /** Кто выполняет распознавание речи: `browser` — серверный эндпоинт отключён. */
  sttProvider: VoiceProvider;
  sttBaseUrl: string | undefined;
  sttModel: string | undefined;
  sttApiKey: string | undefined;
  /** Кто выполняет синтез речи: `browser` — серверный эндпоинт отключён. */
  ttsProvider: VoiceProvider;
  ttsBaseUrl: string | undefined;
  ttsModel: string | undefined;
  ttsApiKey: string | undefined;
  ttsVoice: string | undefined;
  ttsFormat: AudioFormat;
}

/** Ошибка разбора окружения: `message` перечисляет все проблемные переменные. */
export class EnvValidationError extends Error {
  /** Имена переменных, не прошедших проверку. */
  readonly variables: string[];

  constructor(message: string, variables: string[]) {
    super(message);
    this.name = 'EnvValidationError';
    this.variables = variables;
  }
}

/** Переменные, значения которых не попадают в сообщение об ошибке. */
const SECRET_VARIABLE_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD)/;

/** Значение похоже на адрес: `схема://…`. */
const URL_LIKE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Значение переменной для сообщения об ошибке.
 *
 * Имени переменной мало: ключ прячут и в самом адресе — `https://user:sk-…@host`
 * или `?api_key=…`. Поэтому у всего, что похоже на URL, отбрасываются учётные
 * данные и строка запроса; сообщение об ошибке уходит в консоль и в лог.
 */
function describeValue(value: string): string {
  if (!URL_LIKE_PATTERN.test(value)) {
    return value;
  }

  return value.replace(/\/\/[^/@\s]*@/u, '//').replace(/[?#].*$/u, '');
}

function describeIssue(
  issue: z.core.$ZodIssue,
  source: Record<string, string | undefined>,
): string {
  const variable = String(issue.path[0] ?? '<неизвестная переменная>');
  const received = source[variable];
  const shown =
    received === undefined || SECRET_VARIABLE_PATTERN.test(variable)
      ? ''
      : ` (получено: "${describeValue(received)}")`;

  return `  - ${variable}: ${issue.message}${shown}`;
}

/**
 * Разбирает переменные окружения. Бросает `EnvValidationError` со списком
 * проблемных переменных — сообщение рассчитано на вывод в консоль при старте.
 */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const variables = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    const lines = result.error.issues.map((issue) => describeIssue(issue, source));
    const message = [
      'Некорректная конфигурация окружения:',
      ...lines,
      'Исправьте переменные в .env (образец — .env.example) и запустите сервер заново.',
    ].join('\n');

    throw new EnvValidationError(message, variables);
  }

  return toEnv(result.data);
}

/** Переводит разобранные переменные в конфигурацию сервера. */
function toEnv(raw: RawEnv): Env {
  return {
    nodeEnv: raw.NODE_ENV,
    isDevelopment: raw.NODE_ENV === 'development',
    isTest: raw.NODE_ENV === 'test',
    isProduction: raw.NODE_ENV === 'production',
    host: raw.HOST,
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    dbPath: raw.DB_PATH,
    uploadDir: isAbsolute(raw.UPLOAD_DIR) ? raw.UPLOAD_DIR : resolve(workspaceRoot, raw.UPLOAD_DIR),
    maxUploadMb: raw.MAX_UPLOAD_MB,
    maxUploadBytes: raw.MAX_UPLOAD_MB * 1024 * 1024,
    maxMaterialTextChars: resolveTextChars(raw.MAX_MATERIAL_TEXT_CHARS, raw.MAX_UPLOAD_MB),
    scanMode: raw.SCAN_MODE,
    scanDpi: raw.SCAN_DPI,
    scanMaxPages: raw.SCAN_MAX_PAGES,
    scanOcrLangs: parseScanLangs(raw.SCAN_OCR_LANGS),
    // Своя переменная, а не LLM_MODEL: диалог тьютора ведёт текстовая модель, а
    // страницу-картинку способна прочитать только модель со зрением.
    scanVisionModel: raw.SCAN_VISION_MODEL,
    corsOrigin: parseOrigins(raw.CORS_ORIGIN, raw.WEB_PORT),
    llmBaseUrl: raw.LLM_BASE_URL,
    llmModel: raw.LLM_MODEL,
    llmApiKey: raw.LLM_API_KEY,
    llmTimeoutMs: raw.LLM_TIMEOUT_MS,
    llmTemperature: raw.LLM_TEMPERATURE,
    sttProvider: raw.STT_PROVIDER,
    sttBaseUrl: raw.STT_BASE_URL,
    sttModel: raw.STT_MODEL,
    sttApiKey: raw.STT_API_KEY,
    ttsProvider: raw.TTS_PROVIDER,
    ttsBaseUrl: raw.TTS_BASE_URL,
    ttsModel: raw.TTS_MODEL,
    ttsApiKey: raw.TTS_API_KEY,
    ttsVoice: raw.TTS_VOICE,
    ttsFormat: raw.TTS_FORMAT,
  };
}

/**
 * Предел извлечённого текста в символах.
 *
 * Без явного значения выводится из `MAX_UPLOAD_MB`: в худшем случае (обычный
 * текстовый файл в ASCII) один байт даёт один символ, поэтому запас в 1.1
 * покрывает и разметку, и нормализацию переводов строк. Связка нужна, чтобы
 * два предела не противоречили друг другу: иначе пользователь получал бы
 * успешную загрузку и следом «текст слишком большой» — на файле, который сам
 * же сервер и разрешил.
 */
function resolveTextChars(explicit: number | undefined, uploadMb: number): number {
  if (explicit !== undefined) {
    return explicit;
  }

  return Math.min(Math.round(uploadMb * 1_100_000), 250_000_000);
}

/**
 * `SCAN_OCR_LANGS` — коды языков распознавания через запятую.
 *
 * Значение не выводится из профиля намеренно: слой извлечения текста не должен
 * знать ни про профиль, ни про изучаемый язык — иначе распознавание материала
 * менялось бы от того, какой язык пользователь выбрал сегодня. Языков всегда
 * несколько: в учебнике соседствуют изучаемый язык и язык пояснений.
 */
function parseScanLangs(value: string | undefined): string[] {
  const fallback = [...DEFAULT_SCAN_OCR_LANGS];

  if (value === undefined) {
    return fallback;
  }

  const langs = value
    .split(',')
    .map((lang) => lang.trim())
    .filter((lang) => lang.length > 0);

  return langs.length > 0 ? langs : fallback;
}

/**
 * `CORS_ORIGIN` — список источников через запятую.
 *
 * Пусто означает «только собственный веб», а не «отражать любой Origin»:
 * аутентификации нет (A6), поэтому отражение Origin дало бы любому открытому
 * сайту право читать профиль, материалы и расшифровки уроков через браузер
 * пользователя.
 */
function parseOrigins(value: string | undefined, webPort: number): string[] {
  const fallback = [`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`];

  if (value === undefined) {
    return fallback;
  }

  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return origins.length > 0 ? origins : fallback;
}

/** Конфигурация процесса: разбирается при первом импорте модуля. */
export const env: Env = parseEnv();
