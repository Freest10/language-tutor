/**
 * Сборка провайдеров из переменных окружения — единственное место, где
 * конфигурация превращается в готовый к работе провайдер.
 *
 * Здесь же считаются «возможности» для `GET /api/config`: и маршрут, и фабрика
 * пользуются одним предикатом готовности, поэтому конфигурация не может
 * пообещать клиенту распознавание, которое затем ответит 501.
 *
 * Доступность провайдера не проверяется запросом к нему: пинг стоил бы дороже
 * всего ответа. `available` означает «настроено», а не «сейчас отвечает».
 */
import { API_PREFIX, type LlmCapability, type SttCapability, type TtsCapability } from '@lt/shared';

import { env } from '../config/env.js';
import { notConfigured } from '../lib/httpErrors.js';

import { createLlmProvider } from './llmProvider.js';
import { createSttProvider } from './sttProvider.js';
import { createTtsProvider } from './ttsProvider.js';
import type { LlmProvider, ProviderLogger, SttProvider, TtsProvider } from './types.js';

/** Общие параметры сборки провайдера. */
export interface ResolveProviderOptions {
  /** Логгер запроса: провайдер пишет в него повторы и тайминги. */
  logger?: ProviderLogger | undefined;
}

/** Доступность языковой модели: заданы адрес API и имя модели. */
export function llmCapability(): LlmCapability {
  const available = env.llmBaseUrl.length > 0 && env.llmModel.length > 0;

  return {
    available,
    model: available ? env.llmModel : null,
    reason: available ? null : 'Не заданы LLM_BASE_URL или LLM_MODEL',
  };
}

/** Доступность распознавания речи; `browser` — работу выполняет клиент. */
export function sttCapability(): SttCapability {
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
export function ttsCapability(): TtsCapability {
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

/**
 * Провайдер языковой модели по переменным окружения.
 * Бросает 501 `not_configured`, если адрес или модель не заданы.
 */
export function resolveLlmProvider(options: ResolveProviderOptions = {}): LlmProvider {
  if (!llmCapability().available) {
    throw notConfigured('Языковая модель не настроена', {
      details: { reason: 'llm_not_configured' },
    });
  }

  return createLlmProvider({
    baseUrl: env.llmBaseUrl,
    model: env.llmModel,
    apiKey: env.llmApiKey,
    timeoutMs: env.llmTimeoutMs,
    temperature: env.llmTemperature,
    logger: options.logger,
  });
}

/**
 * Провайдер распознавания речи по переменным окружения.
 * Бросает 501 `not_configured`: при `STT_PROVIDER=browser` — с пометкой
 * `stt_browser_only` (клиент обязан использовать Web Speech API).
 */
export function resolveSttProvider(options: ResolveProviderOptions = {}): SttProvider {
  if (env.sttProvider === 'browser') {
    throw notConfigured(
      'Распознавание речи выполняет браузер: серверный эндпоинт отключён (STT_PROVIDER=browser)',
      { details: { reason: 'stt_browser_only', provider: 'browser' } },
    );
  }

  if (env.sttBaseUrl === undefined || env.sttModel === undefined) {
    throw notConfigured('Распознавание речи не настроено: не заданы STT_BASE_URL или STT_MODEL', {
      details: { reason: 'stt_not_configured', provider: env.sttProvider },
    });
  }

  return createSttProvider({
    baseUrl: env.sttBaseUrl,
    model: env.sttModel,
    apiKey: env.sttApiKey,
    logger: options.logger,
  });
}

/**
 * Провайдер синтеза речи по переменным окружения. Ключ API ему не передаётся:
 * переменной `TTS_API_KEY` в конфигурации нет (синтез рассчитан на локальный сервис).
 * Бросает 501 `not_configured`: при `TTS_PROVIDER=browser` — с пометкой
 * `tts_browser_only` (клиент обязан использовать Web Speech API).
 */
export function resolveTtsProvider(options: ResolveProviderOptions = {}): TtsProvider {
  if (env.ttsProvider === 'browser') {
    throw notConfigured(
      'Синтез речи выполняет браузер: серверный эндпоинт отключён (TTS_PROVIDER=browser)',
      { details: { reason: 'tts_browser_only', provider: 'browser' } },
    );
  }

  if (env.ttsBaseUrl === undefined || env.ttsModel === undefined) {
    throw notConfigured('Синтез речи не настроен: не заданы TTS_BASE_URL или TTS_MODEL', {
      details: { reason: 'tts_not_configured', provider: env.ttsProvider },
    });
  }

  return createTtsProvider({
    baseUrl: env.ttsBaseUrl,
    model: env.ttsModel,
    apiKey: env.ttsApiKey,
    voice: env.ttsVoice,
    logger: options.logger,
  });
}
