/**
 * Голосовой слой: запись, распознавание, озвучивание и деградация.
 *
 * Браузерных API записи и речи в jsdom нет, поэтому `MediaRecorder`,
 * `getUserMedia`, `SpeechRecognition`, `speechSynthesis` и `Audio` подменяются
 * заглушками: тест проверяет поведение слоя (в том числе освобождение треков
 * микрофона и очистку очереди озвучивания), а не реализацию браузера.
 *
 * Сервер тоже подменён: важно, что уходит в `POST /api/voice/stt` и как
 * интерфейс объясняет ответ 501 `not_configured` с пометкой `stt_browser_only`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_PREFIX,
  APP_NAME,
  DEFAULT_CEFR_LEVEL,
  DEFAULT_DAILY_MINUTES,
  KNOWN_LANGUAGE_CODES,
  LANGUAGE_LABELS,
  STT_AUDIO_FIELD_NAME,
  type ApiErrorResponse,
  type AppConfig,
  type SttResponse,
  type TtsResponse,
  type VoiceProvider,
} from '@lt/shared';

import { ApiError } from '../src/api/client';
import { CapabilitiesProvider } from '../src/context/CapabilitiesProvider';
import { PushToTalkButton } from '../src/features/voice/PushToTalkButton';
import {
  pickRecorderMimeType,
  useMicRecorder,
  type MicOutcome,
} from '../src/features/voice/useMicRecorder';
import { useSpeechRecognition } from '../src/features/voice/useSpeechRecognition';
import { pickSpeechVoice, useTextToSpeech } from '../src/features/voice/useTextToSpeech';
import {
  kindFromApiError,
  useVoiceInput,
  type VoiceInputResult,
} from '../src/features/voice/useVoiceInput';
import { i18n } from '../src/i18n';
import { I18nProvider } from '../src/i18n/I18nProvider';

/**
 * Конфигурация сервера с нужными провайдерами голоса.
 *
 * @param stt кто распознаёт речь.
 * @param tts кто синтезирует речь.
 * @param limits переопределения пределов из `GET /api/config`.
 */
function configFixture(
  stt: VoiceProvider,
  tts: VoiceProvider,
  limits: Partial<AppConfig['limits']> = {},
): AppConfig {
  return {
    appName: APP_NAME,
    apiPrefix: API_PREFIX,
    version: '0.1.0',
    llm: { available: true, model: 'qwen2.5', reason: null },
    stt: {
      provider: stt,
      available: true,
      model: stt === 'openai' ? 'whisper-1' : null,
      reason: null,
    },
    tts: {
      provider: tts,
      available: true,
      model: tts === 'openai' ? 'gpt-4o-mini-tts' : null,
      voice: tts === 'openai' ? 'alloy' : null,
      formats: tts === 'openai' ? ['mp3'] : [],
      reason: null,
    },
    supportedLanguages: KNOWN_LANGUAGE_CODES.map((code) => ({ code, ...LANGUAGE_LABELS[code] })),
    defaults: {
      learningLanguage: 'en',
      interfaceLanguage: 'en',
      explanationLanguage: 'ru',
      level: DEFAULT_CEFR_LEVEL,
      dailyMinutes: DEFAULT_DAILY_MINUTES,
    },
    limits: {
      maxMaterialUploadBytes: 10_485_760,
      maxMaterialTextLength: 200_000,
      maxAudioUploadBytes: 26_214_400,
      maxTtsTextLength: 2_000,
      maxPageSize: 100,
      ...limits,
    },
  };
}

/** Запрос, дошедший до подменённого `fetch`. */
interface FetchRecord {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
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

/** Конверт ошибки сервера. */
function errorResponse(
  code: ApiErrorResponse['error']['code'],
  status: number,
  details?: unknown,
): Response {
  return jsonResponse({ error: { code, message: `HTTP ${status}`, details } }, status);
}

/** Подменяет `fetch` обработчиком, который отвечает по адресу и методу запроса. */
function stubFetch(handler: (record: FetchRecord) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const record: FetchRecord = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body,
      };

      calls.push(record);

      return Promise.resolve(handler(record));
    }),
  );
}

/** Ответ распознавания речи. */
function sttResponse(text: string): SttResponse {
  return { text, language: 'en', durationMs: 1200, provider: 'openai', model: 'whisper-1' };
}

/** Ответ синтеза речи: аудио приходит в base64 внутри JSON (A9). */
function ttsResponse(): TtsResponse {
  return {
    audioBase64: btoa('fake-mp3-bytes'),
    contentType: 'audio/mpeg',
    format: 'mp3',
    provider: 'openai',
    voice: 'alloy',
    model: 'gpt-4o-mini-tts',
    durationMs: 900,
  };
}

/** Аудиодорожка микрофона со счётчиком освобождений. */
interface FakeTrack {
  kind: string;
  stop: ReturnType<typeof vi.fn>;
}

/** Дорожки, выданные подменённым `getUserMedia` в текущем тесте. */
let tracks: FakeTrack[] = [];

/** Поток микрофона: единственная дорожка, которую обязаны остановить. */
function createStream(): MediaStream {
  const track: FakeTrack = { kind: 'audio', stop: vi.fn() };

  tracks.push(track);

  return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
}

