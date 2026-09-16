/**
 * Голос: распознавание речи и синтез на стороне сервера.
 *
 * - `POST /api/voice/stt` — multipart с аудиозаписью в поле `audio`;
 * - `POST /api/voice/tts` — JSON с текстом; аудио возвращается в base64
 *   (допущение A9), чтобы отказ приходил тем же конвертом `{ error }`.
 *
 * При `STT_PROVIDER=browser` / `TTS_PROVIDER=browser` эндпоинты отключены и
 * отвечают 501 `not_configured` с пометкой `stt_browser_only` / `tts_browser_only`:
 * это не сбой, а сообщение клиенту «делай это через Web Speech API».
 *
 * Аудио нигде не сохраняется: запись живёт в памяти процесса до ответа провайдера.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  MAX_AUDIO_UPLOAD_BYTES,
  STT_AUDIO_FIELD_NAME,
  STT_SUPPORTED_MIME_TYPES,
  sttRequestFieldsSchema,
  sttResponseSchema,
  ttsRequestSchema,
  ttsResponseSchema,
  type SttResponse,
  type TtsResponse,
} from '@lt/shared';

import { badRequest, payloadTooLarge, unsupportedMediaType } from '../lib/httpErrors.js';
import { isFileTooLarge, isMultipartLimit } from '../lib/multipart.js';
import { parseBody, parseWith } from '../lib/validate.js';
import { resolveSttProvider, resolveTtsProvider } from '../providers/factory.js';
import { providerErrorToAppError } from '../providers/types.js';

/** Предел длины расшифровки в ответе (`sttResponseSchema`). */
const MAX_TRANSCRIPT_LENGTH = 8000;

/**
 * Пределы разбора multipart-запроса распознавания: одна запись и несколько
 * коротких текстовых полей (`language`, `prompt`). Предел размера задан здесь,
 * а не общим `MAX_UPLOAD_MB`: запись не должна занимать память сверх того, что
 * разрешает контракт голосового эндпоинта.
 */
const AUDIO_LIMITS = {
  parts: 8,
  files: 1,
  fields: 6,
  fieldSize: 4096,
  fileSize: MAX_AUDIO_UPLOAD_BYTES,
};

/** Расширение файла по MIME-типу: по нему распознаватель определяет контейнер. */
const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
};

/** Разобранная файловая часть запроса распознавания. */
interface AudioUpload {
  bytes: Buffer;
  filename: string;
  mimeType: string;
}

/** Отбрасывает параметры `Content-Type`: `audio/webm;codecs=opus` → `audio/webm`. */
function baseMimeType(value: string): string {
  return value.split(';')[0]?.trim().toLowerCase() ?? '';
}

/** Имя файла без пути и подозрительных символов; при сомнении — своё по MIME. */
function safeFilename(original: string | undefined, mimeType: string): string {
  const fallback = `speech.${EXTENSION_BY_MIME_TYPE[mimeType] ?? 'bin'}`;
  const candidate = original?.split(/[\\/]/).pop()?.trim() ?? '';

  return /^[\w.-]{1,100}$/.test(candidate) && /\.[a-z0-9]{1,5}$/i.test(candidate)
    ? candidate
    : fallback;
}

