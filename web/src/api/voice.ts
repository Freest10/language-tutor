/**
 * Обращения к голосовым эндпоинтам: `POST /api/voice/stt` и `POST /api/voice/tts`.
 *
 * Модуль знает только про HTTP и схемы `@lt/shared`; состояния микрофона,
 * очередь воспроизведения и подсказки пользователю живут в `features/voice`.
 *
 * Два отличия от остальных разделов, о которые легко споткнуться:
 * - распознавание принимает `multipart/form-data`, аудио идёт частью `audio`
 *   (`STT_AUDIO_FIELD_NAME`), остальные поля — текстовые;
 * - синтез отвечает не бинарным потоком, а JSON с `audioBase64` (допущение A9),
 *   поэтому blob собирается на клиенте (`decodeAudioBase64`).
 *
 * Провайдер `browser` — не сбой: сервер отвечает 501 `not_configured`
 * с `details.reason = 'stt_browser_only' | 'tts_browser_only'`, и это сигнал
 * «делай через Web Speech API» (`isBrowserOnlyError`).
 *
 * Допущение A10: аудиозапись никуда, кроме `/voice/stt`, не уходит и после
 * ответа не хранится — вызывающий код обязан её отпустить.
 */
import {
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_TTS_TEXT_LENGTH,
  STT_AUDIO_FIELD_NAME,
  STT_SUPPORTED_MIME_TYPES,
  sttResponseSchema,
  ttsResponseSchema,
  type AudioFormat,
  type LanguageCode,
  type SttResponse,
  type TtsResponse,
} from '@lt/shared';

import { api, isApiError, type RequestOptions } from './client';
import { LONG_TIMEOUT_MS } from './config';

/** Путь распознавания речи (без префикса `/api` — его подставляет клиент). */
export const VOICE_STT_PATH = '/voice/stt';

/** Путь синтеза речи. */
export const VOICE_TTS_PATH = '/voice/tts';

/** Параметры голосового запроса: схему и таймаут модуль задаёт сам. */
export type VoiceRequestOptions = Pick<RequestOptions, 'signal'>;

/** Причина, по которой сервер отказался работать: распознавание делает браузер. */
export const STT_BROWSER_ONLY_REASON = 'stt_browser_only';

/** Причина, по которой сервер отказался работать: синтез делает браузер. */
export const TTS_BROWSER_ONLY_REASON = 'tts_browser_only';

/**
 * Ответил ли сервер «эту работу выполняет браузер».
 *
 * Такой ответ приходит как 501 `not_configured`, но ошибкой для пользователя
 * не является: интерфейс должен переключиться на Web Speech API.
 *
 * @param error пойманное исключение запроса.
 * @param kind какой эндпоинт вызывали.
 */
export function isBrowserOnlyError(error: unknown, kind: 'stt' | 'tts'): boolean {
  if (!isApiError(error) || !error.isNotConfigured) {
    return false;
  }

  const expected = kind === 'stt' ? STT_BROWSER_ONLY_REASON : TTS_BROWSER_ONLY_REASON;
  const reason = (error.details as { reason?: unknown } | null | undefined)?.reason;

  // Провайдер мог смениться после старта сервера: страховкой считаем сам код 501.
  return typeof reason === 'string' ? reason === expected : true;
}

/** Расширение файла записи по её MIME-типу — по нему распознаватель узнаёт контейнер. */
const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
};

/** Отбрасывает параметры MIME-типа: `audio/webm;codecs=opus` → `audio/webm`. */
export function baseMimeType(value: string): string {
  return value.split(';')[0]?.trim().toLowerCase() ?? '';
}

/** Имя файла записи: расширение должно соответствовать контейнеру. */
export function audioFileName(mimeType: string): string {
  return `speech.${EXTENSION_BY_MIME_TYPE[baseMimeType(mimeType)] ?? 'bin'}`;
}

/** Почему запись отклонена ещё до отправки на сервер. */
export type AudioRejection = 'empty' | 'too_large' | 'unsupported_format';