/** Подменяет доступ к микрофону. */
function stubMicrophone(getUserMedia: () => Promise<MediaStream>): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(getUserMedia) },
    configurable: true,
  });
}

/** Заглушка `MediaRecorder`: пишет один кусок и отдаёт его на остановке. */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];

  static isTypeSupported = vi.fn(
    (type: string) => type === 'audio/webm;codecs=opus' || type === 'audio/webm',
  );

  state: 'inactive' | 'recording' | 'paused' = 'inactive';

  mimeType: string;

  ondataavailable: ((event: BlobEvent) => void) | null = null;

  onstop: ((event: Event) => void) | null = null;

  onerror: ((event: Event) => void) | null = null;

  /** Контейнер, который запросил вызывающий код; `null` — выбор оставлен браузеру. */
  requestedMimeType: string | null;

  constructor(
    public stream: MediaStream,
    options?: MediaRecorderOptions,
  ) {
    this.requestedMimeType = options?.mimeType ?? null;
    this.mimeType = options?.mimeType ?? 'audio/webm';
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({
      data: new Blob(['audio-bytes'], { type: 'audio/webm' }),
    } as BlobEvent);
    this.onstop?.(new Event('stop'));
  }
}

/** Результат распознавания в форме, которую отдаёт Web Speech API. */
function recognitionResults(transcript: string, isFinal: boolean): SpeechRecognitionResultList {
  const alternative = { transcript, confidence: 0.9 };
  const result = {
    0: alternative,
    isFinal,
    length: 1,
    item: () => alternative,
  };

  return {
    0: result,
    length: 1,
    item: () => result,
  } as unknown as SpeechRecognitionResultList;
}

/** Заглушка `SpeechRecognition`: промежуточные и финальные результаты по команде. */
class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];

  lang = '';

  continuous = false;

  interimResults = false;

  maxAlternatives = 1;

  started = false;

  aborted = false;

  onresult: ((event: SpeechRecognitionEvent) => void) | null = null;

  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null = null;

  onend: ((event: Event) => void) | null = null;

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.started = false;
    this.onend?.(new Event('end'));
  }

  abort(): void {
    this.aborted = true;
    this.started = false;
    this.onend?.(new Event('end'));
  }

  emit(transcript: string, isFinal: boolean): void {
    this.onresult?.({
      resultIndex: 0,
      results: recognitionResults(transcript, isFinal),
    } as SpeechRecognitionEvent);
  }

  fail(error: string): void {
    this.onerror?.({ error, message: '' } as SpeechRecognitionErrorEvent);
  }
}

/** Заглушка `Audio`: воспроизведение фиксируется, а не слышится. */
class FakeAudio {
  static instances: FakeAudio[] = [];

  /** Чем заканчивается `play()`: браузер умеет отклонить его из-за автоплея. */
  static playRejection: unknown = null;

  paused = false;

  playCalls = 0;

  onended: (() => void) | null = null;

  onerror: (() => void) | null = null;

  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }

  play(): Promise<void> {
    this.playCalls += 1;

    return FakeAudio.playRejection === null
      ? Promise.resolve()
      : Promise.reject(FakeAudio.playRejection);
  }

  fail(): void {
    this.onerror?.();
  }

  pause(): void {
    this.paused = true;
  }

  removeAttribute(): void {
    this.src = '';
  }

  end(): void {
    this.onended?.();
  }
}

/** Голос системы в форме, которую отдаёт `speechSynthesis.getVoices()`. */
function fakeVoice(name: string, lang: string, isDefault = false): SpeechSynthesisVoice {
  return {
    name,
    lang,
    default: isDefault,
    localService: true,
    voiceURI: name,
  } as SpeechSynthesisVoice;
}

/** Заглушка `SpeechSynthesisUtterance`: реплика, которую браузер должен произнести. */
class FakeUtterance {
  static instances: FakeUtterance[] = [];

  lang = '';

  rate = 1;

  pitch = 1;

  volume = 1;

  voice: SpeechSynthesisVoice | null = null;

  onend: ((event: Event) => void) | null = null;

  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;

  constructor(public text: string) {
    FakeUtterance.instances.push(this);
  }

  /** Браузер договорил реплику. */
  finish(): void {
    this.onend?.(new Event('end'));
  }

  /** Движок синтеза отказал; `canceled`/`interrupted` — это наш собственный `stop()`. */
  fail(error: string): void {
    this.onerror?.({ error, message: '' } as unknown as SpeechSynthesisErrorEvent);
  }
}

/** Заглушка `speechSynthesis`: очередь реплик и счётчик отмен. */
class FakeSpeechSynthesis {
  spoken: FakeUtterance[] = [];

  cancelCalls = 0;

  voices: SpeechSynthesisVoice[] = [];

  speak(utterance: FakeUtterance): void {
    this.spoken.push(utterance);
  }

  cancel(): void {
    this.cancelCalls += 1;
  }

  getVoices(): SpeechSynthesisVoice[] {
    return this.voices;
  }

  addEventListener(): void {
    // Список голосов в заглушке готов сразу: событие `voiceschanged` не нужно.
  }

  removeEventListener(): void {
    // См. `addEventListener`.
  }
}

/** Синтез речи текущего теста. */
let synthesis: FakeSpeechSynthesis;

