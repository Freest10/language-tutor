/**
 * Запись с микрофона: `getUserMedia` + `MediaRecorder`.
 *
 * Хук нужен серверному распознаванию (`STT_PROVIDER=openai`): браузерный режим
 * пишет звук сам, внутри Web Speech API. Контейнер выбирается из поддерживаемых
 * браузером (`MediaRecorder.isTypeSupported`): Chrome умеет `audio/webm;codecs=opus`,
 * Safari — только `audio/mp4`, и зашивать один тип нельзя.
 *
 * Треки микрофона освобождаются при любом исходе — остановке, отмене, ошибке
 * и размонтировании. Без `track.stop()` индикатор записи в браузере продолжает
 * гореть после урока, даже если приложение уже ничего не пишет.
 *
 * Допущение A10: запись нигде не сохраняется. Куски живут в памяти до сборки
 * blob, отдаются вызывающему коду и тут же забываются.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Что сейчас делает микрофон. */
export type MicRecorderStatus =
  /** Ничего не пишем. */
  | 'idle'
  /** Ждём разрешения пользователя на доступ к микрофону. */
  | 'requesting'
  /** Идёт запись. */
  | 'recording'
  /** Запись остановлена, собираем blob. */
  | 'processing'
  /** Последняя попытка закончилась отказом (см. `failure`). */
  | 'error';

/** Почему запись не удалась. */
export type MicFailureKind =
  /** В браузере нет `getUserMedia` или `MediaRecorder`. */
  | 'unsupported'
  /** Пользователь запретил доступ к микрофону. */
  | 'permission_denied'
  /** Микрофон не найден или занят другим приложением. */
  | 'no_device'
  /** `MediaRecorder` не смог начать или продолжить запись. */
  | 'recorder_failed'
  /** Запись получилась пустой: говорить начали после остановки. */
  | 'empty';

/** Отказ записи вместе с исходным исключением для журнала. */
export interface MicFailure {
  kind: MicFailureKind;
  /** Исходное исключение браузера; в интерфейс не показывается. */
  cause?: unknown;
}

/** Готовая запись: её отправляют на распознавание и сразу забывают (A10). */
export interface MicRecording {
  blob: Blob;
  /** MIME-тип контейнера, который выбрал браузер. */
  mimeType: string;
  /** Длительность записи по часам клиента, миллисекунды. */
  durationMs: number;
}

/** Чем закончилась остановка записи. */
export interface MicOutcome {
  /** Готовая запись; `null` — записывать было нечего. */
  recording: MicRecording | null;
  /** Отказ, если он случился по ходу записи. */
  failure: MicFailure | null;
}

/** Настройки записи. */
export interface UseMicRecorderOptions {
  /** Контейнеры в порядке предпочтения; берётся первый поддерживаемый. */
  mimeTypes?: readonly string[];
  /** Измерять уровень сигнала для индикатора; по умолчанию — да. */
  meterLevel?: boolean;
}

/** Состояние записи и управление ею. */
export interface UseMicRecorderResult {
  status: MicRecorderStatus;
  /** Идёт ли запись прямо сейчас. */
  isRecording: boolean;
  /** Уровень входного сигнала от 0 до 1 — для индикатора громкости. */
  level: number;
  /** Отказ последней попытки; `null` — отказов не было. */
  failure: MicFailure | null;
  /** Есть ли в браузере всё необходимое для записи. */
  supported: boolean;
  /** Контейнер текущей записи; `null` — пока не пишем. */
  mimeType: string | null;
  /** Запрашивает микрофон и начинает запись; `null` — запись пошла. */
  start: () => Promise<MicFailure | null>;
  /** Останавливает запись и отдаёт её вместе с отказом, если он был. */
  stop: () => Promise<MicOutcome>;
  /** Прерывает запись, отбрасывая звук. */
  cancel: () => void;
  /** Сбрасывает состояние отказа. */
  reset: () => void;
}

/**
 * Контейнеры в порядке предпочтения.
 *
 * Opus в webm — лучший компромисс размера и качества и принимается сервером;
 * `audio/mp4` в конце списка ради Safari, который остальные не умеет.
 */
export const PREFERRED_AUDIO_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
] as const;

/** Есть ли в браузере доступ к микрофону и запись звука. */
export function isMicRecordingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof window.MediaRecorder === 'function'
  );
}

/**
 * Первый контейнер, который умеет `MediaRecorder`.
 *
 * @returns MIME-тип или `null`, если выбор нужно оставить браузеру
 *   (`isTypeSupported` есть не везде, а `MediaRecorder` без опций работает).
 */
