/**
 * Обращения к голосовым эндпоинтам: тела запросов, проверки записи до отправки
 * и разбор ответа синтеза.
 *
 * Модуль `api/voice` — граница между голосовым слоем и HTTP, поэтому
 * проверяется он сам по себе, без интерфейса. Здесь же закреплены два молчаливых
 * решения, которые иначе замечаются только по странному поведению в браузере:
 * подсказка распознавателю обрезается до 500 символов, а текст для озвучивания —
 * до предела схемы `MAX_TTS_TEXT_LENGTH` (сверх него сервер отвечает 400).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_PREFIX,
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_TTS_TEXT_LENGTH,
  STT_AUDIO_FIELD_NAME,
  type ApiErrorResponse,
  type SttResponse,
  type TtsResponse,
} from '@lt/shared';

import { ApiError } from '../src/api/client';
import {
  audioFileName,
  audioRejection,
  baseMimeType,
  buildSttFormData,
  clampTtsText,
  decodeAudioBase64,
  isBrowserOnlyError,
  STT_BROWSER_ONLY_REASON,
  synthesizeSpeech,
  transcribeAudio,
  ttsAudioBlob,
  TTS_BROWSER_ONLY_REASON,
  VOICE_STT_PATH,
  VOICE_TTS_PATH,
} from '../src/api/voice';

/** Запрос, дошедший до подменённого `fetch`. */
interface FetchRecord {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
  /** Путь запроса без query-параметров. */
  path: string;
}

/** Все запросы текущего теста в порядке отправки. */
let calls: FetchRecord[] = [];

/** Ответ с телом-JSON. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Подменяет `fetch` обработчиком, который отвечает по адресу запроса. */
function stubFetch(handler: (record: FetchRecord) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const record: FetchRecord = {
        url,
        method: init?.method ?? 'GET',
        body: init?.body,
        path: new URL(url, 'http://localhost').pathname,
      };

      calls.push(record);

      return Promise.resolve(handler(record));
    }),
  );
}

/** Ответ распознавания речи. */
const STT_RESPONSE: SttResponse = {
  text: 'I would like a coffee',
  language: 'en',
  durationMs: 1200,
  provider: 'openai',
  model: 'whisper-1',
};

/** Ответ синтеза речи: аудио приходит в base64 внутри JSON (A9). */
const TTS_RESPONSE: TtsResponse = {
  audioBase64: btoa('fake-mp3-bytes'),
  contentType: 'audio/mpeg',
  format: 'mp3',
  provider: 'openai',
  voice: 'alloy',
  model: 'gpt-4o-mini-tts',
  durationMs: 900,
};

/** Отказ сервера в конверте `{ error }`. */
function errorResponse(
  code: ApiErrorResponse['error']['code'],
  status: number,
  details?: unknown,
): Response {
  return jsonResponse({ error: { code, message: `HTTP ${status}`, details } }, status);
}

/** Запись с микрофона заданного размера и типа. */
function recording(bytes: number, type = 'audio/webm'): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('тип и имя файла записи', () => {
  it('отбрасывает параметры MIME-типа и приводит его к нижнему регистру', () => {
    expect(baseMimeType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMimeType('AUDIO/WebM')).toBe('audio/webm');
    expect(baseMimeType(' audio/ogg ; codecs=opus')).toBe('audio/ogg');
    expect(baseMimeType('')).toBe('');
  });

  it('даёт расширение по контейнеру, а незнакомому типу — `bin`', () => {
    // Распознаватель узнаёт контейнер по расширению: `.webm` для `.wav` — отказ.
    expect(audioFileName('audio/webm;codecs=opus')).toBe('speech.webm');
    expect(audioFileName('audio/ogg')).toBe('speech.ogg');
    expect(audioFileName('audio/wav')).toBe('speech.wav');
    expect(audioFileName('audio/mp4')).toBe('speech.m4a');
    expect(audioFileName('audio/mpeg')).toBe('speech.mp3');
    expect(audioFileName('audio/aiff')).toBe('speech.bin');
    expect(audioFileName('')).toBe('speech.bin');
  });
});

describe('проверка записи до отправки', () => {
  it('пустая запись отклоняется: говорить начали после остановки', () => {
    expect(audioRejection(recording(0))).toBe('empty');
  });

  it('запись больше предела отклоняется, не доходя до сети', () => {
    expect(audioRejection(recording(MAX_AUDIO_UPLOAD_BYTES + 1))).toBe('too_large');
    // Предел приходит из `GET /api/config`, а не зашит в клиент.
    expect(audioRejection(recording(2048), 1024)).toBe('too_large');
    expect(audioRejection(recording(512), 1024)).toBeNull();
  });

  it('незнакомый контейнер отклоняется, а неизвестный тип оставляем серверу', () => {
    expect(audioRejection(recording(128, 'audio/aiff'))).toBe('unsupported_format');
    expect(audioRejection(recording(128, 'audio/webm;codecs=opus'))).toBeNull();
    // Браузер не всегда сообщает тип записи: решает сервер, а не клиент.
    expect(audioRejection(recording(128, ''))).toBeNull();
  });
});

