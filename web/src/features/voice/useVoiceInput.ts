/**
 * Голосовой ввод: единая точка входа для всех разделов приложения.
 *
 * Хук сам выбирает путь по конфигурации сервера (`GET /api/config`):
 * - `sttProvider === 'openai'` — пишем звук `useMicRecorder` и отправляем
 *   его в `POST /api/voice/stt`, получая финальную расшифровку;
 * - `sttProvider === 'browser'` — распознаёт сам браузер (`useSpeechRecognition`),
 *   с промежуточными результатами и без обращения к серверу;
 * - возможность недоступна — вместо молчащего микрофона отдаём понятный отказ
 *   с подсказкой и предложением набрать текст (допущение A14).
 *
 * Язык распознавания приходит аргументом: это изучаемый язык из профиля,
 * а не язык интерфейса (допущение A12), и хук его не угадывает.
 *
 * Хук ничего не знает про уроки: `lessonId` — необязательное поле контракта
 * `POST /api/voice/stt`, которое просто пробрасывается дальше.
 *
 * Допущение A10: запись уходит только на распознавание и нигде не сохраняется —
 * ни в состоянии хука, ни в кэше запросов.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MAX_AUDIO_UPLOAD_BYTES, type LanguageCode, type VoiceProvider } from '@lt/shared';

import { useMicRecorder, type MicFailureKind } from './useMicRecorder';
import { useSpeechRecognition, type SpeechFailure } from './useSpeechRecognition';
import { toWav16Mono } from './wav16';

import { isApiError } from '../../api/client';
import { audioRejection, isBrowserOnlyError, transcribeAudio } from '../../api/voice';
import { useCapabilities } from '../../context/CapabilitiesProvider';
import { useT } from '../../i18n/useT';

/** Что именно не даёт работать голосу. */
export type VoiceFailureKind =
  /** Нужного браузерного API нет, и включить его нельзя (A14). */
  | 'unsupported'
  /** Пользователь запретил доступ к микрофону. */
  | 'permission_denied'
  /** Микрофон не найден или занят другим приложением. */
  | 'no_device'
  /** В записи не нашлось речи. */
  | 'no_speech'
  /** Сервер ответил «это делает браузер» (501 `*_browser_only`). */
  | 'browser_only'
  /** Серверный провайдер выбран, но не настроен (нет ключа или модели). */
  | 'server_not_configured'
  /** Запись длиннее, чем принимает сервер. */
  | 'too_large'
  /** Контейнер записи сервер не принимает. */
  | 'unsupported_format'
  /** Сервер недоступен. */
  | 'network'
  /** Сервер не ответил за отведённое время. */
  | 'timeout'
  /** Прочий отказ. */
  | 'failed';

/** Какая половина голосового слоя отказала: ввод или озвучивание. */
export type VoiceChannel = 'input' | 'output';

/** Отказ голосового слоя вместе с готовым текстом для пользователя. */
export interface VoiceFailure {
  kind: VoiceFailureKind;
  /** Ввод или озвучивание. */
  channel: VoiceChannel;
  /** Что случилось — на языке интерфейса. */
  message: string;
  /** Что с этим делать; `null` — подсказки нет. */
  hint: string | null;
  /** Имеет ли смысл просто повторить попытку. */
  canRetry: boolean;
  /** Помогает только переключение на серверного провайдера в `.env` (A14). */
  needsServerFallback: boolean;
  /** Стоит ли предложить набрать текст вместо голоса. */
  suggestTyping: boolean;
  /** Исходное исключение — для журнала, в интерфейс не показывается. */
  cause?: unknown;
}

/** Отказы, после которых повторная попытка имеет смысл. */
const RETRIABLE_KINDS: ReadonlySet<VoiceFailureKind> = new Set<VoiceFailureKind>([
  'permission_denied',
  'no_device',
  'no_speech',
  'too_large',
  'network',
  'timeout',
  'failed',
]);

/** Отказы, при которых голос не работает вовсе — предлагаем набрать текст. */
const TYPING_KINDS: ReadonlySet<VoiceFailureKind> = new Set<VoiceFailureKind>([
  'unsupported',
  'permission_denied',
  'no_device',
  'browser_only',
  'server_not_configured',
  'unsupported_format',
  'failed',
]);

