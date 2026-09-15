/**
 * `GET /api/config` — возможности и ограничения бэкенда, известные клиенту
 * до первого содержательного запроса.
 *
 * Здесь сообщается то, что видно из конфигурации: заданы ли адрес и модель
 * провайдера. Доступность внешнего сервиса не проверяется — запрос к нему
 * стоит дороже, чем весь остальной ответ.
 */
import type { FastifyPluginAsync } from 'fastify';

import {
  API_PREFIX,
  APP_NAME,
  DEFAULT_CEFR_LEVEL,
  DEFAULT_DAILY_MINUTES,
  DEFAULT_LANGUAGE_CODE,
  getConfigResponseSchema,
  KNOWN_LANGUAGE_CODES,
  LANGUAGE_LABELS,
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_MATERIAL_TEXT_LENGTH,
  MAX_MATERIAL_UPLOAD_BYTES,
  MAX_PAGE_SIZE,
  MAX_TTS_TEXT_LENGTH,
  type AppConfig,
  type LanguageOption,
  type LlmCapability,
  type SttCapability,
  type TtsCapability,
} from '@lt/shared';

import { APP_VERSION, env } from '../config/env.js';

/** Доступность языковой модели: модель и адрес API заданы. */
function llmCapability(): LlmCapability {
  const available = env.llmBaseUrl.length > 0 && env.llmModel.length > 0;

  return {
    available,
    model: available ? env.llmModel : null,
    reason: available ? null : 'Не заданы LLM_BASE_URL или LLM_MODEL',
  };
}

/** Доступность распознавания речи; `browser` — работу выполняет клиент. */
function sttCapability(): SttCapability {
  if (env.sttProvider === 'browser') {
    return {
      provider: 'browser',
      available: true,
      model: null,
      reason: `Распознавание выполняет браузер; серверный ${API_PREFIX}/voice/stt отключён (STT_PROVIDER=browser)`,
    };
  }

  const available = env.sttBaseUrl !== undefined && env.sttModel !== undefined;

  return {
    provider: env.sttProvider,
    available,
    model: env.sttModel ?? null,
    reason: available ? null : 'Не заданы STT_BASE_URL или STT_MODEL',
  };
}

/** Доступность синтеза речи; `browser` — работу выполняет клиент. */
function ttsCapability(): TtsCapability {
  if (env.ttsProvider === 'browser') {
    return {
      provider: 'browser',
      available: true,
      model: null,
      voice: null,
      formats: [],
      reason: `Синтез выполняет браузер; серверный ${API_PREFIX}/voice/tts отключён (TTS_PROVIDER=browser)`,
    };
  }

  const available = env.ttsBaseUrl !== undefined && env.ttsModel !== undefined;

  return {
    provider: env.ttsProvider,
    available,
    model: env.ttsModel ?? null,
    voice: env.ttsVoice ?? null,
    formats: available ? [env.ttsFormat] : [],
    reason: available ? null : 'Не заданы TTS_BASE_URL или TTS_MODEL',
  };
}

/** Языки с готовыми пресетами: их предлагает интерфейс. */
function supportedLanguages(): LanguageOption[] {
  return KNOWN_LANGUAGE_CODES.map((code) => ({ code, ...LANGUAGE_LABELS[code] }));
}

/** Собирает ответ `GET /api/config`. */
export function buildAppConfig(): AppConfig {
  return {
    appName: APP_NAME,
    apiPrefix: API_PREFIX,
    version: APP_VERSION,
    llm: llmCapability(),
    stt: sttCapability(),
    tts: ttsCapability(),
    supportedLanguages: supportedLanguages(),
    defaults: {
      learningLanguage: DEFAULT_LANGUAGE_CODE,
      interfaceLanguage: DEFAULT_LANGUAGE_CODE,
      explanationLanguage: DEFAULT_LANGUAGE_CODE,
      level: DEFAULT_CEFR_LEVEL,
      dailyMinutes: DEFAULT_DAILY_MINUTES,
    },
    limits: {
      maxMaterialUploadBytes: MAX_MATERIAL_UPLOAD_BYTES,
      maxMaterialTextLength: MAX_MATERIAL_TEXT_LENGTH,
      maxAudioUploadBytes: MAX_AUDIO_UPLOAD_BYTES,
      maxTtsTextLength: MAX_TTS_TEXT_LENGTH,
      maxPageSize: MAX_PAGE_SIZE,
    },
  };
}

/** Маршрут конфигурации приложения. */
export const configRoutes: FastifyPluginAsync = async (app) => {
  app.get('/config', { schema: { response: { 200: getConfigResponseSchema } } }, (): AppConfig =>
    buildAppConfig(),
  );
};