export function pickRecorderMimeType(
  candidates: readonly string[] = PREFERRED_AUDIO_MIME_TYPES,
): string | null {
  if (typeof window === 'undefined' || typeof window.MediaRecorder !== 'function') {
    return null;
  }

  if (typeof window.MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }

  return candidates.find((candidate) => window.MediaRecorder.isTypeSupported(candidate)) ?? null;
}

/**
 * Переводит исключение `getUserMedia` в причину отказа.
 *
 * Имя читается структурно, а не через `instanceof Error`: `DOMException`
 * наследуется от `Error` не во всех средах, а именно им браузер и сообщает,
 * что доступ к микрофону запрещён.
 */
export function micFailureFromError(error: unknown): MicFailure {
  const name =
    typeof (error as { name?: unknown } | null)?.name === 'string'
      ? (error as { name: string }).name
      : '';

  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return { kind: 'permission_denied', cause: error };
  }

  if (
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    name === 'OverconstrainedError' ||
    name === 'NotReadableError' ||
    name === 'TrackStartError' ||
    name === 'AbortError'
  ) {
    return { kind: 'no_device', cause: error };
  }

  return { kind: 'recorder_failed', cause: error };
}

/** Сколько ступеней различает индикатор громкости: лишние перерисовки не нужны. */
const LEVEL_STEPS = 20;

