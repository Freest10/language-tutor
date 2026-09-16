/**
 * Распознавание речи: `POST {STT_BASE_URL}/audio/transcriptions`.
 *
 * Запрос — multipart: файл в поле `file`, остальное текстовыми полями.
 * Такой формат понимают faster-whisper-server, Speaches, whisper.cpp и облачный
 * OpenAI, поэтому сменить бэкенд можно одной переменной окружения.
 *
 * Запрашивается `verbose_json`: кроме текста он даёт язык и длительность записи.
 * Поля необязательные — если сборка их не прислала, ответ остаётся валидным.
 */
import { z } from 'zod';

import { LANGUAGE_CODE_PATTERN, type LanguageCode } from '@lt/shared';

import { cleanTranscript } from '../lib/transcript.js';

import { OpenAiCompatibleClient, type RetryPolicy } from './openaiCompatible.js';
import {
  ProviderError,
  type ProviderLogger,
  type SttProvider,
  type SttRequest,
  type SttResult,
} from './types.js';

/** Путь OpenAI-совместимого эндпоинта распознавания. */
export const TRANSCRIPTIONS_PATH = '/audio/transcriptions';

/** Имя файловой части, которую ждёт провайдер (у API приложения оно своё — `audio`). */
export const UPSTREAM_FILE_FIELD_NAME = 'file';

/** Параметры провайдера распознавания речи. */
export interface SttProviderOptions {
  /** Базовый URL OpenAI-совместимого API. */
  baseUrl: string;
  /** Имя модели распознавания, например `Systran/faster-whisper-small`. */
  model: string;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  retry?: Partial<RetryPolicy> | undefined;
  logger?: ProviderLogger | undefined;
}

/** Ответ `verbose_json`; обязателен только текст. */
const transcriptionSchema = z.object({
  text: z.string(),
  language: z.string().nullish(),
  /** Длительность записи в секундах. */
  duration: z.number().nullish(),
  model: z.string().nullish(),
});

/**
 * Приводит язык из ответа распознавателя к коду BCP-47.
 * Whisper нередко отвечает названием языка (`english`) — такое значение
 * не является кодом, и честнее вернуть `null`, чем угадывать.
 */
export function normalizeLanguage(value: string | null | undefined): LanguageCode | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();

  return LANGUAGE_CODE_PATTERN.test(trimmed) ? trimmed : null;
}

/** Провайдер распознавания поверх OpenAI-совместимого HTTP API. */
class OpenAiCompatibleSttProvider implements SttProvider {
  readonly provider = 'openai' as const;
  readonly model: string;

  private readonly client: OpenAiCompatibleClient;

  constructor(options: SttProviderOptions) {
    this.model = options.model;
    this.client = new OpenAiCompatibleClient({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
      retry: options.retry,
      target: 'stt',
      logger: options.logger,
    });
  }

  async transcribe(request: SttRequest): Promise<SttResult> {
    if (request.audio.byteLength === 0) {
      throw new ProviderError('stt', 'invalid_response', 'Пустая аудиозапись');
    }

    const form = new FormData();

    form.append(
      UPSTREAM_FILE_FIELD_NAME,
      new File([request.audio], request.filename, { type: request.contentType }),
    );
    form.append('model', this.model);
    form.append('response_format', 'verbose_json');

    if (request.language !== undefined) {
      form.append('language', request.language);
    }

    if (request.prompt !== undefined && request.prompt.length > 0) {
      form.append('prompt', request.prompt);
    }

    const payload = await this.client.postForm(TRANSCRIPTIONS_PATH, form, {
      signal: request.signal,
    });
    const parsed = transcriptionSchema.safeParse(payload);

    if (!parsed.success) {
      throw new ProviderError(
        'stt',
        'invalid_response',
        'Ответ распознавателя не содержит расшифровки',
        { cause: parsed.error },
      );
    }

    const duration = parsed.data.duration;

    return {
      // На тишине whisper возвращает не пустую строку, а пометку `[BLANK_AUDIO]`:
      // ученику она приедет в поле ввода как его собственная реплика.
      text: cleanTranscript(parsed.data.text),
      language: normalizeLanguage(parsed.data.language),
      durationMs:
        duration === null || duration === undefined || !Number.isFinite(duration)
          ? null
          : Math.max(0, Math.round(duration * 1000)),
      model: parsed.data.model ?? this.model,
    };
  }
}

/** Собирает провайдер распознавания речи с явно заданной конфигурацией. */
export function createSttProvider(options: SttProviderOptions): SttProvider {
  return new OpenAiCompatibleSttProvider(options);
}
