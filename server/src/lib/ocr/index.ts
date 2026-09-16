/**
 * Выбор локального распознавателя текста.
 *
 * Бэкенды перебираются в фиксированном порядке и берётся первый доступный:
 * macOS Vision идёт первым, потому что на машине пользователя (macOS) он уже
 * есть и работает быстрее, а `tesseract` требует отдельной установки.
 *
 * Ни одного доступного бэкенда — это нормальное состояние (Linux без tesseract):
 * вызывающий код обязан показать человеку, чего не хватает, а не упасть.
 */
import { macosVisionBackend } from './macosVision.js';
import { tesseractBackend } from './tesseract.js';
import type { OcrBackend } from './types.js';

export { macosVisionBackend } from './macosVision.js';
export { tesseractBackend, toTesseractLanguages } from './tesseract.js';
export type { OcrBackend } from './types.js';

/** Бэкенды в порядке предпочтения. */
export const OCR_BACKENDS: readonly OcrBackend[] = [macosVisionBackend, tesseractBackend];

/** Подменённый бэкенд; `undefined` — выбирать из доступных. */
let override: OcrBackend | undefined;

/** Подменяет бэкенд распознавания (тесты) — по образцу `setUploadDir()`. */
export function setOcrBackend(backend: OcrBackend | undefined): void {
  override = backend;
}

/** Первый доступный бэкенд; `undefined` — распознавать нечем. */
export async function detectOcrBackend(): Promise<OcrBackend | undefined> {
  if (override !== undefined) {
    return (await override.isAvailable()) ? override : undefined;
  }

  for (const backend of OCR_BACKENDS) {
    if (await backend.isAvailable()) {
      return backend;
    }
  }

  return undefined;
}
