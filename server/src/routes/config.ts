/**
 * `GET /api/config` — возможности и ограничения бэкенда, известные клиенту
 * до первого содержательного запроса.
 *
 * Здесь сообщается то, что видно из конфигурации: заданы ли адрес и модель
 * провайдера. Доступность внешнего сервиса не проверяется — запрос к нему
 * стоит дороже, чем весь остальной ответ.
 *
 * Готовность провайдеров считает `providers/factory.ts` — тем же предикатом,
 * которым она собирает провайдер для запроса. Иначе конфигурация могла бы
 * пообещать возможность, которая затем отвечает 501.
 */
import type { FastifyPluginAsync } from 'fastify';

import {
  MAX_MATERIAL_TEXT_LENGTH,
  API_PREFIX,
  APP_NAME,
  DEFAULT_CEFR_LEVEL,
  DEFAULT_DAILY_MINUTES,
  DEFAULT_LANGUAGE_CODE,
  getConfigResponseSchema,
  KNOWN_LANGUAGE_CODES,
  LANGUAGE_LABELS,
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_PAGE_SIZE,
  MAX_TTS_TEXT_LENGTH,
  type AppConfig,
  type LanguageOption,
} from '@lt/shared';

import { APP_VERSION, env } from '../config/env.js';
import { llmCapability, sttCapability, ttsCapability } from '../providers/factory.js';

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
      // Действующий предел файла, а не константа контракта: клиент проверяет
      // файл до отправки и рисует по этому числу подсказку, поэтому обязан
      // видеть то же значение, которое применит сервер.
      maxMaterialUploadBytes: env.maxUploadBytes,
      // А это предел поля «вставить текст», а не извлечённого из файла: клиент
      // считает по нему символы в textarea, и число обязано совпадать с
      // ограничением схемы createTextMaterialRequestSchema. Предел извлечения
      // (MAX_MATERIAL_TEXT_CHARS) клиенту не нужен: его превышение приходит
      // статусом материала с человекочитаемым пояснением.
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
