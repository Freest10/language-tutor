/**
 * Распознавание PDF без текстового слоя: скан учебника превращается в обычный
 * текст материала.
 *
 * Конвейер один на оба режима и всегда последовательный:
 * `pdftoppm` → PNG страницы → распознаватель → текст страницы → фрагменты.
 * Распознаватель зависит от `SCAN_MODE`:
 * - `ocr` — локальный бэкенд (macOS Vision или tesseract): ~0.3 с на страницу,
 *   только текст;
 * - `vision` — зрячая модель по HTTP: минуты на страницу, зато понимает вёрстку,
 *   таблицы и описывает иллюстрации словами.
 *
 * Страницы обрабатываются ПО ОДНОЙ намеренно: и Vision, и локальная модель
 * упираются в те же ядра, поэтому параллельный проход не ускоряет работу, а лишь
 * умножает пиковую память на число потоков.
 *
 * Все предвидимые неудачи — это `TextExtractionError` с машиночитаемым статусом,
 * как и у обычного извлечения: вызывающий сервис сохраняет материал с этим
 * статусом и понятным сообщением, а не отдаёт ошибку HTTP.
 */
import { readFile } from 'node:fs/promises';

import { env, type ScanMode } from '../config/env.js';
import { buildPageScanMessages } from '../prompts/pageScan.js';
import { llmCapability, resolveLlmProvider } from '../providers/factory.js';
import { isProviderError, type LlmProvider } from '../providers/types.js';

import { isAppError } from './httpErrors.js';
import { detectOcrBackend, type OcrBackend } from './ocr/index.js';
import { isRasterizerAvailable, withRasterizedPdf, type RasterizedPage } from './pdfRaster.js';
import {
  ensureWithinTextLimit,
  normalizeText,
  TextExtractionError,
  type ExtractedPage,
  type ExtractedText,
} from './textExtraction.js';

/** Настройки распознавания: значения по умолчанию берутся из окружения. */
export interface ScanSettings {
  /** Режим обработки скана. */
  mode: ScanMode;
  /** Разрешение растеризации, точек на дюйм. */
  dpi: number;
  /** Сколько первых страниц обрабатывается. */
  maxPages: number;
  /** Языки локального распознавания, коды BCP-47. */
  langs: string[];
  /** Модель режима `vision`. */
  visionModel: string;
}

/** Настройки из окружения: с ними работает приложение, если их не подменили. */
function settingsFromEnv(): ScanSettings {
  return {
    mode: env.scanMode,
    dpi: env.scanDpi,
    maxPages: env.scanMaxPages,
    langs: [...env.scanOcrLangs],
    visionModel: env.scanVisionModel,
  };
}

let settings: ScanSettings = settingsFromEnv();

/** Действующие настройки распознавания. */
export function getScanSettings(): ScanSettings {
  return { ...settings, langs: [...settings.langs] };
}

/**
 * Подменяет настройки распознавания (тесты) — по образцу `setUploadDir()`.
 * Заданы только перечисленные поля, остальные остаются прежними.
 */
export function setScanSettings(patch: Partial<ScanSettings>): void {
  settings = { ...settings, ...patch };
}

/** Возвращает настройки распознавания к значениям из окружения (тесты). */
export function resetScanSettings(): void {
  settings = settingsFromEnv();
}

/**
 * Подсказка про модель со зрением.
 *
 * Текстовая модель на запрос с картинкой отвечает ошибкой или выдумывает текст,
 * поэтому в каждом сообщении о неудаче режима `vision` называется конкретная
 * команда: искать подходящий тег пользователь не обязан.
 */
const VISION_MODEL_HINT =
  'Режиму vision нужна модель со зрением: «ollama pull qwen3-vl:8b-instruct» ' +
  '(~6 ГБ) и SCAN_VISION_MODEL=qwen3-vl:8b-instruct в .env.';

/** Готовность распознавания: `reason` объясняет человеку, чего не хватает. */
export interface ScanAvailability {
  available: boolean;
  /** Почему распознавание невозможно; `null` — возможно. */
  reason: string | null;
  /** Чем распознаём: имя OCR-бэкенда или модели; `null` — нечем. */
  engine: string | null;
}

