/**
 * Озвучивание ответов тьютора с очередью и возможностью прервать её.
 *
 * Путь выбирается по конфигурации сервера:
 * - `ttsProvider === 'openai'` — `POST /api/voice/tts`, аудио приходит в base64
 *   (допущение A9), проигрывается через `Audio`;
 * - `ttsProvider === 'browser'` — `speechSynthesis` с подбором голоса под код языка;
 * - возможность недоступна — отдаём отказ с подсказкой (в Firefox синтеза нет, A14).
 *
 * Скорость речи зависит от уровня: на A1/A2 тьютор говорит заметно медленнее
 * (`speechRateForLevel`), уровень приходит аргументом — хук его не угадывает.
 *
 * Очередь нужна, потому что ответ тьютора приходит частями, а новая реплика
 * ученика должна прерывать старую: `speak()` очищает очередь, `enqueue()` — нет.
 *
 * Каждый `URL.createObjectURL` освобождается в `finally`: за урок набегают
 * десятки реплик, и незакрытые ссылки держат аудио в памяти вкладки.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CefrLevel, LanguageCode, VoiceProvider } from '@lt/shared';

import { kindFromApiError, useVoiceFailure, type VoiceFailure } from './useVoiceInput';

import { synthesizeSpeech, ttsAudioBlob } from '../../api/voice';
import { useCapabilities } from '../../context/CapabilitiesProvider';

/** Скорость речи по уровню: ниже A2 тьютор проговаривает слова медленнее. */
export const SPEECH_RATE_BY_LEVEL: Record<CefrLevel, number> = {
  A1: 0.75,
  A2: 0.85,
  B1: 0.95,
  B2: 1,
  C1: 1,
  C2: 1,
};

/** Минимальная скорость речи, которую принимает `POST /api/voice/tts`. */
export const MIN_SPEECH_RATE = 0.5;

/** Максимальная скорость речи, которую принимает `POST /api/voice/tts`. */
export const MAX_SPEECH_RATE = 2;

/** Скорость речи для уровня ученика; без уровня — обычная. */
export function speechRateForLevel(level: CefrLevel | null | undefined): number {
  return level ? SPEECH_RATE_BY_LEVEL[level] : 1;
}

/** Приводит скорость к допустимому диапазону контракта. */
export function clampSpeechRate(rate: number): number {
  return Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, rate));
}

/** Реплика для озвучивания. */
export interface SpeakRequest {
  text: string;
  /** Язык произношения; по умолчанию — язык из настроек хука. */
  language?: LanguageCode;
  /** Уровень ученика: от него зависит скорость. */
  level?: CefrLevel | null;
  /** Явная скорость: перекрывает уровень. */
  rate?: number;
  /** Имя голоса: серверное (`alloy`) или системное в браузерном режиме. */
  voice?: string;
}

/** Реплика или просто её текст. */
export type SpeakInput = string | SpeakRequest;

/** Настройки озвучивания. */
export interface UseTextToSpeechOptions {
  /** Язык произношения — изучаемый язык из профиля (BCP-47). */
  language: LanguageCode;
  /** Уровень ученика: на A1/A2 речь медленнее. */
  level?: CefrLevel | null;
  /** Имя голоса по умолчанию. */
  voice?: string;
  /** Вызывается при отказе — тем же объектом, что лежит в `failure`. */
  onFailure?: (failure: VoiceFailure) => void;
}

/** Состояние озвучивания. */
export type TextToSpeechStatus =
  /** Синтез недоступен — см. `failure`. */
  | 'unavailable'
  /** Готов говорить. */
  | 'idle'
  /** Ждём аудио от сервера. */
  | 'loading'
  /** Реплика проигрывается. */
  | 'speaking'
  /** Последняя попытка не удалась — см. `failure`. */
  | 'error';

