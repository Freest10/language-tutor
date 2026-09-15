/**
 * Распознавание речи средствами браузера (Web Speech API).
 *
 * Используется, когда сервер настроен как `STT_PROVIDER=browser`: звук тогда
 * вообще не покидает браузер. Промежуточные результаты (`interimText`) нужны,
 * чтобы ученик видел, что его слышат, ещё до конца фразы; финальный текст
 * копится отдельно и отдаётся из `stop()`.
 *
 * Допущение A14: в Firefox распознавания нет вовсе. Хук честно сообщает
 * `supported: false`, а подсказку «включите серверный STT» показывает
 * `useVoiceInput` — здесь нет переводов, только факты.
 *
 * Типы Web Speech API описаны в `speech.d.ts`: в `lib.dom.d.ts` их нет.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Почему браузерное распознавание не сработало. */
export type SpeechFailureKind =
  /** В браузере нет `SpeechRecognition` (Firefox — A14). */
  | 'unsupported'
  /** Пользователь запретил доступ к микрофону. */
  | 'permission_denied'
  /** Звук с микрофона не читается: устройства нет или оно занято. */
  | 'no_device'
  /** Речи в записи не нашлось. */
  | 'no_speech'
  /** Движок не знает такого языка. */
  | 'language_not_supported'
  /** Движку нужна сеть, и она недоступна. */
  | 'network'
  /** Прочий отказ движка распознавания. */
  | 'failed';

/** Отказ распознавания вместе с исходным событием для журнала. */
export interface SpeechFailure {
  kind: SpeechFailureKind;
  cause?: unknown;
}

/** Чем закончилась остановка распознавания. */
export interface SpeechOutcome {
  /** Накопленный финальный текст; пустая строка — распознавать было нечего. */
  text: string;
  /** Отказ, случившийся по ходу распознавания. */
  failure: SpeechFailure | null;
}

/** Настройки распознавания. */
export interface UseSpeechRecognitionOptions {
  /** Язык речи в нотации BCP-47 — изучаемый язык из профиля, не язык интерфейса. */
  language: string;
  /** Присылать промежуточные результаты; по умолчанию — да. */
  interimResults?: boolean;
  /**
   * Не останавливаться на первой паузе: при удержании кнопки ученик может
   * подумать посреди фразы. По умолчанию — да.
   */
  continuous?: boolean;
  /** Вызывается, когда движок отдал очередной законченный кусок текста. */
  onFinalText?: (text: string) => void;
}

/** Состояние распознавания и управление им. */
export interface UseSpeechRecognitionResult {
  /** Есть ли в браузере Web Speech API распознавания. */
  supported: boolean;
  /** Слушает ли движок прямо сейчас. */
  isListening: boolean;
  /** Текущая незаконченная фраза; очищается, когда она становится финальной. */
  interimText: string;
  /** Накопленный финальный текст текущей реплики. */
  finalText: string;
  /** Отказ последней попытки; `null` — отказов не было. */
  failure: SpeechFailure | null;
  /** Начинает слушать; `null` — распознавание пошло. */
  start: () => SpeechFailure | null;
  /** Останавливает распознавание и отдаёт накопленный текст с отказом, если он был. */
  stop: () => Promise<SpeechOutcome>;
  /** Прерывает распознавание, отбрасывая результат. */
  abort: () => void;
  /** Забывает предыдущую реплику и отказ. */
  reset: () => void;
}

/**
 * Сколько ждать события `end` после `stop()`, миллисекунды.
 *
 * Движок обязан его прислать, но если этого не случится, ожидание не должно
 * подвесить кнопку: по истечении срока отдаём накопленный текст.
 */
const RECOGNITION_STOP_TIMEOUT_MS = 5_000;

/** Конструктор распознавателя речи браузера; `null` — его нет (A14). */
export function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/** Есть ли в браузере распознавание речи. */
export function isSpeechRecognitionSupported(): boolean {
  return speechRecognitionConstructor() !== null;
}

/** Переводит код отказа Web Speech API в причину отказа хука. */
export function speechFailureFromEvent(event: SpeechRecognitionErrorEvent): SpeechFailure {
  switch (event.error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return { kind: 'permission_denied', cause: event };
    case 'audio-capture':
      return { kind: 'no_device', cause: event };
    case 'no-speech':
      return { kind: 'no_speech', cause: event };
    case 'language-not-supported':
      return { kind: 'language_not_supported', cause: event };
    case 'network':
      return { kind: 'network', cause: event };
    default:
      return { kind: 'failed', cause: event };
  }
}

/** Склеивает две части расшифровки, не теряя пробел между ними. */
function appendText(accumulated: string, addition: string): string {
  const next = addition.trim();

  if (next.length === 0) {
    return accumulated;
  }

  return accumulated.length === 0 ? next : `${accumulated} ${next}`;
}