/** Подменяет браузерный синтез речи заданным набором голосов. */
function stubSynthesis(voices: readonly SpeechSynthesisVoice[] = []): FakeSpeechSynthesis {
  synthesis = new FakeSpeechSynthesis();
  synthesis.voices = [...voices];

  vi.stubGlobal('speechSynthesis', synthesis);
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);

  return synthesis;
}

/** Ссылки на объекты, выданные и освобождённые в текущем тесте. */
let createdUrls: string[] = [];
let revokedUrls: string[] = [];

/** Исходные реализации, которые вернём после теста. */
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

/** Поднимает компонент в тех же провайдерах, что и приложение. */
function renderVoice(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <CapabilitiesProvider>{ui}</CapabilitiesProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** Перевод ключа голосового namespace. */
function voiceText(key: string, params?: Record<string, unknown>): string {
  return i18n.t(`voice:${key}`, params ?? {});
}

/** Кнопка удержания с журналом расшифровок. */
function TalkHarness({ onResult }: { onResult?: (result: VoiceInputResult) => void }) {
  const [texts, setTexts] = useState<string[]>([]);

  return (
    <div>
      <input aria-label="reply" type="text" />
      <PushToTalkButton
        language="en"
        onResult={(result) => {
          setTexts((previous) => [...previous, result.text]);
          onResult?.(result);
        }}
      />
      <ul aria-label="transcripts">
        {texts.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </div>
  );
}

/** Озвучивание с двумя репликами: вторая обязана прервать первую. */
function SpeakHarness() {
  const tts = useTextToSpeech({ language: 'en', level: 'A1' });

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void tts.speak('First reply');
        }}
      >
        say-first
      </button>
      <button
        type="button"
        onClick={() => {
          void tts.speak('Second reply');
        }}
      >
        say-second
      </button>
      <button
        type="button"
        onClick={() => {
          void tts.enqueue('Queued first');
        }}
      >
        queue-first
      </button>
      <button
        type="button"
        onClick={() => {
          void tts.enqueue('Queued second');
        }}
      >
        queue-second
      </button>
      <p data-testid="tts-status">{tts.status}</p>
      <p data-testid="tts-queue">{tts.queueLength}</p>
      <p data-testid="tts-provider">{tts.provider ?? 'unknown'}</p>
      {tts.failure && (
        <div>
          <p>{tts.failure.message}</p>
          {tts.failure.hint && <p>{tts.failure.hint}</p>}
        </div>
      )}
    </div>
  );
}

/** Голосовой ввод без кнопки: нужен для проверки отмены. */
function InputHarness() {
  const voice = useVoiceInput({ language: 'en' });

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void voice.start();
        }}
      >
        begin
      </button>
      <button type="button" onClick={voice.cancel}>
        abort
      </button>
      <p data-testid="input-status">{voice.status}</p>
    </div>
  );
}

/** Ждёт, пока конфигурация сервера дойдёт до озвучивания. */
async function ttsReady(provider: VoiceProvider): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('tts-provider')).toHaveTextContent(provider);
  });
  await waitFor(() => {
    expect(screen.getByTestId('tts-status')).toHaveTextContent('idle');
  });
}

/** Ждёт, пока кнопка удержания станет доступной (конфигурация получена). */
async function talkButton(): Promise<HTMLElement> {
  const button = await screen.findByRole('button', { name: voiceText('pushToTalk.hold') });

  await waitFor(() => {
    expect(button).toBeEnabled();
  });

  return button;
}

/** Нажимает и отпускает кнопку удержания. */
async function holdAndRelease(button: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
  });
  await act(async () => {
    fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
  });
}

beforeEach(async () => {
  calls = [];
  tracks = [];
  createdUrls = [];
  revokedUrls = [];
  FakeMediaRecorder.instances = [];
  FakeSpeechRecognition.instances = [];
  FakeAudio.instances = [];
  FakeAudio.playRejection = null;
  FakeUtterance.instances = [];

  URL.createObjectURL = vi.fn(() => {
    const url = `blob:audio-${createdUrls.length}`;

    createdUrls.push(url);

    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revokedUrls.push(url);
  });

  await i18n.changeLanguage('en');
});