describe('тело запроса распознавания', () => {
  it('кладёт запись в поле «audio» с именем по контейнеру и передаёт поля', () => {
    const form = buildSttFormData({
      audio: recording(64, 'audio/ogg'),
      language: 'en',
      lessonId: 'l-1',
      prompt: '  past simple  ',
    });
    const audio = form.get(STT_AUDIO_FIELD_NAME);

    expect(audio).toBeInstanceOf(File);
    expect((audio as File).name).toBe('speech.ogg');
    expect(form.get('language')).toBe('en');
    expect(form.get('lessonId')).toBe('l-1');
    expect(form.get('prompt')).toBe('past simple');
  });

  it('обрезает подсказку распознавателю до 500 символов', () => {
    const form = buildSttFormData({ audio: recording(64), prompt: 'a'.repeat(600) });

    expect(String(form.get('prompt'))).toHaveLength(500);
  });

  it('не отправляет пустые необязательные поля', () => {
    const form = buildSttFormData({ audio: recording(64), prompt: '   ' });

    expect(form.get('prompt')).toBeNull();
    expect(form.get('language')).toBeNull();
    expect(form.get('lessonId')).toBeNull();
  });

  it('отправляет multipart на `/voice/stt` и разбирает ответ по схеме', async () => {
    stubFetch(() => jsonResponse(STT_RESPONSE));

    const response = await transcribeAudio({ audio: recording(64), language: 'en' });

    expect(response.text).toBe('I would like a coffee');
    expect(calls[0]?.path).toBe(`${API_PREFIX}${VOICE_STT_PATH}`);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBeInstanceOf(FormData);
  });
});

describe('текст для озвучивания', () => {
  it('обрезает пробелы по краям и оставляет короткий текст как есть', () => {
    expect(clampTtsText('  Hello there  ')).toBe('Hello there');
    expect(clampTtsText('Hello')).toHaveLength(5);
  });

  it('молча обрезает текст длиннее предела схемы', () => {
    const long = 'a'.repeat(MAX_TTS_TEXT_LENGTH + 100);

    // Поведение осознанное и задокументированное: сверх `MAX_TTS_TEXT_LENGTH`
    // сервер отвечает 400, и озвучить половину реплики лучше, чем ничего.
    expect(clampTtsText(long)).toHaveLength(MAX_TTS_TEXT_LENGTH);
    expect(clampTtsText(long, 10)).toBe('aaaaaaaaaa');
  });

  it('обрезанный текст уходит на сервер именно обрезанным', async () => {
    stubFetch(() => jsonResponse(TTS_RESPONSE));

    await synthesizeSpeech({ text: 'b'.repeat(MAX_TTS_TEXT_LENGTH + 50), language: 'en' });

    const sent = JSON.parse(String(calls[0]?.body)) as { text: string; language: string };

    expect(calls[0]?.path).toBe(`${API_PREFIX}${VOICE_TTS_PATH}`);
    expect(sent.text).toHaveLength(MAX_TTS_TEXT_LENGTH);
    expect(sent.language).toBe('en');
  });

  it('отказ синтеза приходит как `ApiError`, а не как сырой ответ', async () => {
    stubFetch(() => errorResponse('upstream_unavailable', 503));

    await expect(synthesizeSpeech({ text: 'Hello' })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('аудио ответа синтеза', () => {
  it('собирает blob из base64 с типом из ответа', async () => {
    const blob = decodeAudioBase64(btoa('fake-mp3-bytes'), 'audio/mpeg');

    expect(blob.type).toBe('audio/mpeg');
    expect(blob.size).toBe('fake-mp3-bytes'.length);
    expect(await blob.text()).toBe('fake-mp3-bytes');
  });

  it('берёт тип и данные из полей ответа, а не угадывает их', async () => {
    const blob = ttsAudioBlob(TTS_RESPONSE);

    expect(blob.type).toBe(TTS_RESPONSE.contentType);
    expect(await blob.text()).toBe('fake-mp3-bytes');
  });
});

describe('ответ «это делает браузер»', () => {
  /** Отказ 501 с указанной причиной в `details`. */
  function notConfigured(reason?: string): ApiError {
    return new ApiError({
      code: 'not_configured',
      message: 'HTTP 501',
      status: 501,
      details: reason === undefined ? undefined : { reason },
    });
  }

  it('различает причины распознавания и синтеза', () => {
    expect(isBrowserOnlyError(notConfigured(STT_BROWSER_ONLY_REASON), 'stt')).toBe(true);
    expect(isBrowserOnlyError(notConfigured(STT_BROWSER_ONLY_REASON), 'tts')).toBe(false);
    expect(isBrowserOnlyError(notConfigured(TTS_BROWSER_ONLY_REASON), 'tts')).toBe(true);
  });

  it('считает страховкой сам код 501 без причины', () => {
    // Провайдер мог смениться после старта сервера: причины в ответе может не быть.
    expect(isBrowserOnlyError(notConfigured(), 'stt')).toBe(true);
  });

  it('не принимает за браузерный режим другие отказы', () => {
    expect(isBrowserOnlyError(notConfigured('model_missing'), 'stt')).toBe(false);
    expect(
      isBrowserOnlyError(
        new ApiError({ code: 'upstream_unavailable', message: 'нет связи', status: 503 }),
        'stt',
      ),
    ).toBe(false);
    expect(isBrowserOnlyError(new Error('что угодно'), 'stt')).toBe(false);
    expect(isBrowserOnlyError(null, 'tts')).toBe(false);
  });
});