/** Ключ подсказки для каждой причины отказа. */
function hintKey(kind: VoiceFailureKind, channel: VoiceChannel): string | null {
  switch (kind) {
    case 'unsupported':
      return channel === 'input' ? 'hints.enableServerStt' : 'hints.enableServerTts';
    case 'permission_denied':
      return 'hints.allowMicrophone';
    case 'no_device':
      return 'hints.checkMicrophone';
    case 'no_speech':
      return 'hints.speakAgain';
    case 'browser_only':
      return 'hints.browserMode';
    case 'server_not_configured':
      return 'hints.checkServerConfig';
    case 'too_large':
    case 'unsupported_format':
      return 'hints.shorterRecording';
    case 'network':
    case 'timeout':
    case 'failed':
      return 'hints.retry';
    default:
      return null;
  }
}

/** Собирает отказ с переводами: одинаково для распознавания и синтеза. */
export function useVoiceFailure(): (
  kind: VoiceFailureKind,
  channel: VoiceChannel,
  cause?: unknown,
) => VoiceFailure {
  const t = useT('voice');

  return useCallback(
    (kind, channel, cause): VoiceFailure => {
      const hint = hintKey(kind, channel);

      return {
        kind,
        channel,
        message: t(`${channel}.errors.${kind}`),
        hint: hint ? t(hint) : null,
        canRetry: RETRIABLE_KINDS.has(kind),
        needsServerFallback: kind === 'unsupported',
        suggestTyping: channel === 'input' && TYPING_KINDS.has(kind),
        cause,
      };
    },
    [t],
  );
}

/** Причина отказа записи в терминах голосового слоя. */
function kindFromMicFailure(kind: MicFailureKind): VoiceFailureKind {
  switch (kind) {
    case 'unsupported':
      return 'unsupported';
    case 'permission_denied':
      return 'permission_denied';
    case 'no_device':
      return 'no_device';
    case 'empty':
      return 'no_speech';
    default:
      return 'failed';
  }
}

/** Причина отказа браузерного распознавания в терминах голосового слоя. */
function kindFromSpeechFailure(failure: SpeechFailure): VoiceFailureKind {
  switch (failure.kind) {
    case 'unsupported':
      return 'unsupported';
    case 'permission_denied':
      return 'permission_denied';
    case 'no_device':
      return 'no_device';
    case 'no_speech':
      return 'no_speech';
    case 'network':
      return 'network';
    case 'language_not_supported':
      return 'unsupported';
    default:
      return 'failed';
  }
}

/** Причина отказа сервера распознавания в терминах голосового слоя. */
export function kindFromApiError(error: unknown, channel: VoiceChannel): VoiceFailureKind {
  if (isBrowserOnlyError(error, channel === 'input' ? 'stt' : 'tts')) {
    return 'browser_only';
  }

  if (!isApiError(error)) {
    return 'failed';
  }

  if (error.isTimeout) {
    return 'timeout';
  }

  if (error.isNetworkError) {
    return 'network';
  }

  if (error.isNotConfigured) {
    return 'server_not_configured';
  }

  if (error.status === 413 || error.code === 'payload_too_large') {
    return 'too_large';
  }

  if (error.status === 415 || error.code === 'unsupported_media_type') {
    return 'unsupported_format';
  }

  return 'failed';
}

/** Расшифровка последней реплики. */
export interface VoiceInputResult {
  /** Текст реплики; пустым не бывает — пустая расшифровка считается отказом. */
  text: string;
  /** Кто распознавал. */
  provider: VoiceProvider;
  /** Язык, который сообщил распознаватель; `null` — он его не определяет. */
  language: LanguageCode | null;
  /** Длительность реплики, миллисекунды; `null` — неизвестна. */
  durationMs: number | null;
}

/** Состояние голосового ввода. */
export type VoiceInputStatus =
  /** Голосовой ввод недоступен — см. `failure`. */
  | 'unavailable'
  /** Готов слушать. */
  | 'idle'
  /** Ждём разрешения на доступ к микрофону. */
  | 'requesting'
  /** Слушаем речь. */
  | 'listening'
  /** Распознаём сказанное. */
  | 'processing'
  /** Последняя попытка не удалась — см. `failure`. */
  | 'error';

