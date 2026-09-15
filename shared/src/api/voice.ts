/**
 * Голосовые эндпоинты: `POST /api/voice/stt`, `POST /api/voice/tts`.
 *
 * Провайдер `browser` означает, что распознавание и синтез выполняет сам браузер
 * и серверные эндпоинты не используются: в этом случае сервер отвечает ошибкой
 * `not_configured`. Что именно активно, клиент узнаёт из `GET /api/config`.
 */
import { z } from 'zod';

import { idSchema } from './common.js';

import { languageCodeSchema } from '../domain/language.js';

/** Кто выполняет распознавание/синтез речи. */
export const VOICE_PROVIDERS = ['browser', 'openai'] as const;

/** Кто выполняет распознавание/синтез речи. */
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

/** Кто выполняет распознавание/синтез речи. */
export const voiceProviderSchema = z.enum(VOICE_PROVIDERS);

/** Форматы аудио, которыми оперирует API. */
export const AUDIO_FORMATS = ['mp3', 'wav', 'ogg', 'webm'] as const;

/** Формат аудио. */
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

/** Формат аудио. */
export const audioFormatSchema = z.enum(AUDIO_FORMATS);

/** MIME-тип, соответствующий каждому формату аудио. */
export const AUDIO_FORMAT_CONTENT_TYPES: Record<AudioFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
};

/** Формат синтеза по умолчанию. */
export const DEFAULT_TTS_FORMAT: AudioFormat = 'mp3';

/** Максимальный размер загружаемой аудиозаписи, байты. */
export const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;

/** MIME-типы, принимаемые эндпоинтом распознавания речи. */
export const STT_SUPPORTED_MIME_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/m4a',
] as const;

/** Максимальная длина текста для синтеза речи, символы. */
export const MAX_TTS_TEXT_LENGTH = 2000;

/**
 * Текстовые поля multipart-запроса `POST /api/voice/stt`.
 * Сама аудиозапись передаётся файловой частью с именем `audio`.
 */
export const sttRequestFieldsSchema = z.object({
  /** Подсказка распознавателю о языке записи; по умолчанию — язык изучения. */
  language: languageCodeSchema.optional(),
  lessonId: idSchema.optional(),
  /** Контекстная подсказка распознавателю (термины урока). */
  prompt: z.string().trim().max(500).optional(),
});

/** Текстовые поля запроса распознавания речи. */
export type SttRequestFields = z.infer<typeof sttRequestFieldsSchema>;

/** Имя файловой части multipart-запроса распознавания речи. */
export const STT_AUDIO_FIELD_NAME = 'audio';

/** Ответ распознавания речи: `text` может быть пустым, если в записи нет речи. */
export const sttResponseSchema = z.object({
  text: z.string().max(8000),
  /** Язык, определённый распознавателем, если он его сообщает. */
  language: languageCodeSchema.nullish(),
  durationMs: z.int().nonnegative().nullish(),
  provider: voiceProviderSchema,
  model: z.string().nullish(),
});

/** Ответ распознавания речи. */
export type SttResponse = z.infer<typeof sttResponseSchema>;

/** Запрос синтеза речи. */
export const ttsRequestSchema = z.object({
  text: z.string().trim().min(1).max(MAX_TTS_TEXT_LENGTH),
  /** Язык произношения; по умолчанию — язык изучения. */
  language: languageCodeSchema.optional(),
  voice: z.string().trim().min(1).max(60).optional(),
  format: audioFormatSchema.default(DEFAULT_TTS_FORMAT),
  /** Скорость речи: 1 — обычная. */
  speed: z.number().min(0.5).max(2).default(1),
});

/** Запрос синтеза речи. */
export type TtsRequest = z.infer<typeof ttsRequestSchema>;

/**
 * Ответ синтеза речи. Аудио отдаётся в base64 внутри JSON, чтобы ошибки
 * приходили тем же конвертом `{ error }`, что и у остальных эндпоинтов
 * (допущение A9: потокового ответа нет).
 */
export const ttsResponseSchema = z.object({
  audioBase64: z.string().min(1),
  /** MIME-тип аудио, соответствует `format` (см. `AUDIO_FORMAT_CONTENT_TYPES`). */
  contentType: z.string().min(1),
  format: audioFormatSchema,
  provider: voiceProviderSchema,
  voice: z.string().nullish(),
  model: z.string().nullish(),
  durationMs: z.int().nonnegative().nullish(),
});

/** Ответ синтеза речи. */
export type TtsResponse = z.infer<typeof ttsResponseSchema>;
