/**
 * Сборка WAV 16 кГц моно для встроенного распознавателя.
 *
 * Проверяется то, что не зависит от Web Audio: заголовок файла, сведение
 * каналов и смена частоты дискретизации. Самой распаковки записи (`toWav16Mono`)
 * здесь нет — звукового движка в jsdom не существует, а подделывать декодер
 * Opus смысла не имеет: проверялась бы подделка.
 */
import { describe, expect, it } from 'vitest';

import {
  downmixToMono,
  encodeWavMono,
  resampleLinear,
  WAV16_MIME_TYPE,
  WAV16_SAMPLE_RATE,
  type PcmSource,
} from '../src/features/voice/wav16';

/** Читает заголовок получившегося файла. */
async function headerOf(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

/** Строка из четырёх ASCII-символов по смещению. */
function ascii(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** Подделка `AudioBuffer`: столько, сколько нужно функциям сведения каналов. */
function pcmSource(channels: Float32Array[], sampleRate = 48_000): PcmSource {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    sampleRate,
    getChannelData: (channel: number) => channels[channel] ?? new Float32Array(),
  };
}

describe('encodeWavMono', () => {
  it('пишет заголовок несжатого PCM с заданной частотой', async () => {
    const blob = encodeWavMono(new Float32Array([0, 0.5, -0.5, 1]), WAV16_SAMPLE_RATE);

    expect(blob.type).toBe(WAV16_MIME_TYPE);

    const view = await headerOf(blob);

    expect(ascii(view, 0)).toBe('RIFF');
    expect(ascii(view, 8)).toBe('WAVE');
    expect(ascii(view, 12)).toBe('fmt ');
    expect(ascii(view, 36)).toBe('data');
    // Формат 1 — PCM, один канал, 16 бит.
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(24, true)).toBe(WAV16_SAMPLE_RATE);
    // Байт в секунду = частота × два байта на отсчёт.
    expect(view.getUint32(28, true)).toBe(WAV16_SAMPLE_RATE * 2);
    // Размеры: данные — по два байта на отсчёт, RIFF — они же плюс заголовок.
    expect(view.getUint32(40, true)).toBe(8);
    expect(view.getUint32(4, true)).toBe(44 - 8 + 8);
    expect(blob.size).toBe(44 + 8);
  });

  it('переводит отсчёты в 16-битные целые и не даёт им переполниться', async () => {
    // Значения за пределами −1…1 приходят от усиления на стороне браузера:
    // без ограничения они завернулись бы в противоположный знак и дали треск.
    const blob = encodeWavMono(new Float32Array([0, 1, -1, 2, -2]), WAV16_SAMPLE_RATE);
    const view = await headerOf(blob);

    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32_767);
    expect(view.getInt16(48, true)).toBe(-32_768);
    expect(view.getInt16(50, true)).toBe(32_767);
    expect(view.getInt16(52, true)).toBe(-32_768);
  });

  it('делает пустой, но валидный файл из пустой записи', async () => {
    const blob = encodeWavMono(new Float32Array(), WAV16_SAMPLE_RATE);
    const view = await headerOf(blob);

    expect(blob.size).toBe(44);
    expect(view.getUint32(40, true)).toBe(0);
  });
});

describe('downmixToMono', () => {
  it('отдаёт канал как есть, если он один', () => {
    const mono = new Float32Array([0.1, 0.2]);

    expect(downmixToMono(pcmSource([mono]))).toBe(mono);
  });

  it('усредняет каналы, а не берёт первый', () => {
    // Микрофон может писать голос во второй канал: выбор первого дал бы тишину.
    const left = new Float32Array([1, 0, 0.5]);
    const right = new Float32Array([0, 1, -0.5]);

    expect([...downmixToMono(pcmSource([left, right]))]).toEqual([0.5, 0.5, 0]);
  });
});

describe('resampleLinear', () => {
  it('не трогает отсчёты, если частота уже нужная', () => {
    const samples = new Float32Array([0.1, 0.2, 0.3]);

    expect(resampleLinear(samples, WAV16_SAMPLE_RATE, WAV16_SAMPLE_RATE)).toBe(samples);
  });

  it('понижает частоту кратно длительности записи', () => {
    const samples = new Float32Array(48_000);

    expect(resampleLinear(samples, 48_000, WAV16_SAMPLE_RATE)).toHaveLength(WAV16_SAMPLE_RATE);
  });

  it('интерполирует между соседними отсчётами', () => {
    // 4 отсчёта на 4 кГц → 2 отсчёта на 2 кГц: берутся нулевой и второй.
    const resampled = resampleLinear(new Float32Array([0, 1, 2, 3]), 4000, 2000);

    expect([...resampled]).toEqual([0, 2]);
  });

  it('не выходит за последний отсчёт', () => {
    const resampled = resampleLinear(new Float32Array([0, 1]), 3000, 2000);

    expect(resampled.every((value) => Number.isFinite(value))).toBe(true);
  });
});