afterEach(() => {
  // При `globals: false` автоматической очистки DOM нет — убираем её вручную.
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'mediaDevices');
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe('серверное распознавание речи', () => {
  beforeEach(() => {
    stubMicrophone(() => Promise.resolve(createStream()));
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  });

  it('проходит путь «запись → остановка → текст» и отпускает микрофон', async () => {
    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(configFixture('openai', 'openai'))
        : jsonResponse(sttResponse('I would like a coffee')),
    );

    const onResult = vi.fn();

    renderVoice(<TalkHarness onResult={onResult} />);

    const button = await talkButton();

    await act(async () => {
      fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    });

    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(FakeMediaRecorder.instances[0]?.state).toBe('recording');
    // Контейнер выбран из поддерживаемых браузером, а не зашит в код.
    expect(FakeMediaRecorder.instances[0]?.mimeType).toBe('audio/webm;codecs=opus');
    expect(await screen.findByText(voiceText('state.listening'))).toBeInTheDocument();

    await act(async () => {
      fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
    });

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'I would like a coffee', provider: 'openai' }),
      );
    });

    expect(await screen.findByText('I would like a coffee')).toBeInTheDocument();
    // Без `track.stop()` индикатор записи в браузере горел бы до конца сессии.
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it('кладёт запись в поле «audio» multipart-запроса', async () => {
    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(configFixture('openai', 'openai'))
        : jsonResponse(sttResponse('Hello')),
    );

    renderVoice(<TalkHarness />);
    await holdAndRelease(await talkButton());

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/voice/stt'))).toBe(true);
    });

    const upload = calls.find((call) => call.url.includes('/voice/stt'));

    expect(upload?.method).toBe('POST');
    expect(upload?.body).toBeInstanceOf(FormData);

    const form = upload?.body as FormData;
    const sent = form.get(STT_AUDIO_FIELD_NAME);

    expect(sent).toBeInstanceOf(Blob);
    expect((sent as Blob).size).toBeGreaterThan(0);
    expect(form.get('language')).toBe('en');
  });

  it('не отправляет запись, если реплику отменили', async () => {
    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(configFixture('openai', 'openai'))
        : jsonResponse(sttResponse('Not sent')),
    );

    renderVoice(<InputHarness />);

    await waitFor(() => {
      expect(screen.getByTestId('input-status')).toHaveTextContent('idle');
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'begin' }));
    });

    expect(FakeMediaRecorder.instances[0]?.state).toBe('recording');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'abort' }));
    });

    expect(calls.some((call) => call.url.includes('/voice/stt'))).toBe(false);
    expect(tracks[0]?.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('input-status')).toHaveTextContent('idle');
  });

  it('объясняет ответ 501 «распознаёт браузер», а не показывает общую ошибку', async () => {
    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(configFixture('openai', 'openai'))
        : errorResponse('not_configured', 501, { reason: 'stt_browser_only', provider: 'browser' }),
    );

    renderVoice(<TalkHarness />);
    await holdAndRelease(await talkButton());

    expect(await screen.findByText(voiceText('input.errors.browser_only'))).toBeInTheDocument();
    expect(screen.getByText(voiceText('hints.browserMode'))).toBeInTheDocument();
    // Общая формулировка 501 здесь ничего не объясняет.
    expect(screen.queryByText(i18n.t('errors.byCode.not_configured'))).not.toBeInTheDocument();
    expect(
      screen.queryByText(voiceText('input.errors.server_not_configured')),
    ).not.toBeInTheDocument();
  });

  it('объясняет отказ в доступе к микрофону и не роняет приложение', async () => {
    const denied = new DOMException('Permission denied', 'NotAllowedError');

    stubMicrophone(() => Promise.reject(denied));
    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(configFixture('openai', 'openai'))
        : jsonResponse(sttResponse('unreachable')),
    );

    renderVoice(<TalkHarness />);

    const button = await talkButton();

    await holdAndRelease(button);

    expect(
      await screen.findByText(voiceText('input.errors.permission_denied')),
    ).toBeInTheDocument();
    expect(screen.getByText(voiceText('hints.allowMicrophone'))).toBeInTheDocument();
    expect(screen.getByText(voiceText('hints.typeInstead'))).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('/voice/stt'))).toBe(false);
    expect(button).toBeInTheDocument();
  });
});

describe('распознавание речи браузером', () => {
  beforeEach(() => {
    vi.stubGlobal('SpeechRecognition', FakeSpeechRecognition);
    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(configFixture('browser', 'browser'))
        : errorResponse('not_configured', 501, { reason: 'stt_browser_only' }),
    );
  });

  it('показывает промежуточный текст и отдаёт финальный, не обращаясь к серверу', async () => {
    const onResult = vi.fn();

    renderVoice(<TalkHarness onResult={onResult} />);

    const button = await talkButton();

    await act(async () => {
      fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    });

    const recognition = FakeSpeechRecognition.instances[0];

    expect(recognition?.started).toBe(true);
    // Язык распознавания — изучаемый язык из профиля, а не язык интерфейса.
    expect(recognition?.lang).toBe('en');
    expect(recognition?.interimResults).toBe(true);

    await act(async () => {
      recognition?.emit('I want a', false);
    });

    expect(
      await screen.findByText(voiceText('status.interim', { text: 'I want a' }), { exact: false }),
    ).toBeInTheDocument();

    await act(async () => {
      recognition?.emit('I want a coffee', true);
    });
    await act(async () => {
      fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
    });

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'I want a coffee', provider: 'browser' }),
      );
    });

    expect(calls.some((call) => call.url.includes('/voice/stt'))).toBe(false);
  });

  it('удержание пробела запускает запись, а в текстовом поле — нет', async () => {
    renderVoice(<TalkHarness />);
    await talkButton();

    const field = screen.getByLabelText('reply');

    await act(async () => {
      fireEvent.keyDown(field, { code: 'Space', key: ' ' });
    });

    expect(FakeSpeechRecognition.instances).toHaveLength(0);

    const keyDown = createEvent();

    await act(async () => {
      document.body.dispatchEvent(keyDown);
    });

    expect(FakeSpeechRecognition.instances).toHaveLength(1);
    // Иначе пробел пролистал бы страницу прямо во время реплики.
    expect(keyDown.defaultPrevented).toBe(true);

    await act(async () => {
      FakeSpeechRecognition.instances[0]?.emit('Yes please', true);
    });
    await act(async () => {
      fireEvent.keyUp(document.body, { code: 'Space', key: ' ' });
    });

    expect(await screen.findByText('Yes please')).toBeInTheDocument();
  });

  it('объясняет запрет доступа к микрофону в браузерном режиме', async () => {
    renderVoice(<TalkHarness />);

    const button = await talkButton();

    await act(async () => {
      fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    });
    await act(async () => {
      FakeSpeechRecognition.instances[0]?.fail('not-allowed');
    });
    await act(async () => {
      fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
    });

    expect(
      await screen.findByText(voiceText('input.errors.permission_denied')),
    ).toBeInTheDocument();
  });
});