/** Готовность распознавания: режим, растеризатор и распознаватель. */
export async function checkScanAvailability(): Promise<ScanAvailability> {
  if (settings.mode === 'off') {
    return {
      available: false,
      reason:
        'Распознавание сканов выключено (SCAN_MODE=off). Включите его в .env: ' +
        'SCAN_MODE=ocr — быстрое локальное распознавание текста, ' +
        'SCAN_MODE=vision — медленное распознавание зрячей моделью с описанием иллюстраций.',
      engine: null,
    };
  }

  if (!(await isRasterizerAvailable())) {
    return {
      available: false,
      reason:
        'Для распознавания скана нужна утилита pdftoppm из пакета poppler: ' +
        'на macOS «brew install poppler», на Debian/Ubuntu «apt install poppler-utils».',
      engine: null,
    };
  }

  if (settings.mode === 'vision') {
    const capability = llmCapability();

    return capability.available
      ? { available: true, reason: null, engine: settings.visionModel }
      : {
          available: false,
          reason:
            'Режим SCAN_MODE=vision требует настроенной языковой модели: ' +
            `${capability.reason ?? 'проверьте LLM_BASE_URL и LLM_MODEL'}. ${VISION_MODEL_HINT}`,
          engine: null,
        };
  }

  const backend = await detectOcrBackend();

  if (backend === undefined) {
    return {
      available: false,
      reason:
        'На этой машине нет ни одного распознавателя текста: macOS Vision доступен ' +
        'только на macOS с установленным swiftc (Xcode Command Line Tools), ' +
        'а tesseract не найден в PATH («brew install tesseract tesseract-lang» ' +
        'или «apt install tesseract-ocr»).',
      engine: null,
    };
  }

  return { available: true, reason: null, engine: backend.name };
}

/** Ход распознавания: по нему обновляется `statusMessage` материала. */
export interface ScanProgress {
  /** Номер обрабатываемой страницы в документе. */
  page: number;
  /** Сколько страниц будет обработано. */
  total: number;
}

/** Параметры распознавания файла. */
export interface ScanPdfOptions {
  /** Число страниц в документе, если оно уже известно из разбора PDF. */
  pageCount?: number | undefined;
  /** Вызывается перед каждой страницей: показывает прогресс пользователю. */
  onProgress?: ((progress: ScanProgress) => void) | undefined;
  /** Отмена извне. */
  signal?: AbortSignal | undefined;
}

/** Результат распознавания скана. */
export interface ScanPdfResult extends ExtractedText {
  /** Сколько страниц обработано (не больше `SCAN_MAX_PAGES`). */
  processedPages: number;
  /** `true` — документ длиннее предела, обработаны только первые страницы. */
  truncated: boolean;
  /** Чем распознавали: имя OCR-бэкенда или модели. */
  engine: string;
}

/** Распознаватель одной страницы: скрывает разницу между OCR и зрячей моделью. */
interface PageRecognizer {
  /** Имя для `statusMessage` и логов. */
  name: string;
  recognize(page: RasterizedPage, total: number): Promise<string>;
}

/** Ограничители markdown, которыми модели любят обрамлять ответ. */
const FENCE_PATTERN = /^```[a-z]*\n([\s\S]*?)\n?```$/iu;

/** Снимает обрамляющий ```-блок: он относится к оформлению ответа, а не к странице. */
function stripCodeFence(text: string): string {
  const match = FENCE_PATTERN.exec(text.trim());

  return match?.[1] ?? text;
}

/** Локальное распознавание: бэкенд уже выбран `detectOcrBackend()`. */
function ocrRecognizer(backend: OcrBackend, langs: readonly string[]): PageRecognizer {
  return {
    name: backend.name,
    async recognize(page: RasterizedPage): Promise<string> {
      try {
        return await backend.recognize(page.path, langs);
      } catch (error) {
        throw new TextExtractionError(
          'error_extraction_failed',
          `Распознаватель ${backend.name} не смог обработать страницу ${String(page.page)}`,
          { cause: error },
        );
      }
    },
  };
}

/**
 * Провайдер для режима `vision`: ненастроенная модель — это статус материала,
 * а не 501 в ответе (загрузка файла уже прошла, пользователь ждёт результат).
 */
function createVisionProvider(): LlmProvider {
  try {
    return resolveLlmProvider();
  } catch (error) {
    throw new TextExtractionError(
      'error_extraction_failed',
      isAppError(error)
        ? `Режим распознавания vision недоступен: ${error.message}. ${VISION_MODEL_HINT}`
        : `Режим распознавания vision недоступен: модель не настроена. ${VISION_MODEL_HINT}`,
      { cause: error },
    );
  }
}