/** Запись с микрофона для серверного распознавания речи. */
export function useMicRecorder(options: UseMicRecorderOptions = {}): UseMicRecorderResult {
  const { mimeTypes, meterLevel = true } = options;

  const [status, setStatus] = useState<MicRecorderStatus>('idle');
  const [level, setLevel] = useState(0);
  const [failure, setFailure] = useState<MicFailure | null>(null);
  const [mimeType, setMimeType] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const cancelledRef = useRef(false);
  const failureRef = useRef<MicFailure | null>(null);
  const resolveRef = useRef<((outcome: MicOutcome) => void) | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  /** Запоминает отказ и для рендера, и для ожидающего `stop()`. */
  const applyFailure = useCallback((next: MicFailure | null): MicFailure | null => {
    failureRef.current = next;

    if (mountedRef.current) {
      setFailure(next);
    }

    return next;
  }, []);

  /** Останавливает измерение уровня и закрывает звуковой контекст. */
  const stopMetering = useCallback((): void => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    const context = audioContextRef.current;

    audioContextRef.current = null;

    if (context) {
      // Контекст закрывается асинхронно; отказ здесь ни на что не влияет.
      void context.close().catch(() => undefined);
    }
  }, []);

  /**
   * Освобождает микрофон: без `track.stop()` браузер продолжает показывать
   * запись как активную, даже когда приложение уже ничего не пишет.
   */
  const releaseStream = useCallback((): void => {
    stopMetering();

    const stream = streamRef.current;

    streamRef.current = null;
    recorderRef.current = null;

    stream?.getTracks().forEach((track) => {
      track.stop();
    });

    if (mountedRef.current) {
      setLevel(0);
      setMimeType(null);
    }
  }, [stopMetering]);

  /** Отдаёт ожидающему `stop()` результат записи. */
  const settle = useCallback((recording: MicRecording | null): void => {
    const resolve = resolveRef.current;

    resolveRef.current = null;
    resolve?.({ recording, failure: failureRef.current });
  }, []);

  useEffect(() => {
    // Повторный монтаж (StrictMode в разработке) снова включает обновления состояния.
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      cancelledRef.current = true;
      chunksRef.current = [];

      const recorder = recorderRef.current;

      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // Запись уже остановлена — освобождать треки это не мешает.
        }
      }

      releaseStream();
      settle(null);
    };
  }, [releaseStream, settle]);

  /** Заводит измерение уровня сигнала; отказ метрики не ломает запись. */
  const startMetering = useCallback(
    (stream: MediaStream): void => {
      if (!meterLevel || typeof AudioContext !== 'function') {
        return;
      }

      try {
        const context = new AudioContext();
        const analyser = context.createAnalyser();

        analyser.fftSize = 512;
        context.createMediaStreamSource(stream).connect(analyser);
        audioContextRef.current = context;

        const samples = new Uint8Array(analyser.fftSize);
        let previous = -1;

        const measure = (): void => {
          if (!mountedRef.current || audioContextRef.current !== context) {
            return;
          }

          analyser.getByteTimeDomainData(samples);

          let sum = 0;

          for (const sample of samples) {
            const deviation = (sample - 128) / 128;

            sum += deviation * deviation;
          }

          // Среднеквадратичное отклонение от тишины, слегка растянутое вверх.
          const next = Math.min(1, Math.sqrt(sum / samples.length) * 2.5);
          const step = Math.round(next * LEVEL_STEPS);

          if (step !== previous) {
            previous = step;
            setLevel(step / LEVEL_STEPS);
          }

          frameRef.current = requestAnimationFrame(measure);
        };

        frameRef.current = requestAnimationFrame(measure);
      } catch {
        // Индикатор громкости — украшение: без него запись всё равно работает.
        stopMetering();
      }
    },
    [meterLevel, stopMetering],
  );

  const start = useCallback(async (): Promise<MicFailure | null> => {
    if (recorderRef.current) {
      return null;
    }

    if (!isMicRecordingSupported()) {
      setStatus('error');

      return applyFailure({ kind: 'unsupported' });
    }

    applyFailure(null);
    setStatus('requesting');

    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (mountedRef.current) {
        setStatus('error');
      }

      return applyFailure(micFailureFromError(error));
    }

    if (!mountedRef.current) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });

      return applyFailure({ kind: 'recorder_failed' });
    }

    const selected = pickRecorderMimeType(mimeTypes ?? PREFERRED_AUDIO_MIME_TYPES);
    let recorder: MediaRecorder;

    try {
      recorder = selected
        ? new MediaRecorder(stream, { mimeType: selected })
        : new MediaRecorder(stream);
    } catch (error) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      setStatus('error');

      return applyFailure({ kind: 'recorder_failed', cause: error });
    }

    streamRef.current = stream;
    recorderRef.current = recorder;
    chunksRef.current = [];
    cancelledRef.current = false;
    startedAtRef.current = Date.now();

    recorder.ondataavailable = (event: BlobEvent): void => {
      if (event.data && event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };

    recorder.onerror = (event: Event): void => {
      chunksRef.current = [];
      applyFailure({ kind: 'recorder_failed', cause: event });
      releaseStream();
      settle(null);

      if (mountedRef.current) {
        setStatus('error');
      }
    };

    recorder.onstop = (): void => {
      const chunks = chunksRef.current;
      const cancelled = cancelledRef.current;
      const type = recorder.mimeType || selected || chunks[0]?.type || '';
      const durationMs = Math.max(0, Date.now() - startedAtRef.current);

      chunksRef.current = [];
      releaseStream();

      if (cancelled) {
        settle(null);

        if (mountedRef.current) {
          setStatus('idle');
        }

        return;
      }

      const blob = new Blob(chunks, type ? { type } : undefined);

      if (blob.size === 0) {
        applyFailure({ kind: 'empty' });
        settle(null);

        if (mountedRef.current) {
          setStatus('error');
        }

        return;
      }

      settle({ blob, mimeType: blob.type || type, durationMs });

      if (mountedRef.current) {
        setStatus('idle');
      }
    };

    try {
      recorder.start();
    } catch (error) {
      releaseStream();
      setStatus('error');

      return applyFailure({ kind: 'recorder_failed', cause: error });
    }

    setMimeType(recorder.mimeType || selected);
    setStatus('recording');
    startMetering(stream);

    return null;
  }, [applyFailure, mimeTypes, releaseStream, settle, startMetering]);

  const stop = useCallback((): Promise<MicOutcome> => {
    const recorder = recorderRef.current;

    if (!recorder || recorder.state === 'inactive') {
      releaseStream();

      return Promise.resolve({ recording: null, failure: failureRef.current });
    }

    setStatus('processing');
    stopMetering();

    return new Promise<MicOutcome>((resolve) => {
      resolveRef.current = resolve;

      try {
        recorder.stop();
      } catch (error) {
        chunksRef.current = [];
        applyFailure({ kind: 'recorder_failed', cause: error });
        releaseStream();
        setStatus('error');
        settle(null);
      }
    });
  }, [applyFailure, releaseStream, settle, stopMetering]);

  const cancel = useCallback((): void => {
    cancelledRef.current = true;

    const recorder = recorderRef.current;

    if (!recorder || recorder.state === 'inactive') {
      chunksRef.current = [];
      releaseStream();
      settle(null);
      setStatus('idle');

      return;
    }

    try {
      recorder.stop();
    } catch {
      chunksRef.current = [];
      releaseStream();
      settle(null);
      setStatus('idle');
    }
  }, [releaseStream, settle]);

  const reset = useCallback((): void => {
    applyFailure(null);
    setStatus((current) => (current === 'error' ? 'idle' : current));
  }, [applyFailure]);

  return {
    status,
    isRecording: status === 'recording',
    level,
    failure,
    supported: isMicRecordingSupported(),
    mimeType,
    start,
    stop,
    cancel,
    reset,
  };
}