/** Событие нажатия пробела, у которого можно проверить `preventDefault`. */
function createEvent(): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    code: 'Space',
    key: ' ',
    bubbles: true,
    cancelable: true,
  });
}

describe('голос недоступен', () => {
  it('предлагает включить серверное распознавание, когда в браузере нет Web Speech API', async () => {
    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(configFixture('browser', 'browser'))
        : errorResponse('not_configured', 501),
    );

    renderVoice(<TalkHarness />);

    expect(await screen.findByText(voiceText('input.errors.unsupported'))).toBeInTheDocument();
    expect(screen.getByText(voiceText('hints.enableServerStt'))).toBeInTheDocument();
    expect(screen.getByText(voiceText('hints.typeInstead'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: voiceText('pushToTalk.hold') })).toBeDisabled();
  });

  it('предупреждает про серверный синтез, когда в браузере нет speechSynthesis', async () => {
    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(configFixture('openai', 'browser'))
        : errorResponse('not_configured', 501),
    );

    renderVoice(<SpeakHarness />);

    expect(await screen.findByText(voiceText('output.errors.unsupported'))).toBeInTheDocument();
    expect(screen.getByText(voiceText('hints.enableServerTts'))).toBeInTheDocument();
    expect(screen.getByTestId('tts-status')).toHaveTextContent('unavailable');
  });
});

describe('озвучивание ответов', () => {
  beforeEach(() => {
    vi.stubGlobal('Audio', FakeAudio);
    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(configFixture('openai', 'openai'))
        : jsonResponse(ttsResponse()),
    );
  });

  it('проигрывает ответ и говорит медленнее на уровне A1', async () => {
    renderVoice(<SpeakHarness />);
    await ttsReady('openai');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'say-first' }));
    });

    await waitFor(() => {
      expect(FakeAudio.instances).toHaveLength(1);
    });

    const request = calls.find((call) => call.url.includes('/voice/tts'));
    const body = JSON.parse(String(request?.body)) as { text: string; speed: number };

    expect(body.text).toBe('First reply');
    expect(body.speed).toBeLessThan(1);
    expect(FakeAudio.instances[0]?.playCalls).toBe(1);
    expect(screen.getByTestId('tts-status')).toHaveTextContent('speaking');

    await act(async () => {
      FakeAudio.instances[0]?.end();
    });

    await waitFor(() => {
      expect(screen.getByTestId('tts-status')).toHaveTextContent('idle');
    });

    // Ссылка на аудио освобождена: иначе за урок в памяти копятся записи.
    expect(revokedUrls).toContain(createdUrls[0]);
  });

  it('прерывает звучащую реплику новой и очищает очередь', async () => {
    renderVoice(<SpeakHarness />);
    await ttsReady('openai');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'say-first' }));
    });

    await waitFor(() => {
      expect(FakeAudio.instances).toHaveLength(1);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'say-second' }));
    });

    // Первая реплика остановлена, её ссылка освобождена, очередь пуста.
    expect(FakeAudio.instances[0]?.paused).toBe(true);
    expect(revokedUrls).toContain(createdUrls[0]);
    expect(screen.getByTestId('tts-queue')).toHaveTextContent('0');

    await waitFor(() => {
      expect(FakeAudio.instances).toHaveLength(2);
    });

    const spoken = calls
      .filter((call) => call.url.includes('/voice/tts'))
      .map((call) => (JSON.parse(String(call.body)) as { text: string }).text);

    expect(spoken).toEqual(['First reply', 'Second reply']);

    await act(async () => {
      FakeAudio.instances[1]?.end();
    });

    await waitFor(() => {
      expect(screen.getByTestId('tts-status')).toHaveTextContent('idle');
    });
  });
});

