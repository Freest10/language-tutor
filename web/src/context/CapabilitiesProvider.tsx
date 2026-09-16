/**
 * Возможности бэкенда и браузера: что именно доступно для голосового диалога.
 *
 * Конфигурацию отдаёт `GET /api/config`, но её мало: провайдер `browser`
 * означает, что распознавание и синтез выполняет сам браузер, а Web Speech API
 * есть не везде — в Firefox его фактически нет (допущение A14). Поэтому провайдер
 * сводит ответ сервера с результатом проверки браузерных API и выставляет
 * `blocker` и `needsServerFallback`: интерфейсу есть что показать пользователю,
 * вместо молча неработающего микрофона.
 */
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';

import {
  getConfigResponseSchema,
  type AppConfig,
  type LlmCapability,
  type SttCapability,
  type TtsCapability,
  type VoiceProvider,
} from '@lt/shared';

import { ApiError, api } from '../api/client';
import { setConfigSource } from '../i18n/configLocation';

/** Ключ запроса конфигурации: по нему её можно перечитать из любой страницы. */
export const CAPABILITIES_QUERY_KEY = ['config'] as const;

/** Браузерные API, от которых зависит голосовой режим. */
export interface BrowserSpeechSupport {
  /** `SpeechRecognition` или `webkitSpeechRecognition` — распознавание в браузере. */
  speechRecognition: boolean;
  /** `speechSynthesis` — синтез в браузере. */
  speechSynthesis: boolean;
  /** `navigator.mediaDevices.getUserMedia` — доступ к микрофону. */
  microphone: boolean;
  /** `MediaRecorder` — запись аудио для отправки на сервер. */
  mediaRecorder: boolean;
}

/** Почему голосовая возможность недоступна. */
export type VoiceBlocker =
  /** Провайдер `browser`, но нужного Web Speech API в браузере нет (A14). */
  | 'browser_api_missing'
  /** Провайдер серверный, но не настроен: нет URL, модели или ключа. */
  | 'server_not_configured'
  /** Конфигурация сервера ещё не получена. */
  | 'config_unavailable';

/** Итоговое состояние распознавания или синтеза речи. */
export interface VoiceCapabilityState {
  /** Кто выполняет работу по конфигурации сервера; `null` — конфигурация не получена. */
  provider: VoiceProvider | null;
  /** Возможность доступна с учётом и сервера, и браузера. */
  available: boolean;
  /** Работу выполняет браузер, а не сервер. */
  runsInBrowser: boolean;
  /** Причина недоступности; `null`, когда всё работает. */
  blocker: VoiceBlocker | null;
  /** Пояснение сервера из `GET /api/config`. */
  reason: string | null;
  /**
   * Браузерный путь невозможен, и лечится это только переключением
   * на серверного провайдера (`STT_PROVIDER`/`TTS_PROVIDER` в `.env`).
   */
  needsServerFallback: boolean;
}

/** Значение контекста возможностей. */
export interface CapabilitiesValue {
  /** Состояние загрузки конфигурации. */
  status: 'loading' | 'ready' | 'error';
  /** Ответ `GET /api/config`; `null`, пока он не получен. */
  config: AppConfig | null;
  /** Ошибка запроса конфигурации. */
  error: ApiError | null;
  /** Перечитать конфигурацию (кнопка «Повторить»). */
  refresh: () => void;
  /** Доступность языковой модели. */
  llm: LlmCapability;
  /** Имя модели, если она настроена. */
  llmModel: string | null;
  /** Распознавание речи с учётом браузера. */
  stt: VoiceCapabilityState;
  /** Кто распознаёт речь по конфигурации сервера. */
  sttProvider: VoiceProvider | null;
  /** Синтез речи с учётом браузера. */
  tts: VoiceCapabilityState;
  /** Кто синтезирует речь по конфигурации сервера. */
  ttsProvider: VoiceProvider | null;
  /** Результат проверки браузерных API. */
  browser: BrowserSpeechSupport;
}

const CapabilitiesContext = createContext<CapabilitiesValue | null>(null);

