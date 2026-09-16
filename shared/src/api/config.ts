/**
 * `GET /api/config` — возможности бэкенда, известные клиенту до первого запроса.
 * Нужен, чтобы интерфейс заранее показал предупреждение (нет ключа LLM,
 * распознавание речи выполняет браузер и т. п.), а не молчал при отказе.
 */
import { z } from 'zod';

import { audioFormatSchema, voiceProviderSchema } from './voice.js';

import { cefrLevelSchema, languageCodeSchema, languageOptionSchema } from '../domain/language.js';
import { dailyMinutesSchema } from '../domain/profile.js';

/** Доступность языковой модели. */
export const llmCapabilitySchema = z.object({
  available: z.boolean(),
  /** Имя модели, если она настроена. */
  model: z.string().nullish(),
  /** Почему возможность недоступна; заполняется при `available: false`. */
  reason: z.string().nullish(),
});

/** Доступность языковой модели. */
export type LlmCapability = z.infer<typeof llmCapabilitySchema>;

/** Доступность распознавания речи. */
export const sttCapabilitySchema = z.object({
  provider: voiceProviderSchema,
  available: z.boolean(),
  model: z.string().nullish(),
  /**
   * Присылать запись только как WAV 16 кГц моно.
   *
   * Клиент по умолчанию пишет `audio/webm;codecs=opus` — это самый компактный
   * контейнер, и облачный OpenAI с faster-whisper-server его распаковывают.
   * Встроенный в приложение whisper.cpp декодирует звук библиотекой miniaudio,
   * которая знает WAV, MP3 и FLAC, но не Opus, поэтому запись для него нужно
   * перекодировать в браузере. Флаг сообщает клиенту, что это тот случай.
   */
  requiresWav16: z.boolean().default(false),
  reason: z.string().nullish(),
});

/** Доступность распознавания речи. */
export type SttCapability = z.infer<typeof sttCapabilitySchema>;

/** Доступность синтеза речи. */
export const ttsCapabilitySchema = z.object({
  provider: voiceProviderSchema,
  available: z.boolean(),
  model: z.string().nullish(),
  voice: z.string().nullish(),
  formats: z.array(audioFormatSchema).default([]),
  reason: z.string().nullish(),
});

/** Доступность синтеза речи. */
export type TtsCapability = z.infer<typeof ttsCapabilitySchema>;

/** Значения, которые клиент подставляет, пока профиль не заполнен. */
export const configDefaultsSchema = z.object({
  learningLanguage: languageCodeSchema,
  interfaceLanguage: languageCodeSchema,
  explanationLanguage: languageCodeSchema,
  level: cefrLevelSchema,
  dailyMinutes: dailyMinutesSchema,
});

/** Значения по умолчанию из конфигурации. */
export type ConfigDefaults = z.infer<typeof configDefaultsSchema>;

/** Ограничения сервера, о которых клиенту полезно знать заранее. */
export const configLimitsSchema = z.object({
  maxMaterialUploadBytes: z.int().positive(),
  maxMaterialTextLength: z.int().positive(),
  maxAudioUploadBytes: z.int().positive(),
  maxTtsTextLength: z.int().positive(),
  maxPageSize: z.int().positive(),
});

/** Ограничения сервера. */
export type ConfigLimits = z.infer<typeof configLimitsSchema>;

/**
 * Откуда приложение берёт настройки.
 *
 * Нужно интерфейсу, чтобы подсказка «поправьте настройки» вела туда, где они
 * на самом деле лежат: у веб-версии это файл `.env` и перезапуск сервера,
 * у десктопной — пункт меню, файла `.env` там нет вовсе.
 */
export const CONFIG_SOURCES = ['env', 'desktop'] as const;

/** Откуда приложение берёт настройки. */
export type ConfigSource = (typeof CONFIG_SOURCES)[number];

/** Откуда приложение берёт настройки. */
export const configSourceSchema = z.enum(CONFIG_SOURCES);

/** Конфигурация приложения, отдаваемая клиенту. */
export const appConfigSchema = z.object({
  appName: z.string().min(1),
  apiPrefix: z.string().min(1),
  version: z.string().min(1),
  /** Где пользователю искать настройки приложения. */
  configSource: configSourceSchema.default('env'),
  llm: llmCapabilitySchema,
  stt: sttCapabilitySchema,
  tts: ttsCapabilitySchema,
  /** Языки, которые приложение готово предложить в интерфейсе. */
  supportedLanguages: z.array(languageOptionSchema).min(1),
  defaults: configDefaultsSchema,
  limits: configLimitsSchema,
});

/** Конфигурация приложения. */
export type AppConfig = z.infer<typeof appConfigSchema>;

/** Ответ `GET /api/config`. */
export const getConfigResponseSchema = appConfigSchema;

/** Ответ `GET /api/config`. */
export type GetConfigResponse = AppConfig;