describe('подбор голоса браузера', () => {
  const VOICES = [
    fakeVoice('Alice', 'en-US', true),
    fakeVoice('Luciana', 'pt-PT'),
    fakeVoice('Joana', 'pt-BR', true),
    fakeVoice('Milena', 'ru-RU'),
  ];

  it('точное совпадение языка важнее порядка в списке', () => {
    expect(pickSpeechVoice(VOICES, 'pt-BR')?.name).toBe('Joana');
    expect(pickSpeechVoice(VOICES, 'ru-RU')?.name).toBe('Milena');
  });

  it('без точного совпадения берёт основной субтег и предпочитает голос по умолчанию', () => {
    // `pt` нет ни у одного голоса: годится любой португальский, лучше — системный.
    expect(pickSpeechVoice(VOICES, 'pt')?.name).toBe('Joana');
    expect(pickSpeechVoice([fakeVoice('Luciana', 'pt-PT')], 'pt-BR')?.name).toBe('Luciana');
  });

  it('имя голоса из настроек перекрывает подбор по языку', () => {
    expect(pickSpeechVoice(VOICES, 'pt-BR', 'Milena')?.name).toBe('Milena');
    // Голоса с таким именем в системе нет — подбираем по языку, а не молчим.
    expect(pickSpeechVoice(VOICES, 'ru-RU', 'Отсутствующий')?.name).toBe('Milena');
  });

  it('без голосов и без подходящего языка отдаёт `null`', () => {
    expect(pickSpeechVoice([], 'en-US')).toBeNull();
    expect(pickSpeechVoice([fakeVoice('Milena', 'ru-RU')], 'ja-JP')).toBeNull();
  });
});

describe('озвучивание браузером', () => {
  beforeEach(() => {
    stubSynthesis([fakeVoice('Alice', 'en-US', true), fakeVoice('Milena', 'ru-RU')]);
    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(configFixture('openai', 'browser'))
        : errorResponse('not_configured', 501, { reason: 'tts_browser_only' }),
    );
  });

  it('говорит голосом браузера и не обращается к серверу', async () => {
    renderVoice(<SpeakHarness />);
    await ttsReady('browser');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'say-first' }));
    });

    const utterance = FakeUtterance.instances[0];

    expect(synthesis.spoken).toHaveLength(1);
    expect(utterance?.text).toBe('First reply');
    // Язык произношения — изучаемый язык, скорость — по уровню A1.
    expect(utterance?.lang).toBe('en');
    expect(utterance?.rate).toBeLessThan(1);
    expect(utterance?.voice?.name).toBe('Alice');
    expect(screen.getByTestId('tts-status')).toHaveTextContent('speaking');
    expect(calls.some((call) => call.url.includes('/voice/tts'))).toBe(false);

    await act(async () => {
      utterance?.finish();
    });

    await waitFor(() => {
      expect(screen.getByTestId('tts-status')).toHaveTextContent('idle');
    });
  });

  it('очередь копится: `enqueue` не прерывает звучащую реплику', async () => {
    renderVoice(<SpeakHarness />);
    await ttsReady('browser');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'queue-first' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'queue-second' }));
    });

    // Первая реплика звучит, вторая ждёт: именно этим `enqueue` отличается от `speak`.
    expect(synthesis.spoken.map((item) => item.text)).toEqual(['Queued first']);
    expect(synthesis.cancelCalls).toBe(0);
    expect(screen.getByTestId('tts-queue')).toHaveTextContent('1');

    await act(async () => {
      FakeUtterance.instances[0]?.finish();
    });

    await waitFor(() => {
      expect(synthesis.spoken.map((item) => item.text)).toEqual(['Queued first', 'Queued second']);
    });
    expect(screen.getByTestId('tts-queue')).toHaveTextContent('0');

    await act(async () => {
      FakeUtterance.instances[1]?.finish();
    });

    await waitFor(() => {
      expect(screen.getByTestId('tts-status')).toHaveTextContent('idle');
    });
  });

  it('новая реплика прерывает звучащую через `speechSynthesis.cancel()`', async () => {
    renderVoice(<SpeakHarness />);
    await ttsReady('browser');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'say-first' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'say-second' }));
    });

    expect(synthesis.cancelCalls).toBeGreaterThan(0);

    await waitFor(() => {
      expect(synthesis.spoken.map((item) => item.text)).toEqual(['First reply', 'Second reply']);
    });
    expect(screen.getByTestId('tts-queue')).toHaveTextContent('0');
  });

  it('отказ движка синтеза объясняется словами и не считает отменой', async () => {
    renderVoice(<SpeakHarness />);
    await ttsReady('browser');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'say-first' }));
    });
    await act(async () => {
      FakeUtterance.instances[0]?.fail('synthesis-failed');
    });

    expect(await screen.findByText(voiceText('output.errors.failed'))).toBeInTheDocument();
    expect(screen.getByText(voiceText('hints.retry'))).toBeInTheDocument();
    expect(screen.getByTestId('tts-status')).toHaveTextContent('error');
  });

  it('собственный `stop()` (`canceled`) отказом не считается', async () => {
    renderVoice(<SpeakHarness />);
    await ttsReady('browser');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'say-first' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'say-second' }));
      FakeUtterance.instances[0]?.fail('canceled');
    });

    expect(screen.queryByText(voiceText('output.errors.failed'))).not.toBeInTheDocument();
  });
});