/** Состояние озвучивания и управление им. */
export interface UseTextToSpeechResult {
  status: TextToSpeechStatus;
  /** Звучит ли речь прямо сейчас. */
  isSpeaking: boolean;
  /** Доступен ли синтез с учётом сервера и браузера. */
  available: boolean;
  /** Кто синтезирует речь; `null` — конфигурация ещё не получена. */
  provider: VoiceProvider | null;
  /** Синтезирует ли браузер (без обращения к серверу). */
  runsInBrowser: boolean;
  /** Сколько реплик ждёт очереди, не считая звучащей. */
  queueLength: number;
  /** Скорость речи, с которой хук будет говорить при текущем уровне. */
  rate: number;
  /** Текущий отказ: и недоступность возможности, и провал последней попытки. */
  failure: VoiceFailure | null;
  /**
   * Говорит реплику, прерывая текущую и очищая очередь.
   * Промис завершается, когда реплика договорена или прервана.
   */
  speak: (input: SpeakInput) => Promise<void>;
  /** Добавляет реплику в конец очереди, не прерывая текущую. */
  enqueue: (input: SpeakInput) => Promise<void>;
  /** Прерывает речь и очищает очередь. */
  stop: () => void;
  /** Забывает отказ последней попытки. */
  reset: () => void;
}

/** Синтез речи браузера; `null` — его нет (Firefox, A14). */
function browserSynthesis(): SpeechSynthesis | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const synthesis = window.speechSynthesis as SpeechSynthesis | undefined;

  return typeof synthesis?.speak === 'function' ? synthesis : null;
}

/** Основной субтег языка: `pt-BR` → `pt`. */
function primarySubtag(language: string): string {
  return language.toLowerCase().split('-')[0] ?? language.toLowerCase();
}

/**
 * Голос под код языка: точное совпадение, затем совпадение по основному субтегу.
 *
 * @param voices список из `speechSynthesis.getVoices()`.
 * @param language код языка реплики.
 * @param preferredName имя голоса из настроек, если он есть в системе.
 */
export function pickSpeechVoice(
  voices: readonly SpeechSynthesisVoice[],
  language: string,
  preferredName?: string,
): SpeechSynthesisVoice | null {
  if (voices.length === 0) {
    return null;
  }

  if (preferredName) {
    const byName = voices.find((voice) => voice.name === preferredName);

    if (byName) {
      return byName;
    }
  }

  const wanted = language.toLowerCase();
  const exact = voices.find((voice) => voice.lang.toLowerCase() === wanted);

  if (exact) {
    return exact;
  }

  const primary = primarySubtag(wanted);
  const sameLanguage = voices.filter((voice) => primarySubtag(voice.lang) === primary);

  return sameLanguage.find((voice) => voice.default) ?? sameLanguage[0] ?? null;
}

/** Приводит аргумент `speak()` к полной реплике. */
function toRequest(input: SpeakInput): SpeakRequest {
  return typeof input === 'string' ? { text: input } : input;
}