/** Настройки голосового ввода. */
export interface UseVoiceInputOptions {
  /** Язык речи ученика — изучаемый язык из профиля (BCP-47). */
  language: LanguageCode;
  /** Контекстная подсказка распознавателю: термины и имена из текущего диалога. */
  prompt?: string;
  /** Необязательное поле контракта `POST /api/voice/stt`. */
  lessonId?: string;
  /** Вызывается с готовой расшифровкой. */
  onResult?: (result: VoiceInputResult) => void;
  /** Вызывается при отказе — тем же объектом, что лежит в `failure`. */
  onFailure?: (failure: VoiceFailure) => void;
}

/** Состояние голосового ввода и управление им. */
export interface UseVoiceInputResult {
  status: VoiceInputStatus;
  /** Можно ли начинать запись прямо сейчас. */
  available: boolean;
  /** Кто распознаёт речь; `null` — конфигурация ещё не получена. */
  provider: VoiceProvider | null;
  /** Распознаёт ли браузер (без обращения к серверу). */
  runsInBrowser: boolean;
  isListening: boolean;
  isProcessing: boolean;
  /** Незаконченная фраза: есть только в браузерном режиме. */
  interimText: string;
  /** Последняя финальная расшифровка. */
  text: string;
  /** Уровень входного сигнала 0…1: есть только в серверном режиме. */
  level: number;
  /** Текущий отказ: и недоступность возможности, и провал последней попытки. */
  failure: VoiceFailure | null;
  /** Начинает слушать; `false` — не удалось (см. `failure`). */
  start: () => Promise<boolean>;
  /** Заканчивает реплику и отдаёт расшифровку; `null` — расшифровки нет. */
  stop: () => Promise<VoiceInputResult | null>;
  /** Прерывает реплику: запись отбрасывается, на сервер ничего не уходит. */
  cancel: () => void;
  /** Забывает прошлую реплику и отказ. */
  reset: () => void;
}