describe('отказы серверного синтеза', () => {
  /** Поднимает озвучивание с серверным синтезом и заданным ответом `/voice/tts`. */
  function renderServerTts(ttsHandler: () => Response): void {
    vi.stubGlobal('Audio', FakeAudio);
    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(configFixture('openai', 'openai'))
        : ttsHandler(),
    );
    renderVoice(<SpeakHarness />);
  }

  /** Нажимает «сказать» и ждёт готовности конфигурации. */
  async function speakFirst(): Promise<void> {
    await ttsReady('openai');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'say-first' }));
    });
  }

  it('объясняет заблокированный браузером автоплей, а не молчит', async () => {
    // Самый частый реальный сбой: `audio.play()` отклонён политикой автоплея.
    FakeAudio.playRejection = new DOMException('play() failed', 'NotAllowedError');
    renderServerTts(() => jsonResponse(ttsResponse()));
    await speakFirst();

    expect(await screen.findByText(voiceText('output.errors.failed'))).toBeInTheDocument();
    expect(screen.getByTestId('tts-status')).toHaveTextContent('error');
    // Ссылка на аудио освобождена и после отказа.
    await waitFor(() => {
      expect(revokedUrls).toContain(createdUrls[0]);
    });
  });

  it('объясняет ошибку воспроизведения аудио', async () => {
    renderServerTts(() => jsonResponse(ttsResponse()));
    await speakFirst();

    await waitFor(() => {
      expect(FakeAudio.instances).toHaveLength(1);
    });

    await act(async () => {
      FakeAudio.instances[0]?.fail();
    });

    expect(await screen.findByText(voiceText('output.errors.failed'))).toBeInTheDocument();
    expect(screen.getByTestId('tts-status')).toHaveTextContent('error');
  });

  it('объясняет отказ `POST /api/voice/tts`', async () => {
    renderServerTts(() => errorResponse('upstream_unavailable', 503));
    await speakFirst();

    expect(await screen.findByText(voiceText('output.errors.failed'))).toBeInTheDocument();
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it('501 «синтезирует браузер» объясняется отдельно от общего отказа', async () => {
    renderServerTts(() => errorResponse('not_configured', 501, { reason: 'tts_browser_only' }));
    await speakFirst();

    expect(await screen.findByText(voiceText('output.errors.browser_only'))).toBeInTheDocument();
    expect(screen.getByText(voiceText('hints.browserMode'))).toBeInTheDocument();
  });
});

describe('причина отказа распознавания по ответу сервера', () => {
  /** Отказ сервера с заданным кодом и статусом. */
  function serverError(code: ApiErrorResponse['error']['code'], status: number): ApiError {
    return new ApiError({ code, message: `HTTP ${status}`, status });
  }

  it('различает таймаут, обрыв связи и отказы внешней модели', () => {
    expect(
      kindFromApiError(
        new ApiError({
          code: 'upstream_unavailable',
          message: 'таймаут',
          status: 0,
          clientReason: 'timeout',
        }),
        'input',
      ),
    ).toBe('timeout');
    expect(
      kindFromApiError(
        new ApiError({
          code: 'upstream_unavailable',
          message: 'нет связи',
          status: 0,
          clientReason: 'network',
        }),
        'input',
      ),
    ).toBe('network');
    // 502 и 503 для пользователя одинаковы: голос просто не сработал.
    expect(kindFromApiError(serverError('upstream_error', 502), 'input')).toBe('failed');
    expect(kindFromApiError(serverError('upstream_unavailable', 503), 'input')).toBe('failed');
  });

  it('отделяет слишком длинную запись и неподходящий контейнер', () => {
    expect(kindFromApiError(serverError('payload_too_large', 413), 'input')).toBe('too_large');
    expect(kindFromApiError(serverError('unsupported_media_type', 415), 'input')).toBe(
      'unsupported_format',
    );
  });

  it('501 читается как «делает браузер», а с другой причиной — как ненастроенный сервер', () => {
    expect(
      kindFromApiError(
        new ApiError({
          code: 'not_configured',
          message: 'HTTP 501',
          status: 501,
          details: { reason: 'stt_browser_only' },
        }),
        'input',
      ),
    ).toBe('browser_only');
    expect(
      kindFromApiError(
        new ApiError({
          code: 'not_configured',
          message: 'HTTP 501',
          status: 501,
          details: { reason: 'model_missing' },
        }),
        'input',
      ),
    ).toBe('server_not_configured');
  });

  it('незнакомое исключение — просто отказ', () => {
    expect(kindFromApiError(new Error('boom'), 'input')).toBe('failed');
  });
});

describe('серверное распознавание: отказы до и после отправки', () => {
  beforeEach(() => {
    stubMicrophone(() => Promise.resolve(createStream()));
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  });

  it('не отправляет запись, которая больше предела из конфигурации', async () => {
    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(configFixture('openai', 'openai', { maxAudioUploadBytes: 4 }))
        : jsonResponse(sttResponse('unreachable')),
    );

    renderVoice(<TalkHarness />);
    await holdAndRelease(await talkButton());

    expect(await screen.findByText(voiceText('input.errors.too_large'))).toBeInTheDocument();
    expect(screen.getByText(voiceText('hints.shorterRecording'))).toBeInTheDocument();
    // Предел известен заранее: сеть не нагружаем заведомо отвергаемой записью.
    expect(calls.some((call) => call.url.includes('/voice/stt'))).toBe(false);
  });

  it('пустая расшифровка — это «речи не слышно», а не успешная реплика', async () => {
    const onResult = vi.fn();

    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(configFixture('openai', 'openai'))
        : jsonResponse(sttResponse('   ')),
    );

    renderVoice(<TalkHarness onResult={onResult} />);
    await holdAndRelease(await talkButton());

    expect(await screen.findByText(voiceText('input.errors.no_speech'))).toBeInTheDocument();
    expect(screen.getByText(voiceText('hints.speakAgain'))).toBeInTheDocument();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('таймаут распознавания объясняется отдельно от обрыва связи', async () => {
    stubFetch((record) => {
      if (record.url.includes('/config')) {
        return jsonResponse(configFixture('openai', 'openai'));
      }

      throw new DOMException('Network down', 'TypeError');
    });

    renderVoice(<TalkHarness />);
    await holdAndRelease(await talkButton());

    expect(await screen.findByText(voiceText('input.errors.network'))).toBeInTheDocument();
    expect(screen.getByText(voiceText('hints.retry'))).toBeInTheDocument();
  });
});

