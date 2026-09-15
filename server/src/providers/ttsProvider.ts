/**
 * Синтез речи: `POST {TTS_BASE_URL}/audio/speech`.
 *
 * Ответ провайдера — двоичное аудио; в base64 его переводит маршрут,
 * чтобы ошибка приходила тем же конвертом `{ error }`, что и везде.
 *
 * Язык провайдеру не передаётся: у OpenAI-совместимого эндпоинта такого
 * параметра нет — произношение определяет голос (`TTS_VOICE` или поле запроса).
 */
import { AUDIO_FORMAT_CONTENT_TYPES, type AudioFormat } from '@lt/shared';

import { OpenAiCompatibleClient, type RetryPolicy } from './openaiCompatible.js';
import {
  type ProviderLogger,
  type TtsProvider,
  type TtsResult,
  type TtsSynthesisRequest,
} from './types.js';

/** Путь OpenAI-совместимого эндпоинта синтеза. */
export const SPEECH_PATH = '/audio/speech';

/**
 * Значение `response_format` для каждого формата приложения.
 * OpenAI-совместимые сервера называют ogg/opus по кодеку, а не по контейнеру.
 */
export const UPSTREAM_RESPONSE_FORMATS: Record<AudioFormat, string> = {
  mp3: 'mp3',
  wav: 'wav',
  ogg: 'opus',
  webm: 'webm',
};

/** Параметры провайдера синтеза речи. */
export interface TtsProviderOptions {
  /** Базовый URL OpenAI-совместимого API. */
  baseUrl: string;
  /** Имя модели синтеза, например `kokoro`. */
  model: string;
  /** Голос по умолчанию; если не задан, провайдер выбирает свой. */
  voice?: string | undefined;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  retry?: Partial<RetryPolicy> | undefined;
  logger?: ProviderLogger | undefined;
}

/** Берёт тип из заголовка ответа, если он похож на аудио. */
function resolveContentType(header: string | null, format: AudioFormat): string {
  const value = header?.split(';')[0]?.trim().toLowerCase();

  return value !== undefined && value.startsWith('audio/')
    ? value
    : AUDIO_FORMAT_CONTENT_TYPES[format];
}

/** Провайдер синтеза поверх OpenAI-совместимого HTTP API. */
class OpenAiCompatibleTtsProvider implements TtsProvider {
  readonly provider = 'openai' as const;
  readonly model: string;

  private readonly client: OpenAiCompatibleClient;
  private readonly voice: string | undefined;

  constructor(options: TtsProviderOptions) {
    this.model = options.model;
    this.voice = options.voice;
    this.client = new OpenAiCompatibleClient({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
      retry: options.retry,
      target: 'tts',
      logger: options.logger,
    });
  }

  async synthesize(request: TtsSynthesisRequest): Promise<TtsResult> {
    const voice = request.voice ?? this.voice;
    const body = {
      model: this.model,
      input: request.text,
      response_format: UPSTREAM_RESPONSE_FORMATS[request.format],
      ...(voice === undefined ? {} : { voice }),
      ...(request.speed === undefined ? {} : { speed: request.speed }),
    };

    const payload = await this.client.postForBytes(SPEECH_PATH, body, { signal: request.signal });

    return {
      audio: payload.bytes,
      contentType: resolveContentType(payload.contentType, request.format),
      format: request.format,
      voice: voice ?? null,
      model: this.model,
    };
  }
}

/** Собирает провайдер синтеза речи с явно заданной конфигурацией. */
export function createTtsProvider(options: TtsProviderOptions): TtsProvider {
  return new OpenAiCompatibleTtsProvider(options);
}
