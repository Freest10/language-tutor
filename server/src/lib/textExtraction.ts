/**
 * Извлечение текста из загруженного файла материала.
 *
 * Поддерживаются только форматы из `MATERIAL_SUPPORTED_MIME_TYPES`: `txt`/`md`
 * читаются как UTF-8, `pdf` разбирается библиотекой `pdf-parse` (pdf.js).
 * Распознавание изображений (OCR) в объём приложения не входит (A16): PDF-скан
 * без текстового слоя — это не сбой, а материал со статусом `error_no_text_layer`
 * и человекочитаемым пояснением.
 *
 * Все предвидимые неудачи — это `TextExtractionError` с машиночитаемым статусом
 * из `MATERIAL_ERROR_STATUSES`; вызывающий сервис сохраняет материал с этим
 * статусом, а не отдаёт пользователю ошибку HTTP.
 */
import { PDFParse } from 'pdf-parse';

import { type MaterialErrorStatus } from '@lt/shared';

import { env } from '../config/env.js';

/** Страница PDF с извлечённым текстом. */
export interface ExtractedPage {
  /** Номер страницы с единицы. */
  page: number;
  text: string;
}

/** Результат извлечения текста из файла. */
export interface ExtractedText {
  /** Весь текст материала: страницы склеены пустой строкой. */
  text: string;
  /** Постраничная разбивка; для текстовых файлов — одна запись без номера страницы. */
  pages: ExtractedPage[];
  /** Число страниц PDF; `null` — формат без страниц. */
  pageCount: number | null;
}

/** Предвидимая неудача извлечения: несёт статус, с которым сохраняется материал. */
export class TextExtractionError extends Error {
  /** Статус материала, соответствующий причине неудачи. */
  readonly status: MaterialErrorStatus;

  constructor(status: MaterialErrorStatus, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TextExtractionError';
    this.status = status;
  }
}

/** Проверяет, что ошибка — предвидимая неудача извлечения. */
export function isTextExtractionError(error: unknown): error is TextExtractionError {
  return error instanceof TextExtractionError;
}

/** Формат загруженного файла: `text` (вставленный текст) файлом не бывает. */
export type ExtractableFormat = 'pdf' | 'txt';

/**
 * Приводит текст к виду, пригодному для хранения и разбиения: единые переводы
 * строк, без BOM и управляющих символов, без хвостовых пробелов в строках
 * и без цепочек пустых строк.
 */
export function normalizeText(raw: string): string {
  return stripControlCharacters(raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'))
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Убирает управляющие символы, сохраняя перевод строки и табуляцию. */
function stripControlCharacters(text: string): string {
  const kept: string[] = [];

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || code === 0x7f;

    if (!isControl || character === '\n' || character === '\t') {
      kept.push(character);
    }
  }

  return kept.join('');
}

/** Читает текстовый файл (`txt`, `md`) как UTF-8. */
export function extractPlainText(data: Buffer): ExtractedText {
  const text = normalizeText(data.toString('utf8'));

  if (text.length === 0) {
    throw new TextExtractionError('error_extraction_failed', 'Файл не содержит текста');
  }

  ensureWithinTextLimit(text);

  return { text, pages: [{ page: 1, text }], pageCount: null };
}

/**
 * Извлекает текстовый слой PDF постранично.
 *
 * Пустой результат означает скан: пиксели без текста pdf.js вернуть не может,
 * а OCR не поддерживается — такой материал получает `error_no_text_layer`.
 */
export async function extractPdfText(data: Buffer): Promise<ExtractedText> {
  const parser = new PDFParse({ data: new Uint8Array(data) });

  try {
    const result = await parser.getText();
    const pages = result.pages
      .map((page) => ({ page: page.num, text: normalizeText(page.text) }))
      .filter((page) => page.text.length > 0);

    if (pages.length === 0) {
      throw new TextExtractionError(
        'error_no_text_layer',
        'В PDF нет текстового слоя: похоже, это скан. Распознавание текста на изображениях ' +
          'не поддерживается — загрузите PDF с текстом или вставьте текст вручную.',
      );
    }

    const text = normalizeText(pages.map((page) => page.text).join('\n\n'));

    ensureWithinTextLimit(text);

    return { text, pages, pageCount: result.total };
  } catch (error) {
    if (isTextExtractionError(error)) {
      throw error;
    }

    throw new TextExtractionError(
      'error_extraction_failed',
      'Не удалось разобрать PDF: файл повреждён, зашифрован или не является PDF',
      { cause: error },
    );
  } finally {
    await parser.destroy();
  }
}

/** Извлекает текст из файла в зависимости от его формата. */
export async function extractText(data: Buffer, format: ExtractableFormat): Promise<ExtractedText> {
  return format === 'pdf' ? extractPdfText(data) : extractPlainText(data);
}

/**
 * Проверяет, что извлечённый текст помещается в действующий предел.
 *
 * Предел берётся из `MAX_MATERIAL_TEXT_CHARS`, а не из константы контракта:
 * константа описывает лимит вставленного вручную текста (поле формы), а книга
 * в PDF весит немного, но разворачивается в миллионы символов. Ограничение
 * защищает память и время чанкинга; на размер промпта оно не влияет — туда
 * уходит только отобранная под бюджет выборка фрагментов.
 */
export function ensureWithinTextLimit(text: string, limit = env.maxMaterialTextChars): void {
  if (text.length > limit) {
    throw new TextExtractionError(
      'error_too_large',
      `Текст материала — ${text.length} символов, это больше предела ` +
        `в ${limit} символов. Разделите материал на части или поднимите ` +
        'MAX_MATERIAL_TEXT_CHARS в .env.',
    );
  }
}