describe('остановка браузерного распознавания', () => {
  /** Движок, который не присылает `end` после `stop()`: кнопка не должна зависнуть. */
  class StuckSpeechRecognition extends FakeSpeechRecognition {
    override stop(): void {
      // Движок молчит: результат обязан отдать сторожевой таймер.
    }
  }

  it('через 5 секунд молчания движка отдаёт накопленный текст и прерывает его сам', async () => {
    vi.stubGlobal('SpeechRecognition', StuckSpeechRecognition);

    const { result } = renderHook(() => useSpeechRecognition({ language: 'en' }));

    act(() => {
      expect(result.current.start()).toBeNull();
    });

    const engine = FakeSpeechRecognition.instances[0];

    act(() => {
      engine?.emit('i went to the lake', true);
    });

    expect(result.current.finalText).toBe('i went to the lake');

    vi.useFakeTimers();

    const outcome = result.current.stop();

    // Без сторожевого таймера это обещание не завершилось бы никогда.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    await expect(outcome).resolves.toEqual({ text: 'i went to the lake', failure: null });
    expect(engine?.aborted).toBe(true);
    expect(result.current.isListening).toBe(false);
  });
});

describe('запись с микрофона', () => {
  /** Кадры анимации, которые тест проигрывает сам. */
  let frames: FrameRequestCallback[] = [];

  /** Анализатор громкости: отдаёт ровный громкий сигнал. */
  class FakeAnalyser {
    fftSize = 512;

    connect(): void {
      // Граф звука в заглушке не нужен.
    }

    getByteTimeDomainData(target: Uint8Array): void {
      target.fill(200);
    }
  }

  /** Звуковой контекст: ровно то, чем пользуется индикатор громкости. */
  class FakeAudioContext {
    createAnalyser(): FakeAnalyser {
      return new FakeAnalyser();
    }

    createMediaStreamSource(): { connect: (target: unknown) => void } {
      return { connect: () => undefined };
    }

    close(): Promise<void> {
      return Promise.resolve();
    }
  }

  beforeEach(() => {
    frames = [];
    stubMicrophone(() => Promise.resolve(createStream()));
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);

      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    FakeMediaRecorder.isTypeSupported.mockImplementation(
      (type: string) => type === 'audio/webm;codecs=opus' || type === 'audio/webm',
    );
  });

  it('выбирает первый поддерживаемый контейнер, а без поддержки оставляет выбор браузеру', () => {
    expect(pickRecorderMimeType(['audio/ogg', 'audio/webm'])).toBe('audio/webm');

    FakeMediaRecorder.isTypeSupported.mockImplementation(() => false);

    // Ни один кандидат не подтверждён: `MediaRecorder` создаётся без опций.
    expect(pickRecorderMimeType(['audio/ogg', 'audio/mp4'])).toBeNull();
  });

  it('без подтверждённого контейнера пишет опциями по умолчанию', async () => {
    FakeMediaRecorder.isTypeSupported.mockImplementation(() => false);

    const { result } = renderHook(() => useMicRecorder({ meterLevel: false }));

    await act(async () => {
      expect(await result.current.start()).toBeNull();
    });

    expect(FakeMediaRecorder.instances[0]?.requestedMimeType).toBeNull();
    expect(result.current.isRecording).toBe(true);

    const outcome: MicOutcome = await act(async () => result.current.stop());

    expect(outcome.recording?.blob.size).toBeGreaterThan(0);
    expect(tracks[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it('считает уровень входного сигнала во время записи', async () => {
    const { result } = renderHook(() => useMicRecorder());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.level).toBe(0);
    expect(frames).toHaveLength(1);

    act(() => {
      frames.shift()?.(0);
    });

    // Индикатор показывает, что микрофон действительно слышит ученика.
    expect(result.current.level).toBeGreaterThan(0);

    await act(async () => {
      await result.current.stop();
    });

    expect(result.current.level).toBe(0);
  });

  it('отказ `MediaRecorder` отпускает микрофон и объясняется отдельной причиной', async () => {
    const { result } = renderHook(() => useMicRecorder({ meterLevel: false }));

    await act(async () => {
      await result.current.start();
    });

    act(() => {
      FakeMediaRecorder.instances[0]?.onerror?.(new Event('error'));
    });

    expect(result.current.failure?.kind).toBe('recorder_failed');
    expect(result.current.status).toBe('error');
    // Без `track.stop()` индикатор записи в браузере горел бы и после отказа.
    expect(tracks[0]?.stop).toHaveBeenCalledTimes(1);
  });
});