/** Озвучивание ответов тьютора: очередь, прерывание и подбор скорости. */
export function useTextToSpeech(options: UseTextToSpeechOptions): UseTextToSpeechResult {
  const { language, level, voice, onFailure } = options;

  const { tts, ttsProvider } = useCapabilities();
  const describeFailure = useVoiceFailure();

  const [status, setStatus] = useState<'idle' | 'loading' | 'speaking'>('idle');
  const [queueLength, setQueueLength] = useState(0);
  const [failure, setFailure] = useState<VoiceFailure | null>(null);
  const [voices, setVoices] = useState<readonly SpeechSynthesisVoice[]>([]);

  const queueRef = useRef<SpeakRequest[]>([]);
  const runnerRef = useRef<Promise<void> | null>(null);
  /** Номер «поколения» очереди: `stop()` увеличивает его и обесценивает начатое. */
  const generationRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  /** Завершает ожидание текущей реплики: без него прерывание подвесило бы очередь. */
  const finishPlaybackRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);

  const settingsRef = useRef({ language, level, voice, onFailure });

  useEffect(() => {
    settingsRef.current = { language, level, voice, onFailure };
  }, [language, level, onFailure, voice]);

  const runsInBrowser = tts.runsInBrowser;

  // Голоса браузера появляются асинхронно: при первом вызове список часто пуст.
  useEffect(() => {
    const synthesis = browserSynthesis();

    if (!synthesis || !runsInBrowser) {
      return;
    }

    const readVoices = (): void => {
      setVoices(synthesis.getVoices());
    };

    readVoices();
    synthesis.addEventListener('voiceschanged', readVoices);

    return () => {
      synthesis.removeEventListener('voiceschanged', readVoices);
    };
  }, [runsInBrowser]);

  /** Отпускает ссылку на аудио: иначе за урок в памяти копятся десятки записей. */
  const releaseAudio = useCallback((): void => {
    const audio = audioRef.current;
    const url = objectUrlRef.current;

    audioRef.current = null;
    objectUrlRef.current = null;

    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
    }

    if (url) {
      URL.revokeObjectURL(url);
    }
  }, []);

  const fail = useCallback(
    (kind: VoiceFailure['kind'], cause?: unknown): void => {
      const next = describeFailure(kind, 'output', cause);

      if (mountedRef.current) {
        setFailure(next);
      }

      settingsRef.current.onFailure?.(next);
    },
    [describeFailure],
  );

  /** Недоступность синтеза: видна сразу, ещё до первой реплики. */
  const capabilityFailure = useMemo<VoiceFailure | null>(() => {
    if (tts.available || tts.blocker === null || tts.blocker === 'config_unavailable') {
      return null;
    }

    return describeFailure(
      tts.blocker === 'server_not_configured' ? 'server_not_configured' : 'unsupported',
      'output',
      tts.reason,
    );
  }, [describeFailure, tts.available, tts.blocker, tts.reason]);

  /** Проигрывает одну реплику силами браузера. */
  const speakInBrowser = useCallback(
    (request: SpeakRequest, rate: number, generation: number): Promise<void> => {
      const synthesis = browserSynthesis();

      if (!synthesis || typeof SpeechSynthesisUtterance !== 'function') {
        fail('unsupported');

        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(request.text);
        const spoken = request.language ?? settingsRef.current.language;
        const selected = pickSpeechVoice(
          voices.length > 0 ? voices : synthesis.getVoices(),
          spoken,
          request.voice ?? settingsRef.current.voice,
        );

        utterance.lang = spoken;
        utterance.rate = rate;

        if (selected) {
          utterance.voice = selected;
        }

        const done = (): void => {
          utteranceRef.current = null;
          finishPlaybackRef.current = null;
          resolve();
        };

        finishPlaybackRef.current = done;
        utterance.onend = done;
        utterance.onerror = (event: SpeechSynthesisErrorEvent): void => {
          // `canceled`/`interrupted` — это наш собственный `stop()`, а не отказ.
          if (
            generation === generationRef.current &&
            event.error !== 'canceled' &&
            event.error !== 'interrupted'
          ) {
            fail('failed', event);
          }

          done();
        };

        utteranceRef.current = utterance;
        synthesis.speak(utterance);
      });
    },
    [fail, voices],
  );

  /** Проигрывает одну реплику, синтезированную сервером. */
  const speakFromServer = useCallback(
    async (request: SpeakRequest, rate: number, generation: number): Promise<void> => {
      const controller = new AbortController();

      abortRef.current = controller;

      try {
        const response = await synthesizeSpeech(
          {
            text: request.text,
            language: request.language ?? settingsRef.current.language,
            voice: request.voice ?? settingsRef.current.voice,
            speed: rate,
          },
          controller.signal,
        );

        if (generation !== generationRef.current) {
          return;
        }

        const url = URL.createObjectURL(ttsAudioBlob(response));

        objectUrlRef.current = url;

        const audio = new Audio(url);

        audioRef.current = audio;

        if (mountedRef.current) {
          setStatus('speaking');
        }

        await new Promise<void>((resolve) => {
          const done = (): void => {
            finishPlaybackRef.current = null;
            resolve();
          };

          finishPlaybackRef.current = done;
          audio.onended = done;
          audio.onerror = () => {
            if (generation === generationRef.current) {
              fail('failed');
            }

            done();
          };

          const played: unknown = audio.play();

          if (played instanceof Promise) {
            played.catch((error: unknown) => {
              // Обрыв воспроизведения из-за `stop()` отказом не считается.
              if (generation === generationRef.current) {
                fail('failed', error);
              }

              done();
            });
          }
        });
      } catch (error) {
        if (controller.signal.aborted || generation !== generationRef.current) {
          return;
        }

        fail(kindFromApiError(error, 'output'), error);
      } finally {
        abortRef.current = null;
        releaseAudio();
      }
    },
    [fail, releaseAudio],
  );

  /** Проигрывает очередь по одной реплике, пока её не прервут. */
  const pump = useCallback(async (): Promise<void> => {
    while (queueRef.current.length > 0) {
      const generation = generationRef.current;
      const request = queueRef.current.shift();

      if (!request) {
        break;
      }

      if (mountedRef.current) {
        setQueueLength(queueRef.current.length);
        setStatus(runsInBrowser ? 'speaking' : 'loading');
      }

      const rate = clampSpeechRate(
        request.rate ?? speechRateForLevel(request.level ?? settingsRef.current.level),
      );

      if (runsInBrowser) {
        await speakInBrowser(request, rate, generation);
      } else {
        await speakFromServer(request, rate, generation);
      }

      if (generation !== generationRef.current) {
        break;
      }
    }

    if (mountedRef.current) {
      setStatus('idle');
      setQueueLength(queueRef.current.length);
    }
  }, [runsInBrowser, speakFromServer, speakInBrowser]);

  const stop = useCallback((): void => {
    generationRef.current += 1;
    queueRef.current = [];

    abortRef.current?.abort();
    abortRef.current = null;

    const synthesis = browserSynthesis();

    if (synthesis && utteranceRef.current) {
      utteranceRef.current = null;
      synthesis.cancel();
    }

    releaseAudio();

    // Прерванная реплика больше не пришлёт `ended`: снимаем ожидание сами.
    const finishPlayback = finishPlaybackRef.current;

    finishPlaybackRef.current = null;
    finishPlayback?.();

    if (mountedRef.current) {
      setQueueLength(0);
      setStatus('idle');
    }
  }, [releaseAudio]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      queueRef.current = [];
      abortRef.current?.abort();
      abortRef.current = null;
      browserSynthesis()?.cancel();
      releaseAudio();

      const finishPlayback = finishPlaybackRef.current;

      finishPlaybackRef.current = null;
      finishPlayback?.();
    };
  }, [releaseAudio]);

  const enqueue = useCallback(
    async (input: SpeakInput): Promise<void> => {
      const request = toRequest(input);

      if (request.text.trim().length === 0) {
        return;
      }

      if (capabilityFailure) {
        setFailure(capabilityFailure);
        settingsRef.current.onFailure?.(capabilityFailure);

        return;
      }

      setFailure(null);
      queueRef.current.push(request);
      setQueueLength(queueRef.current.length);

      if (!runnerRef.current) {
        runnerRef.current = pump().finally(() => {
          runnerRef.current = null;
        });
      }

      await runnerRef.current;
    },
    [capabilityFailure, pump],
  );

  const speak = useCallback(
    async (input: SpeakInput): Promise<void> => {
      stop();

      // Прерванная очередь ещё доигрывает текущий кадр: ждём, чтобы не смешать реплики.
      await runnerRef.current;
      await enqueue(input);
    },
    [enqueue, stop],
  );

  const reset = useCallback((): void => {
    setFailure(null);
  }, []);

  const resolvedStatus: TextToSpeechStatus = useMemo(() => {
    if (status !== 'idle') {
      return status;
    }

    if (capabilityFailure) {
      return 'unavailable';
    }

    return failure ? 'error' : 'idle';
  }, [capabilityFailure, failure, status]);

  return {
    status: resolvedStatus,
    isSpeaking: status === 'speaking',
    available: capabilityFailure === null && tts.available,
    provider: ttsProvider,
    runsInBrowser,
    queueLength,
    rate: clampSpeechRate(speechRateForLevel(level)),
    failure: failure ?? capabilityFailure,
    speak,
    enqueue,
    stop,
    reset,
  };
}