/** Отказ «запись слишком большая»: один текст на оба способа его обнаружить. */
function tooLargeAudio(cause?: unknown): ReturnType<typeof payloadTooLarge> {
  return payloadTooLarge('Аудиозапись превышает допустимый размер', {
    details: { reason: 'audio_too_large', maxBytes: MAX_AUDIO_UPLOAD_BYTES },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Читает multipart-запрос: аудиозапись и текстовые поля. */
async function readAudioUpload(
  request: FastifyRequest,
): Promise<{ audio: AudioUpload; fields: Record<string, string> }> {
  if (!request.isMultipart()) {
    throw unsupportedMediaType('Ожидается multipart/form-data с аудиозаписью', {
      details: { reason: 'multipart_required', field: STT_AUDIO_FIELD_NAME },
    });
  }

  const fields: Record<string, string> = {};
  let audio: AudioUpload | undefined;

  try {
    for await (const part of request.parts({ limits: AUDIO_LIMITS })) {
      if (part.type !== 'file') {
        fields[part.fieldname] = String(part.value);

        continue;
      }

      // Поток каждой части нужно вычитать, иначе разбор запроса не завершится.
      if (part.fieldname !== STT_AUDIO_FIELD_NAME || audio !== undefined) {
        part.file.resume();

        continue;
      }

      const bytes = await part.toBuffer();

      if (part.file.truncated || bytes.byteLength > MAX_AUDIO_UPLOAD_BYTES) {
        throw tooLargeAudio();
      }

      const mimeType = baseMimeType(part.mimetype);

      if (!(STT_SUPPORTED_MIME_TYPES as readonly string[]).includes(mimeType)) {
        throw unsupportedMediaType(`Формат аудио не поддерживается: ${mimeType || 'не указан'}`, {
          details: {
            reason: 'audio_mime_not_supported',
            mimeType,
            supported: STT_SUPPORTED_MIME_TYPES,
          },
        });
      }

      audio = { bytes, filename: safeFilename(part.filename, mimeType), mimeType };
    }
  } catch (error) {
    // Предел `fileSize` разбор запроса прерывает исключением, а не флагом
    // `truncated`, а пределы числа частей рвут поток запроса: ответ в обоих
    // случаях один и тот же — 413, а не 500.
    if (isFileTooLarge(error) || isMultipartLimit(error)) {
      throw tooLargeAudio(error);
    }

    throw error;
  }

  if (audio === undefined) {
    throw badRequest(`Не передана аудиозапись в поле "${STT_AUDIO_FIELD_NAME}"`, {
      details: { reason: 'audio_missing', field: STT_AUDIO_FIELD_NAME },
    });
  }

  if (audio.bytes.byteLength === 0) {
    throw badRequest('Аудиозапись пуста', {
      details: { reason: 'audio_empty', field: STT_AUDIO_FIELD_NAME },
    });
  }

  return { audio, fields };
}

/** `POST /api/voice/stt`: расшифровывает присланную запись. */
async function transcribe(request: FastifyRequest): Promise<SttResponse> {
  const provider = resolveSttProvider({ logger: request.log });
  const { audio, fields } = await readAudioUpload(request);
  const parsed = parseWith(sttRequestFieldsSchema, fields, 'body');

  try {
    const result = await provider.transcribe({
      audio: audio.bytes,
      filename: audio.filename,
      contentType: audio.mimeType,
      language: parsed.language,
      prompt: parsed.prompt,
    });

    return {
      text: result.text.slice(0, MAX_TRANSCRIPT_LENGTH),
      language: result.language,
      durationMs: result.durationMs,
      provider: provider.provider,
      model: result.model,
    };
  } catch (error) {
    throw providerErrorToAppError(error, 'stt');
  }
}

/** `POST /api/voice/tts`: синтезирует речь и отдаёт аудио в base64. */
async function synthesize(request: FastifyRequest): Promise<TtsResponse> {
  const provider = resolveTtsProvider({ logger: request.log });
  const body = parseBody(request, ttsRequestSchema);

  try {
    const result = await provider.synthesize({
      text: body.text,
      voice: body.voice,
      format: body.format,
      speed: body.speed,
    });

    return {
      audioBase64: Buffer.from(result.audio).toString('base64'),
      contentType: result.contentType,
      format: result.format,
      provider: provider.provider,
      voice: result.voice,
      model: result.model,
    };
  } catch (error) {
    throw providerErrorToAppError(error, 'tts');
  }
}

/** Голосовые маршруты. */
export const voiceRoutes: FastifyPluginAsync = async (app) => {
  app.post('/voice/stt', { schema: { response: { 200: sttResponseSchema } } }, transcribe);
  app.post('/voice/tts', { schema: { response: { 200: ttsResponseSchema } } }, synthesize);
};