/**
 * Распознавание зрячей моделью: страница уходит `data:`-URL внутри запроса.
 *
 * Провайдер собирается один раз на документ, а не на страницу: иначе каждая
 * страница заново проверяла бы конфигурацию и создавала HTTP-клиент.
 */
function visionRecognizer(model: string): PageRecognizer {
  const provider = createVisionProvider();

  return {
    name: model,
    async recognize(page: RasterizedPage, total: number): Promise<string> {
      const image = await readFile(page.path);
      const messages = buildPageScanMessages({
        page: page.page,
        total,
        imageDataUrl: `data:image/png;base64,${image.toString('base64')}`,
      });

      try {
        const result = await provider.chat({ messages, model });

        return stripCodeFence(result.text);
      } catch (error) {
        throw new TextExtractionError(
          'error_extraction_failed',
          (isProviderError(error)
            ? `Модель ${model} не обработала страницу ${String(page.page)}: ${error.message}. `
            : `Не удалось распознать страницу ${String(page.page)} моделью ${model}. `) +
            VISION_MODEL_HINT,
          { cause: error },
        );
      }
    },
  };
}

/** Собирает распознаватель под текущий режим. */
async function createRecognizer(): Promise<PageRecognizer> {
  if (settings.mode === 'vision') {
    return visionRecognizer(settings.visionModel);
  }

  const backend = await detectOcrBackend();

  if (backend === undefined) {
    throw new TextExtractionError(
      'error_no_text_layer',
      'Распознавание текста на этой машине недоступно: не найден ни macOS Vision, ни tesseract',
    );
  }

  return ocrRecognizer(backend, settings.langs);
}

/**
 * Распознаёт PDF без текстового слоя постранично.
 *
 * Бросает `TextExtractionError`:
 * - `error_no_text_layer` — распознавание недоступно либо текста на страницах нет;
 * - `error_too_large` — распознанный текст не помещается в `MAX_MATERIAL_TEXT_CHARS`;
 * - `error_extraction_failed` — не удалось растеризовать или распознать страницы.
 */
export async function scanPdfPages(
  filePath: string,
  options: ScanPdfOptions = {},
): Promise<ScanPdfResult> {
  const availability = await checkScanAvailability();

  if (!availability.available) {
    throw new TextExtractionError(
      'error_no_text_layer',
      availability.reason ?? 'Распознавание сканов недоступно',
    );
  }

  const recognizer = await createRecognizer();

  return withRasterizedPdf(
    filePath,
    { dpi: settings.dpi, maxPages: settings.maxPages, signal: options.signal },
    async (rendered) => recognizePages(rendered, recognizer, options),
  ).catch((error: unknown) => {
    if (error instanceof TextExtractionError) {
      throw error;
    }

    throw new TextExtractionError(
      'error_extraction_failed',
      'Не удалось растеризовать страницы PDF для распознавания',
      { cause: error },
    );
  });
}

/** Проходит по растеризованным страницам одну за другой и собирает текст. */
async function recognizePages(
  rendered: RasterizedPage[],
  recognizer: PageRecognizer,
  options: ScanPdfOptions,
): Promise<ScanPdfResult> {
  if (rendered.length === 0) {
    throw new TextExtractionError(
      'error_extraction_failed',
      'Не удалось получить ни одной страницы PDF: файл повреждён или зашифрован',
    );
  }

  const total = rendered.length;
  const pages: ExtractedPage[] = [];

  for (const page of rendered) {
    options.signal?.throwIfAborted();
    options.onProgress?.({ page: page.page, total });

    const text = normalizeText(await recognizer.recognize(page, total));

    if (text.length > 0) {
      pages.push({ page: page.page, text });
    }
  }

  if (pages.length === 0) {
    throw new TextExtractionError(
      'error_no_text_layer',
      `Распознавание (${recognizer.name}) не нашло на страницах текста: ` +
        'страницы пустые или качество скана слишком низкое. Попробуйте поднять SCAN_DPI, ' +
        'режим SCAN_MODE=vision или загрузите PDF с текстовым слоем.',
    );
  }

  const text = normalizeText(pages.map((page) => page.text).join('\n\n'));

  ensureWithinTextLimit(text);

  const pageCount = Math.max(options.pageCount ?? total, total);

  return {
    text,
    pages,
    pageCount,
    processedPages: total,
    truncated: pageCount > total,
    engine: recognizer.name,
  };
}