/** Распознавание речи браузером: промежуточный и финальный текст. */
export function useSpeechRecognition(
  options: UseSpeechRecognitionOptions,
): UseSpeechRecognitionResult {
  const { language, interimResults = true, continuous = true, onFinalText } = options;

  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [finalText, setFinalText] = useState('');
  const [failure, setFailure] = useState<SpeechFailure | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const finalRef = useRef('');
  const abortedRef = useRef(false);
  const failureRef = useRef<SpeechFailure | null>(null);
  const resolveRef = useRef<((outcome: SpeechOutcome) => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Обработчики движка живут дольше одного рендера: свежие значения берём из ref.
  const optionsRef = useRef({ language, onFinalText });

  useEffect(() => {
    optionsRef.current = { language, onFinalText };
  }, [language, onFinalText]);

  /** Запоминает отказ и для рендера, и для ожидающего `stop()`. */
  const applyFailure = useCallback((next: SpeechFailure | null): SpeechFailure | null => {
    failureRef.current = next;

    if (mountedRef.current) {
      setFailure(next);
    }

    return next;
  }, []);

  /** Отдаёт ожидающему `stop()` результат и снимает сторожевой таймер. */
  const settle = useCallback((text: string): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const resolve = resolveRef.current;

    resolveRef.current = null;
    resolve?.({ text, failure: failureRef.current });
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;

      const recognition = recognitionRef.current;

      recognitionRef.current = null;

      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;

        try {
          recognition.abort();
        } catch {
          // Движок уже остановлен — на освобождение микрофона это не влияет.
        }
      }

      settle('');
    };
  }, [settle]);

  const start = useCallback((): SpeechFailure | null => {
    if (recognitionRef.current) {
      return null;
    }

    const Recognition = speechRecognitionConstructor();

    if (!Recognition) {
      return applyFailure({ kind: 'unsupported' });
    }

    const recognition = new Recognition();

    recognition.lang = optionsRef.current.language;
    recognition.continuous = continuous;
    recognition.interimResults = interimResults;
    recognition.maxAlternatives = 1;

    finalRef.current = '';
    abortedRef.current = false;
    failureRef.current = null;

    recognition.onresult = (event: SpeechRecognitionEvent): void => {
      let interim = '';

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript ?? '';

        if (result?.isFinal) {
          finalRef.current = appendText(finalRef.current, transcript);
          optionsRef.current.onFinalText?.(finalRef.current);
        } else {
          interim = appendText(interim, transcript);
        }
      }

      if (!mountedRef.current) {
        return;
      }

      setInterimText(interim);
      setFinalText(finalRef.current);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent): void => {
      // `abort()` — наша собственная отмена, а не отказ движка.
      if (event.error === 'aborted') {
        return;
      }

      applyFailure(speechFailureFromEvent(event));
    };

    recognition.onend = (): void => {
      recognitionRef.current = null;

      if (mountedRef.current) {
        setIsListening(false);
        setInterimText('');
      }

      settle(abortedRef.current ? '' : finalRef.current);
    };

    try {
      recognition.start();
    } catch (error) {
      recognitionRef.current = null;

      return applyFailure({ kind: 'failed', cause: error });
    }

    recognitionRef.current = recognition;
    setFailure(null);
    setInterimText('');
    setFinalText('');
    setIsListening(true);

    return null;
  }, [applyFailure, continuous, interimResults, settle]);

  const stop = useCallback((): Promise<SpeechOutcome> => {
    const recognition = recognitionRef.current;

    if (!recognition) {
      return Promise.resolve({ text: finalRef.current, failure: failureRef.current });
    }

    return new Promise<SpeechOutcome>((resolve) => {
      resolveRef.current = resolve;

      timerRef.current = setTimeout(() => {
        timerRef.current = null;

        try {
          recognitionRef.current?.abort();
        } catch {
          // Движок молчит — отдаём то, что успели накопить.
        }

        recognitionRef.current = null;

        if (mountedRef.current) {
          setIsListening(false);
        }

        settle(finalRef.current);
      }, RECOGNITION_STOP_TIMEOUT_MS);

      try {
        recognition.stop();
      } catch (error) {
        applyFailure({ kind: 'failed', cause: error });
        recognitionRef.current = null;
        setIsListening(false);
        settle(finalRef.current);
      }
    });
  }, [applyFailure, settle]);

  const abort = useCallback((): void => {
    abortedRef.current = true;
    finalRef.current = '';

    const recognition = recognitionRef.current;

    recognitionRef.current = null;
    setIsListening(false);
    setInterimText('');

    if (recognition) {
      try {
        recognition.abort();
      } catch {
        // Уже остановлен: состояние всё равно приведено к «не слушаем».
      }
    }

    settle('');
  }, [settle]);

  const reset = useCallback((): void => {
    finalRef.current = '';
    setFinalText('');
    setInterimText('');
    applyFailure(null);
  }, [applyFailure]);

  return {
    supported: isSpeechRecognitionSupported(),
    isListening,
    interimText,
    finalText,
    failure,
    start,
    stop,
    abort,
    reset,
  };
}