/** Голосовой ввод: запись, распознавание и понятная деградация. */
export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const { language, prompt, lessonId, onResult, onFailure } = options;

  const { stt, sttProvider, config } = useCapabilities();
  const describeFailure = useVoiceFailure();

  const runsInBrowser = stt.runsInBrowser;
  const recorder = useMicRecorder({ meterLevel: !runsInBrowser });
  const recognition = useSpeechRecognition({ language });

  const [state, setState] = useState<'idle' | 'requesting' | 'listening' | 'processing'>('idle');
  const [text, setText] = useState('');
  const [failure, setFailure] = useState<VoiceFailure | null>(null);

  const callbacksRef = useRef({ onResult, onFailure });

  useEffect(() => {
    callbacksRef.current = { onResult, onFailure };
  }, [onFailure, onResult]);

  const maxAudioBytes = config?.limits.maxAudioUploadBytes ?? MAX_AUDIO_UPLOAD_BYTES;
  // Пока конфигурация не пришла, считаем, что распознаватель принимает запись
  // как есть: так работают все серверные провайдеры, кроме встроенного.
  const requiresWav16 = config?.stt.requiresWav16 ?? false;

  /** Запоминает отказ и сообщает о нём вызывающему коду. */
  const fail = useCallback(
    (kind: VoiceFailureKind, cause?: unknown): VoiceFailure => {
      const next = describeFailure(kind, 'input', cause);

      setFailure(next);
      callbacksRef.current.onFailure?.(next);

      return next;
    },
    [describeFailure],
  );

  /** Недоступность возможности до первой попытки: её видно сразу, а не после нажатия. */
  const capabilityFailure = useMemo<VoiceFailure | null>(() => {
    if (stt.available || stt.blocker === null || stt.blocker === 'config_unavailable') {
      return null;
    }

    return describeFailure(
      stt.blocker === 'server_not_configured' ? 'server_not_configured' : 'unsupported',
      'input',
      stt.reason,
    );
  }, [describeFailure, stt.available, stt.blocker, stt.reason]);

  const { start: startRecorder, stop: stopRecorder, cancel: cancelRecorder } = recorder;
  const {
    start: startRecognition,
    stop: stopRecognition,
    abort: abortRecognition,
    reset: resetRecognition,
  } = recognition;

  const start = useCallback(async (): Promise<boolean> => {
    if (capabilityFailure) {
      setFailure(capabilityFailure);
      callbacksRef.current.onFailure?.(capabilityFailure);

      return false;
    }

    setFailure(null);
    setText('');
    setState('requesting');

    if (runsInBrowser) {
      resetRecognition();

      const refused = startRecognition();

      if (refused) {
        fail(kindFromSpeechFailure(refused), refused.cause);
        setState('idle');

        return false;
      }

      setState('listening');

      return true;
    }

    const refused = await startRecorder();

    if (refused) {
      fail(kindFromMicFailure(refused.kind), refused.cause);
      setState('idle');

      return false;
    }

    setState('listening');

    return true;
  }, [capabilityFailure, fail, resetRecognition, runsInBrowser, startRecognition, startRecorder]);

  /** Завершает реплику и отдаёт расшифровку; всё общее для обоих режимов. */
  const finish = useCallback((result: VoiceInputResult | null): VoiceInputResult | null => {
    setState('idle');

    if (result) {
      setText(result.text);
      callbacksRef.current.onResult?.(result);
    }

    return result;
  }, []);

  const stop = useCallback(async (): Promise<VoiceInputResult | null> => {
    if (runsInBrowser) {
      setState('processing');

      const outcome = await stopRecognition();
      const recognized = outcome.text.trim();

      // Текст важнее отказа: движок мог пожаловаться на паузу уже после фразы.
      if (recognized.length === 0) {
        fail(
          outcome.failure ? kindFromSpeechFailure(outcome.failure) : 'no_speech',
          outcome.failure?.cause,
        );
        setState('idle');

        return null;
      }

      return finish({
        text: recognized,
        provider: 'browser',
        language,
        durationMs: null,
      });
    }

    setState('processing');

    const { recording, failure: micFailure } = await stopRecorder();

    if (!recording) {
      fail(micFailure ? kindFromMicFailure(micFailure.kind) : 'no_speech', micFailure?.cause);
      setState('idle');

      return null;
    }

    // Распознавателю, который не умеет распаковывать сжатый звук, запись
    // перекодирует браузер: он этот Opus и записал, других декодеров рядом нет.
    // Проверка размера идёт уже по тому, что действительно уйдёт на сервер:
    // WAV тяжелее исходной записи примерно в десять раз.
    let audio = recording.blob;

    if (requiresWav16) {
      try {
        audio = await toWav16Mono(audio);
      } catch (error) {
        fail('unsupported_format', error);
        setState('idle');

        return null;
      }
    }

    const rejection = audioRejection(audio, maxAudioBytes);

    if (rejection) {
      fail(rejection === 'empty' ? 'no_speech' : rejection);
      setState('idle');

      return null;
    }

    try {
      const response = await transcribeAudio({
        audio,
        language,
        prompt,
        lessonId,
      });
      const recognized = response.text.trim();

      if (recognized.length === 0) {
        fail('no_speech');
        setState('idle');

        return null;
      }

      return finish({
        text: recognized,
        provider: response.provider,
        language: response.language ?? language,
        durationMs: response.durationMs ?? recording.durationMs,
      });
    } catch (error) {
      fail(kindFromApiError(error, 'input'), error);
      setState('idle');

      return null;
    }
    // Запись дальше не живёт: ни в состоянии, ни в кэше (A10).
  }, [
    fail,
    finish,
    language,
    lessonId,
    maxAudioBytes,
    prompt,
    requiresWav16,
    runsInBrowser,
    stopRecognition,
    stopRecorder,
  ]);

  const cancel = useCallback((): void => {
    if (runsInBrowser) {
      abortRecognition();
    } else {
      cancelRecorder();
    }

    setState('idle');
  }, [abortRecognition, cancelRecorder, runsInBrowser]);

  const reset = useCallback((): void => {
    setFailure(null);
    setText('');
    resetRecognition();
    setState('idle');
  }, [resetRecognition]);

  const status: VoiceInputStatus = useMemo(() => {
    if (state !== 'idle') {
      return state;
    }

    if (capabilityFailure) {
      return 'unavailable';
    }

    return failure ? 'error' : 'idle';
  }, [capabilityFailure, failure, state]);

  return {
    status,
    available: capabilityFailure === null && stt.available,
    provider: sttProvider,
    runsInBrowser,
    isListening: state === 'listening',
    isProcessing: state === 'processing',
    interimText: runsInBrowser ? recognition.interimText : '',
    text,
    level: recorder.level,
    failure: failure ?? capabilityFailure,
    start,
    stop,
    cancel,
    reset,
  };
}