/**
 * Проверяет запись до отправки: пустоту, размер и формат контейнера.
 *
 * @param blob запись с микрофона.
 * @param maxBytes предел из `GET /api/config` (`limits.maxAudioUploadBytes`).
 * @returns причину отказа или `null`, если запись можно отправлять.
 */
export function audioRejection(
  blob: Blob,
  maxBytes: number = MAX_AUDIO_UPLOAD_BYTES,
): AudioRejection | null {
  if (blob.size === 0) {
    return 'empty';
  }

  if (blob.size > maxBytes) {
    return 'too_large';
  }

  const mimeType = baseMimeType(blob.type);

  // Пустой тип оставляем серверу: браузер не всегда сообщает контейнер записи.
  if (mimeType.length > 0 && !(STT_SUPPORTED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return 'unsupported_format';
  }

  return null;
}

/** Запись и текстовые поля запроса распознавания. */
export interface TranscribeAudioInput {
  /** Запись с микрофона; после ответа хранить её не нужно (A10). */
  audio: Blob;
  /** Подсказка о языке записи — изучаемый язык из профиля. */
  language?: LanguageCode;
  /** Контекстная подсказка распознавателю: термины, имена собственные. */
  prompt?: string;
  /** Идентификатор урока, если запись сделана внутри урока. */
  lessonId?: string;
}

/** Собирает multipart-тело: запись идёт частью с именем `audio`. */
export function buildSttFormData(input: TranscribeAudioInput): FormData {
  const form = new FormData();

  form.append(STT_AUDIO_FIELD_NAME, input.audio, audioFileName(input.audio.type));

  if (input.language) {
    form.append('language', input.language);
  }

  if (input.lessonId) {
    form.append('lessonId', input.lessonId);
  }

  const prompt = input.prompt?.trim();

  if (prompt) {
    form.append('prompt', prompt.slice(0, 500));
  }

  return form;
}

/**
 * `POST /api/voice/stt` — расшифровка записи на сервере.
 *
 * Таймаут задан явно: за эндпоинтом стоит внешняя модель, и обычных 15 секунд
 * ей не хватает.
 */
export function transcribeAudio(
  input: TranscribeAudioInput,
  { signal }: VoiceRequestOptions = {},
): Promise<SttResponse> {
  return api.upload(VOICE_STT_PATH, buildSttFormData(input), {
    schema: sttResponseSchema,
    timeoutMs: LONG_TIMEOUT_MS,
    signal,
  });
}

/** Тело запроса синтеза речи; `format` и `speed` сервер подставляет сам. */
export interface SynthesizeSpeechInput {
  text: string;
  /** Язык произношения — изучаемый язык из профиля. */
  language?: LanguageCode;
  voice?: string;
  format?: AudioFormat;
  /** Скорость речи: 1 — обычная, меньше — медленнее (уровни A1/A2). */
  speed?: number;
}

/** Обрезает текст до предела `MAX_TTS_TEXT_LENGTH`: длиннее сервер не принимает. */
export function clampTtsText(text: string, maxLength: number = MAX_TTS_TEXT_LENGTH): string {
  const trimmed = text.trim();

  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/** `POST /api/voice/tts` — синтез речи на сервере; аудио приходит в base64. */
export function synthesizeSpeech(
  input: SynthesizeSpeechInput,
  { signal }: VoiceRequestOptions = {},
): Promise<TtsResponse> {
  return api.post(
    VOICE_TTS_PATH,
    {
      text: clampTtsText(input.text),
      language: input.language,
      voice: input.voice,
      format: input.format,
      speed: input.speed,
    },
    { schema: ttsResponseSchema, timeoutMs: LONG_TIMEOUT_MS, signal },
  );
}

/** Собирает blob из base64-аудио ответа синтеза (A9: потокового ответа нет). */
export function decodeAudioBase64(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: contentType });
}

/** Аудио ответа синтеза в виде blob, готового для `URL.createObjectURL`. */
export function ttsAudioBlob(response: TtsResponse): Blob {
  return decodeAudioBase64(response.audioBase64, response.contentType);
}
