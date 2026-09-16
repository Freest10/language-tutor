/**
 * Перекодирование записи в WAV 16 кГц моно — формат, который принимает
 * встроенный в десктопную сборку распознаватель.
 *
 * Зачем это нужно: `MediaRecorder` пишет Opus в webm, а whisper.cpp декодирует
 * звук библиотекой miniaudio, знающей WAV, MP3 и FLAC. Распаковать Opus некому,
 * и единственное место, где нужный кодек точно есть, — сам браузер: он этот
 * Opus и создал. Поэтому запись распаковывается через Web Audio и собирается
 * заново несжатым PCM.
 *
 * Работа идёт только тогда, когда сервер об этом просит (`stt.requiresWav16`
 * из `GET /api/config`): WAV примерно в десять раз тяжелее Opus, и облачному
 * распознавателю, который умеет распаковывать сам, это была бы лишняя трата.
 *
 * Допущение A10: запись не сохраняется — обе версии живут в памяти до ответа
 * распознавателя и тут же забываются.
 */

/** Частота дискретизации, на которой работает whisper: перекодируем ровно в неё. */
export const WAV16_SAMPLE_RATE = 16_000;

/** MIME-тип получившейся записи; он же уходит в `POST /api/voice/stt`. */
export const WAV16_MIME_TYPE = 'audio/wav';

/** Имя файловой части с перекодированной записью. */
export const WAV16_FILENAME = 'speech.wav';

/** Размер заголовка RIFF/WAVE для несжатого PCM, байты. */
const WAV_HEADER_BYTES = 44;

/** Код формата «несжатый PCM» в заголовке WAV. */
const WAV_FORMAT_PCM = 1;

/** Разрядность отсчёта: 16 бит — то, что ждёт распознаватель. */
const BITS_PER_SAMPLE = 16;

/**
 * Минимум того, что нужно от `AudioBuffer`.
 *
 * Свой тип, а не `AudioBuffer`, чтобы функции ниже можно было проверить без
 * Web Audio: в тестовой среде (jsdom) звукового движка нет вовсе.
 */
export interface PcmSource {
  numberOfChannels: number;
  /** Число отсчётов в канале. */
  length: number;
  sampleRate: number;
  getChannelData: (channel: number) => Float32Array;
}

/**
 * Сводит каналы в один усреднением.
 *
 * Стерео с микрофона — это один и тот же голос в двух каналах; распознаватель
 * работает с моно, и среднее сохраняет громкость, тогда как выбор одного канала
 * терял бы её на записях, где микрофон пишет в другой.
 */
export function downmixToMono(source: PcmSource): Float32Array {
  if (source.numberOfChannels === 1) {
    return source.getChannelData(0);
  }

  const mixed = new Float32Array(source.length);

  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    const samples = source.getChannelData(channel);

    for (let index = 0; index < mixed.length; index += 1) {
      mixed[index] = (mixed[index] ?? 0) + (samples[index] ?? 0);
    }
  }

  for (let index = 0; index < mixed.length; index += 1) {
    mixed[index] = (mixed[index] ?? 0) / source.numberOfChannels;
  }

  return mixed;
}

/**
 * Меняет частоту дискретизации линейной интерполяцией.
 *
 * Запасной путь на случай, если `OfflineAudioContext` недоступен или отказал:
 * его ресемплер лучше (линейная интерполяция при понижении частоты даёт
 * искажения на высоких частотах), но речь он разбирает и так, а молчащий
 * микрофон хуже, чем чуть менее чистая запись.
 */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) {
    return samples;
  }

  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const resampled = new Float32Array(length);

  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;

    resampled[index] = (samples[left] ?? 0) * (1 - weight) + (samples[right] ?? 0) * weight;
  }

  return resampled;
}

/** Переводит отсчёт из диапазона −1…1 в 16-битное целое со знаком. */
function toPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));

  // Диапазон 16-битного целого несимметричен: −32768…32767.
  return Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
}

/** Собирает WAV-файл из отсчётов одного канала. */
export function encodeWavMono(samples: Float32Array, sampleRate: number = WAV16_SAMPLE_RATE): Blob {
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(8, 'WAVE');

  writeAscii(12, 'fmt ');
  // Длина блока fmt для несжатого PCM.
  view.setUint32(16, 16, true);
  view.setUint16(20, WAV_FORMAT_PCM, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  // Байт в секунду и выравнивание блока: для моно это один отсчёт.
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);

  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(WAV_HEADER_BYTES + index * bytesPerSample, toPcm16(samples[index] ?? 0), true);
  }

  return new Blob([buffer], { type: WAV16_MIME_TYPE });
}

/** Конструктор `AudioContext` с учётом префикса Safari; `null` — Web Audio нет. */
function audioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const prefixed = (window as unknown as { webkitAudioContext?: typeof AudioContext })
    .webkitAudioContext;

  return window.AudioContext ?? prefixed ?? null;
}

/** Конструктор `OfflineAudioContext` с учётом префикса Safari. */
function offlineAudioContextConstructor(): typeof OfflineAudioContext | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const prefixed = (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
    .webkitOfflineAudioContext;

  return window.OfflineAudioContext ?? prefixed ?? null;
}

/** Распаковывает запись в отсчёты. Контекст закрывается при любом исходе. */
async function decodeRecording(blob: Blob): Promise<AudioBuffer> {
  const AudioContextCtor = audioContextConstructor();

  if (AudioContextCtor === null) {
    throw new Error('Web Audio недоступен: перекодировать запись нечем');
  }

  const context = new AudioContextCtor();

  try {
    return await context.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void context.close().catch(() => undefined);
  }
}

/**
 * Приводит запись к 16 кГц моно ресемплером браузера.
 * `null` — `OfflineAudioContext` недоступен или отказал; считать сами.
 */
async function renderTo16k(buffer: AudioBuffer): Promise<Float32Array | null> {
  const OfflineCtor = offlineAudioContextConstructor();

  if (OfflineCtor === null) {
    return null;
  }

  const frames = Math.max(1, Math.ceil(buffer.duration * WAV16_SAMPLE_RATE));

  try {
    const offline = new OfflineCtor(1, frames, WAV16_SAMPLE_RATE);
    const source = offline.createBufferSource();

    source.buffer = buffer;
    // Каналы сводит сам граф: у назначения он один.
    source.connect(offline.destination);
    source.start();

    return (await offline.startRendering()).getChannelData(0);
  } catch {
    return null;
  }
}

/**
 * Перекодирует запись микрофона в WAV 16 кГц моно.
 *
 * @param blob запись как её отдал `MediaRecorder`.
 * @returns новый blob с типом `audio/wav`.
 * @throws если браузер не смог распаковать собственную запись — повторять
 *   попытку бессмысленно, вызывающий код предлагает набрать текст.
 */
export async function toWav16Mono(blob: Blob): Promise<Blob> {
  const buffer = await decodeRecording(blob);
  const rendered = await renderTo16k(buffer);
  const samples =
    rendered ?? resampleLinear(downmixToMono(buffer), buffer.sampleRate, WAV16_SAMPLE_RATE);

  if (samples.length === 0) {
    throw new Error('Запись распаковалась в ноль отсчётов');
  }

  return encodeWavMono(samples, WAV16_SAMPLE_RATE);
}
