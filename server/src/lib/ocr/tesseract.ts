/**
 * Распознавание текста утилитой `tesseract`.
 *
 * Запасной бэкенд для машин без macOS Vision: ставится одной командой пакетного
 * менеджера вместе с языковыми моделями (`tesseract-lang`). Качество ниже, чем у
 * Vision, но это единственный способ распознать скан на Linux без внешних служб.
 *
 * Коды языков у tesseract свои — трёхбуквенные ISO 639-2 (`eng`, `rus`), поэтому
 * коды BCP-47 из конфигурации переводятся таблицей: неизвестные молча
 * отбрасываются, и если не осталось ни одного, берётся `eng`.
 */
import { isCommandAvailable, runCommand } from '../exec.js';

import type { OcrBackend } from './types.js';

/** Имя утилиты. */
const TESSERACT_COMMAND = 'tesseract';

/** Таймаут распознавания одной страницы, мс. */
const RECOGNIZE_TIMEOUT_MS = 180_000;

/** Язык, которым распознаём, если ни один код не удалось перевести. */
const FALLBACK_LANGUAGE = 'eng';

/** Перевод кодов языка BCP-47 в трёхбуквенные коды tesseract. */
const TESSERACT_LANGUAGES: Record<string, string | undefined> = {
  ar: 'ara',
  cs: 'ces',
  da: 'dan',
  de: 'deu',
  el: 'ell',
  en: 'eng',
  es: 'spa',
  fi: 'fin',
  fr: 'fra',
  he: 'heb',
  hi: 'hin',
  hu: 'hun',
  it: 'ita',
  ja: 'jpn',
  ko: 'kor',
  nl: 'nld',
  no: 'nor',
  pl: 'pol',
  pt: 'por',
  ro: 'ron',
  ru: 'rus',
  sv: 'swe',
  tr: 'tur',
  uk: 'ukr',
  vi: 'vie',
  zh: 'chi_sim',
};

/** Переводит коды BCP-47 в аргумент `-l` утилиты: `en-US,ru-RU` → `eng+rus`. */
export function toTesseractLanguages(langs: readonly string[]): string {
  const codes = langs
    .map((lang) => TESSERACT_LANGUAGES[lang.split('-', 1)[0]?.toLowerCase() ?? ''])
    .filter((code): code is string => code !== undefined);

  return codes.length === 0 ? FALLBACK_LANGUAGE : [...new Set(codes)].join('+');
}

/** Распознавание утилитой `tesseract`; доступно везде, где она есть в PATH. */
export const tesseractBackend: OcrBackend = {
  name: 'tesseract',

  isAvailable(): Promise<boolean> {
    return isCommandAvailable(TESSERACT_COMMAND, ['--version']);
  },

  async recognize(imagePath: string, langs: readonly string[]): Promise<string> {
    const { stdout } = await runCommand(
      TESSERACT_COMMAND,
      [imagePath, 'stdout', '-l', toTesseractLanguages(langs)],
      { timeoutMs: RECOGNIZE_TIMEOUT_MS },
    );

    return stdout;
  },
};