/** Проверяет браузерные API, от которых зависит голосовой режим. */
function detectBrowserSupport(): BrowserSpeechSupport {
  if (typeof window === 'undefined') {
    return {
      speechRecognition: false,
      speechSynthesis: false,
      microphone: false,
      mediaRecorder: false,
    };
  }

  return {
    speechRecognition: 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window,
    speechSynthesis:
      'speechSynthesis' in window && typeof window.speechSynthesis?.speak === 'function',
    microphone: typeof navigator.mediaDevices?.getUserMedia === 'function',
    mediaRecorder: 'MediaRecorder' in window,
  };
}

/** Состояние возможности, пока конфигурация не получена. */
const UNKNOWN_VOICE_STATE: VoiceCapabilityState = {
  provider: null,
  available: false,
  runsInBrowser: false,
  blocker: 'config_unavailable',
  reason: null,
  needsServerFallback: false,
};

/** Что мешает серверному провайдеру: настройка сервера или отсутствие API записи. */
function serverBlocker(serverConfigured: boolean, browserReady: boolean): VoiceBlocker | null {
  if (!serverConfigured) {
    return 'server_not_configured';
  }

  return browserReady ? null : 'browser_api_missing';
}

/**
 * Сводит ответ сервера с проверкой браузера в одно состояние.
 *
 * @param capability возможность из `GET /api/config`.
 * @param browserReady есть ли в браузере API, без которого этот путь не работает:
 *   для провайдера `browser` — Web Speech API, для серверного — запись звука.
 */
function deriveVoiceState(
  capability: SttCapability | TtsCapability | undefined,
  browserReady: boolean,
): VoiceCapabilityState {
  if (!capability) {
    return UNKNOWN_VOICE_STATE;
  }

  const reason = capability.reason ?? null;

  if (capability.provider === 'browser') {
    return {
      provider: 'browser',
      available: browserReady,
      runsInBrowser: true,
      blocker: browserReady ? null : 'browser_api_missing',
      reason,
      // Браузерный путь не починить из интерфейса: нужен серверный провайдер.
      needsServerFallback: !browserReady,
    };
  }

  return {
    provider: capability.provider,
    available: capability.available && browserReady,
    runsInBrowser: false,
    blocker: serverBlocker(capability.available, browserReady),
    reason,
    needsServerFallback: false,
  };
}

/** Свойства провайдера возможностей. */
export interface CapabilitiesProviderProps {
  children: ReactNode;
}

/** Загружает `GET /api/config` и отдаёт возможности через контекст. */
export function CapabilitiesProvider({ children }: CapabilitiesProviderProps) {
  const query = useQuery({
    queryKey: CAPABILITIES_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/config', { schema: getConfigResponseSchema, signal }),
    // Конфигурация меняется только при перезапуске сервера.
    staleTime: Number.POSITIVE_INFINITY,
  });

  const { data, error, isPending, refetch } = query;

  // Подсказки «поправьте настройки» должны вести туда, где настройки лежат:
  // в файл `.env` у веб-версии и в меню у десктопной. Узнаём это здесь —
  // раньше конфигурации такого знания просто нет.
  useEffect(() => {
    if (data) {
      setConfigSource(data.configSource);
    }
  }, [data]);

  const value = useMemo<CapabilitiesValue>(() => {
    const browser = detectBrowserSupport();
    const config = data ?? null;
    const llm: LlmCapability = config?.llm ?? {
      available: false,
      model: null,
      reason: null,
    };

    return {
      status: isPending ? 'loading' : error ? 'error' : 'ready',
      config,
      error: error ? ApiError.from(error) : null,
      refresh: () => {
        void refetch();
      },
      llm,
      llmModel: llm.model ?? null,
      stt: deriveVoiceState(
        config?.stt,
        config?.stt.provider === 'browser'
          ? browser.speechRecognition
          : browser.mediaRecorder && browser.microphone,
      ),
      sttProvider: config?.stt.provider ?? null,
      tts: deriveVoiceState(
        config?.tts,
        config?.tts.provider !== 'browser' || browser.speechSynthesis,
      ),
      ttsProvider: config?.tts.provider ?? null,
      browser,
    };
  }, [data, error, isPending, refetch]);

  return <CapabilitiesContext.Provider value={value}>{children}</CapabilitiesContext.Provider>;
}

/** Возможности бэкенда и браузера; работает только внутри `CapabilitiesProvider`. */
export function useCapabilities(): CapabilitiesValue {
  const value = useContext(CapabilitiesContext);

  if (!value) {
    throw new Error('useCapabilities вызван вне CapabilitiesProvider');
  }

  return value;
}
