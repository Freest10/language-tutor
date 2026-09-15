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
config({ path: join(workspaceRoot, '.env'), quiet: true });

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

/** Пустая строка в `.env` означает «переменная не задана». */
function emptyToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
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
  HOST: z.string({ error: 'ожидается имя хоста' }).trim().min(1).max(255).default('0.0.0.0'),
  PORT: z.coerce
    .number({ error: 'ожидается номер порта 1..65535' })
    .int()
    .min(1)
    .max(65_535)
    .default(8787),
  LOG_LEVEL: z.enum(LOG_LEVELS, { error: oneOf(LOG_LEVELS) }).default('info'),

  // ---------- Хранилище ----------
  DB_PATH: optionalString(1024, 'ожидается путь к файлу базы'),
  UPLOAD_DIR: z
    .string({ error: 'ожидается путь к каталогу загрузок' })
    .trim()
    .min(1)
    .max(1024)
    .default('./data/uploads'),
  MAX_UPLOAD_MB: z.coerce
    .number({ error: 'ожидается размер в мегабайтах (целое число ≥ 1)' })
    .int()
    .min(1)
    .max(1024)
    .default(25),

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
  /** Разрешённые источники CORS; `undefined` — отражать Origin запроса. */
  corsOrigin: string[] | undefined;
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

/** Имя `EnvValidationError`: позволяет опознать ошибку без импорта модуля. */
export const ENV_VALIDATION_ERROR_NAME = 'EnvValidationError';

/** Переменные, значения которых не попадают в сообщение об ошибке. */
const SECRET_VARIABLE_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD)/;

function describeIssue(
  issue: z.core.$ZodIssue,
  source: Record<string, string | undefined>,
): string {
  const variable = String(issue.path[0] ?? '<неизвестная переменная>');
  const received = source[variable];
  const shown =
    received === undefined || SECRET_VARIABLE_PATTERN.test(variable)
      ? ''
      : ` (получено: "${received}")`;

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
    corsOrigin: parseOrigins(raw.CORS_ORIGIN),
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
    ttsVoice: raw.TTS_VOICE,
    ttsFormat: raw.TTS_FORMAT,
  };
}

/** `CORS_ORIGIN` — список источников через запятую; пусто — отражать Origin запроса. */
function parseOrigins(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return origins.length > 0 ? origins : undefined;
}

/** Конфигурация процесса: разбирается при первом импорте модуля. */
export const env: Env = parseEnv();
