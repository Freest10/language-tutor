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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import { CapabilitiesProvider } from '../src/context/CapabilitiesProvider';
import { PushToTalkButton } from '../src/features/voice/PushToTalkButton';
import { useTextToSpeech } from '../src/features/voice/useTextToSpeech';
import { useVoiceInput, type VoiceInputResult } from '../src/features/voice/useVoiceInput';
import { i18n } from '../src/i18n';
import { I18nProvider } from '../src/i18n/I18nProvider';

/** Конфигурация сервера с нужными провайдерами голоса. */
function configFixture(stt: VoiceProvider, tts: VoiceProvider): AppConfig {
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
      maxTtsTextLength: 4_000,
      maxPageSize: 100,
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

  constructor(
    public stream: MediaStream,
    options?: MediaRecorderOptions,
  ) {
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

  paused = false;

  playCalls = 0;

  onended: (() => void) | null = null;

  onerror: (() => void) | null = null;

  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }

  play(): Promise<void> {
    this.playCalls += 1;

    return Promise.resolve();
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
      <p data-testid="tts-status">{tts.status}</p>
      <p data-testid="tts-queue">{tts.queueLength}</p>
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

    await waitFor(() => {
      expect(screen.getByTestId('tts-status')).toHaveTextContent('idle');
    });

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

    await waitFor(() => {
      expect(screen.getByTestId('tts-status')).toHaveTextContent('idle');
    });

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
