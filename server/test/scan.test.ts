/**
 * Распознавание PDF без текстового слоя: конфигурация, растеризация, оба режима
 * (`ocr` и `vision`), фоновая обработка и все виды отказов.
 *
 * Фикстура `fixtures/scan.pdf` — настоящий скан: PDF с текстом растеризован
 * `pdftoppm -r 150`, страницы собраны обратно в PDF (`magick … -compress Group4`),
 * поэтому текстового слоя в нём нет вовсе, а на страницах напечатаны известные
 * фразы (`SCANNED PAGE ONE` и далее).
 *
 * Сеть в тестах запрещена (`test/setup/noNetwork.ts`): режим `vision` проверяется
 * на подменённом `fetch`, локальный OCR — на подменённом бэкенде, и отдельно —
 * на настоящем, если он есть на машине.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_PREFIX,
  createMaterialResponseSchema,
  MATERIAL_FILE_FIELD_NAME,
  type Material,
} from '@lt/shared';

import { buildApp } from '../src/app.js';
import { EnvValidationError, parseEnv } from '../src/config/env.js';
import { getDb, IN_MEMORY_DB_PATH, openDatabase, setDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { setOcrBackend, toTesseractLanguages, type OcrBackend } from '../src/lib/ocr/index.js';
import { setOcrCacheDir } from '../src/lib/ocr/macosVision.js';
import {
  getRasterizerCommand,
  isRasterizerAvailable,
  setRasterizerCommand,
  withRasterizedPdf,
} from '../src/lib/pdfRaster.js';
import {
  checkScanAvailability,
  resetScanSettings,
  scanPdfPages,
  setScanSettings,
} from '../src/lib/scanExtraction.js';
import { createLlmProvider } from '../src/providers/llmProvider.js';
import { findMaterialById, insertMaterial } from '../src/repositories/materialRepository.js';
import {
  createMaterialFromFile,
  getMaterial,
  recoverStuckMaterials,
  setUploadDir,
  whenScansSettled,
} from '../src/services/materialService.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Сколько страниц в фикстуре скана. */
const SCAN_PAGES = 3;

/** Фраза, напечатанная на первой странице скана. */
const SCAN_MARKER = 'SCANNED PAGE ONE';

/** Имя заведомо несуществующей программы: им проверяются отказы. */
const MISSING_COMMAND = 'lt-no-such-binary';

/** Мок `fetch`: тип совпадает с тем, как его вызывают провайдеры. */
type FetchMock = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;

let app: FastifyInstance;
let uploadDir: string;
/** Есть ли на машине `pdftoppm`: без него растеризация невозможна в принципе. */
let rasterizerReady = false;

/** Читает фикстуру из `test/fixtures`. */
function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, name));
}

/** Бэкенд OCR-заглушка: не зависит ни от платформы, ни от установленных программ. */
function stubBackend(
  options: { available?: boolean; recognize?: (imagePath: string) => string } = {},
): OcrBackend {
  return {
    name: 'stub-ocr',
    isAvailable: () => Promise.resolve(options.available ?? true),
    recognize: (imagePath: string) =>
      Promise.resolve(options.recognize?.(imagePath) ?? `Распознанный текст ${imagePath}`),
  };
}

/** Ответ OpenAI-совместимого `/chat/completions`. */
function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      model: 'qwen3-vl:8b-instruct',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Тело запроса как объект. */
function requestBody(mock: FetchMock, index: number): Record<string, unknown> {
  const call = mock.mock.calls[index];

  if (call === undefined) {
    throw new Error(`fetch не вызывался ${index + 1}-й раз`);
  }

  return JSON.parse(String(call[1].body)) as Record<string, unknown>;
}

/** Загружает файл как материал (то же, что делает обработчик `POST /api/materials`). */
function uploadScan(name = 'scan.pdf'): Promise<Material> {
  return createMaterialFromFile({
    data: fixture(name),
    fileName: name,
    mimeType: 'application/pdf',
  });
}

/** Материал из базы; бросает, если его там нет. */
function reload(id: string): Material {
  const material = findMaterialById(id);

  if (material === undefined) {
    throw new Error(`Материал ${id} не найден`);
  }

  return material;
}

beforeAll(async () => {
  const db = openDatabase(IN_MEMORY_DB_PATH);

  migrate(db);
  setDb(db);

  uploadDir = mkdtempSync(join(tmpdir(), 'lt-scan-test-'));
  setUploadDir(uploadDir);
  // Собранный помощник OCR тоже не должен попадать в каталог данных приложения.
  setOcrCacheDir(join(uploadDir, 'bin'));

  app = await buildApp();
  await app.ready();

  rasterizerReady = await isRasterizerAvailable();
});

afterAll(async () => {
  await app.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

beforeEach(() => {
  setScanSettings({ mode: 'ocr', maxPages: 50, dpi: 150 });
  setOcrBackend(stubBackend());
});

afterEach(async () => {
  await whenScansSettled();
  vi.unstubAllGlobals();
  setOcrBackend(undefined);
  setRasterizerCommand('pdftoppm');
  resetScanSettings();
  getDb().exec('DELETE FROM materials');
});

describe('переменные окружения распознавания', () => {
  it('по умолчанию включает локальный OCR', () => {
    const env = parseEnv({});

    expect(env.scanMode).toBe('ocr');
    expect(env.scanDpi).toBe(150);
    expect(env.scanMaxPages).toBe(50);
    expect(env.scanOcrLangs).toEqual(['en-US', 'ru-RU']);
    // Зрячая модель отдельная от LLM_MODEL: текстовая модель страницу не прочитает.
    expect(env.scanVisionModel).toBe('qwen3-vl:8b-instruct');
  });

  it('принимает заданные значения и список языков через запятую', () => {
    const env = parseEnv({
      SCAN_MODE: 'vision',
      SCAN_DPI: '300',
      SCAN_MAX_PAGES: '4',
      SCAN_OCR_LANGS: ' de-DE , fr-FR ',
      SCAN_VISION_MODEL: 'qwen3-vl:32b-instruct',
    });

    expect(env.scanMode).toBe('vision');
    expect(env.scanDpi).toBe(300);
    expect(env.scanMaxPages).toBe(4);
    expect(env.scanOcrLangs).toEqual(['de-DE', 'fr-FR']);
    expect(env.scanVisionModel).toBe('qwen3-vl:32b-instruct');
  });

  it('отвергает значения вне допустимых границ', () => {
    expect(() => parseEnv({ SCAN_MODE: 'magic' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ SCAN_DPI: '10' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ SCAN_MAX_PAGES: '5000' })).toThrow(EnvValidationError);
  });
});

describe('коды языков tesseract', () => {
  it('переводит BCP-47 в трёхбуквенные коды', () => {
    expect(toTesseractLanguages(['en-US', 'ru-RU'])).toBe('eng+rus');
    expect(toTesseractLanguages(['de', 'de-AT'])).toBe('deu');
  });

  it('не оставляет распознавание без языка вовсе', () => {
    expect(toTesseractLanguages([])).toBe('eng');
    expect(toTesseractLanguages(['xx-YY'])).toBe('eng');
  });
});

describe('растеризация страниц', () => {
  it('отсутствие pdftoppm видно до начала работы', async () => {
    setRasterizerCommand(MISSING_COMMAND);

    expect(getRasterizerCommand()).toBe(MISSING_COMMAND);
    expect(await isRasterizerAvailable()).toBe(false);

    const availability = await checkScanAvailability();

    expect(availability.available).toBe(false);
    expect(availability.reason ?? '').toContain('pdftoppm');
  });

  it('раскладывает страницы PDF в PNG и убирает их за собой', async () => {
    if (!rasterizerReady) {
      // Машина без poppler: проверять нечего, зато отказ обязан быть внятным.
      expect((await checkScanAvailability()).reason ?? '').toContain('poppler');

      return;
    }

    const paths = await withRasterizedPdf(
      join(FIXTURES_DIR, 'scan.pdf'),
      { dpi: 100, maxPages: 2 },
      (pages) => Promise.resolve(pages.map((page) => page.path)),
    );

    // Предел страниц соблюдается, номера идут по порядку, картинки не остаются.
    expect(paths).toHaveLength(2);
    expect(paths.every((path) => path.endsWith('.png'))).toBe(true);
    expect(paths.map((path) => rmSync(path, { force: true }))).toHaveLength(2);
  });
});

describe('готовность распознавания', () => {
  it('выключенный режим объясняет, как его включить', async () => {
    setScanSettings({ mode: 'off' });

    const availability = await checkScanAvailability();

    expect(availability.available).toBe(false);
    expect(availability.reason ?? '').toContain('SCAN_MODE=off');
    expect(availability.reason ?? '').toContain('SCAN_MODE=ocr');
  });

  it('без единого бэкенда OCR называет, чего не хватает', async () => {
    setOcrBackend(stubBackend({ available: false }));

    const availability = await checkScanAvailability();

    expect(availability.available).toBe(false);
    expect(availability.reason ?? '').toContain('tesseract');
    expect(availability.reason ?? '').toContain('macOS Vision');
  });

  it('в режиме vision требует модель со зрением и называет её', async () => {
    setScanSettings({ mode: 'vision' });

    const availability = await checkScanAvailability();

    if (!rasterizerReady) {
      expect(availability.reason ?? '').toContain('poppler');

      return;
    }

    // Модель настроена по умолчанию (LLM_BASE_URL + LLM_MODEL), поэтому режим готов.
    expect(availability.available).toBe(true);
    expect(availability.engine).toBe('qwen3-vl:8b-instruct');
  });
});

describe('POST /api/materials: скан уходит в фоновую обработку', () => {
  it('отвечает 201 со статусом processing и доводит материал до ready', async () => {
    if (!rasterizerReady) {
      const material = await uploadScan();

      expect(material.status).toBe('error_no_text_layer');

      return;
    }

    const boundary = '----LanguageTutorScanBoundary';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${MATERIAL_FILE_FIELD_NAME}"; ` +
          'filename="scan.pdf"\r\nContent-Type: application/pdf\r\n\r\n',
        'utf8',
      ),
      fixture('scan.pdf'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/materials`,
      payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });

    expect(response.statusCode).toBe(201);

    const material = createMaterialResponseSchema.parse(response.json());

    // Ответ уходит сразу: распознавание страниц ещё даже не началось.
    expect(material.status).toBe('processing');
    expect(material.statusMessage ?? '').not.toBe('');
    expect(material.pageCount).toBe(SCAN_PAGES);

    await whenScansSettled();

    expect(reload(material.id).status).toBe('ready');
  });

  it('распознаёт страницы по очереди и показывает ход работы', async () => {
    if (!rasterizerReady) {
      return;
    }

    const seen: (string | null)[] = [];
    let materialId = '';

    setOcrBackend(
      stubBackend({
        recognize: (imagePath) => {
          // Страница распознаётся, когда прогресс уже записан: веб видит его сразу.
          seen.push(materialId === '' ? null : (reload(materialId).statusMessage ?? null));

          return `Страница файла ${imagePath}`;
        },
      }),
    );

    const material = await uploadScan();

    materialId = material.id;

    await whenScansSettled();

    const ready = reload(material.id);
    const { chunks } = getMaterial(material.id, { limit: 100, offset: 0 });

    expect(ready.status).toBe('ready');
    expect(ready.charCount).toBeGreaterThan(0);
    expect(ready.chunkCount).toBeGreaterThan(0);
    expect(chunks.items.length).toBe(ready.chunkCount);
    // Обработка закончилась — пояснения к статусу больше нет.
    expect(ready.statusMessage).toBeNull();
    expect(seen).toHaveLength(SCAN_PAGES);
    expect(seen[1] ?? '').toContain(`страница 2 из ${String(SCAN_PAGES)}`);
  });

  it('соблюдает SCAN_MAX_PAGES и честно пишет об этом', async () => {
    if (!rasterizerReady) {
      return;
    }

    setScanSettings({ maxPages: 2 });

    const material = await uploadScan();

    await whenScansSettled();

    const ready = reload(material.id);

    expect(ready.status).toBe('ready');
    expect(ready.pageCount).toBe(SCAN_PAGES);
    expect(ready.statusMessage ?? '').toContain('первые 2');
    expect(ready.statusMessage ?? '').toContain(String(SCAN_PAGES));
    expect(ready.statusMessage ?? '').toContain('SCAN_MAX_PAGES');
  });

  it('распознаёт скан настоящим локальным OCR, если он есть на машине', async () => {
    setOcrBackend(undefined);

    const availability = await checkScanAvailability();

    if (!availability.available) {
      // Ни macOS Vision, ни tesseract: материал обязан объяснить это человеку.
      const material = await uploadScan();

      expect(material.status).toBe('error_no_text_layer');
      expect(material.statusMessage ?? '').toMatch(/tesseract|poppler/i);

      return;
    }

    const material = await uploadScan();

    await whenScansSettled();

    const ready = reload(material.id);
    const { chunks } = getMaterial(material.id, { limit: 100, offset: 0 });

    expect(ready.status).toBe('ready');
    expect(ready.charCount).toBeGreaterThan(0);
    expect(chunks.items.length).toBeGreaterThan(0);
    expect(chunks.items.map((chunk) => chunk.content).join('\n')).toContain(SCAN_MARKER);
  }, 60_000);
});

describe('скан без распознавания', () => {
  it('при SCAN_MODE=off остаётся error_no_text_layer с объяснением', async () => {
    setScanSettings({ mode: 'off' });

    const material = await uploadScan();

    expect(material.status).toBe('error_no_text_layer');
    expect(material.statusMessage ?? '').toMatch(/скан/i);
    expect(material.statusMessage ?? '').toContain('SCAN_MODE=off');
    expect(material.chunkCount).toBe(0);
  });

  it('без pdftoppm даёт понятный статус, а не исключение', async () => {
    setRasterizerCommand(MISSING_COMMAND);

    const material = await uploadScan();

    expect(material.status).toBe('error_no_text_layer');
    expect(material.statusMessage ?? '').toContain('pdftoppm');
  });

  it('без бэкенда OCR даёт понятный статус, а не исключение', async () => {
    setOcrBackend(stubBackend({ available: false }));

    const material = await uploadScan();

    expect(material.status).toBe('error_no_text_layer');
    expect(material.statusMessage ?? '').toContain('tesseract');
  });

  it('пустой результат распознавания объясняет, что делать', async () => {
    if (!rasterizerReady) {
      return;
    }

    setOcrBackend(stubBackend({ recognize: () => '   ' }));

    const material = await uploadScan();

    await whenScansSettled();

    const failed = reload(material.id);

    expect(failed.status).toBe('error_no_text_layer');
    expect(failed.statusMessage ?? '').toContain('SCAN_DPI');
  });

  it('PDF с текстовым слоем обрабатывается синхронно, как раньше', async () => {
    let recognized = 0;

    setOcrBackend(
      stubBackend({
        recognize: () => {
          recognized += 1;

          return 'этого не должно случиться';
        },
      }),
    );

    const material = await createMaterialFromFile({
      data: fixture('sample.pdf'),
      fileName: 'sample.pdf',
      mimeType: 'application/pdf',
    });

    // Ответ на запрос уже финальный: ни `processing`, ни фоновой задачи.
    expect(material.status).toBe('ready');
    expect(material.charCount).toBeGreaterThan(0);
    expect(recognized).toBe(0);
  });
});

describe('режим vision', () => {
  it('отправляет страницу картинкой в data:image/png;base64', async () => {
    if (!rasterizerReady) {
      return;
    }

    const fetchMock: FetchMock = vi.fn(() =>
      Promise.resolve(chatResponse('Рынок\n[Иллюстрация: прилавок с яблоками]')),
    );

    vi.stubGlobal('fetch', fetchMock);
    setScanSettings({ mode: 'vision', maxPages: 1, visionModel: 'qwen3-vl:8b-instruct' });

    const scanned = await scanPdfPages(join(FIXTURES_DIR, 'scan.pdf'), { pageCount: SCAN_PAGES });

    expect(scanned.engine).toBe('qwen3-vl:8b-instruct');
    expect(scanned.text).toContain('Иллюстрация');
    expect(scanned.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = requestBody(fetchMock, 0);
    const messages = body.messages as { role: string; content: unknown }[];
    const parts = messages[1]?.content as { type: string; image_url?: { url: string } }[];

    expect(body.model).toBe('qwen3-vl:8b-instruct');
    // Системная инструкция остаётся обычной строкой, страница уходит списком кусков.
    expect(typeof messages[0]?.content).toBe('string');
    expect(String(messages[0]?.content)).toContain('illustration');
    expect(parts.map((part) => part.type)).toEqual(['text', 'image_url']);
    expect(parts[1]?.image_url?.url ?? '').toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  });

  it('строковый content остальных запросов не сломан', async () => {
    const fetchMock: FetchMock = vi.fn(() => Promise.resolve(chatResponse('Guten Tag')));

    vi.stubGlobal('fetch', fetchMock);

    await createLlmProvider({ baseUrl: 'http://llm.test/v1', model: 'qwen3:8b' }).chat({
      messages: [{ role: 'user', content: 'Поздоровайся по-немецки' }],
    });

    const messages = requestBody(fetchMock, 0).messages as { role: string; content: unknown }[];

    expect(messages).toEqual([{ role: 'user', content: 'Поздоровайся по-немецки' }]);
  });

  it('недоступная модель — статус материала, а не 500', async () => {
    if (!rasterizerReady) {
      return;
    }

    const fetchMock: FetchMock = vi.fn(() =>
      Promise.resolve(new Response('no such model', { status: 404 })),
    );

    vi.stubGlobal('fetch', fetchMock);
    setScanSettings({ mode: 'vision', maxPages: 1 });

    const material = await uploadScan();

    expect(material.status).toBe('processing');

    await whenScansSettled();

    const failed = reload(material.id);

    expect(failed.status).toBe('error_extraction_failed');
    expect(failed.statusMessage ?? '').toContain('ollama pull qwen3-vl:8b-instruct');
  });
});

describe('перезапуск сервера', () => {
  it('переводит зависший processing в ошибку', () => {
    const timestamp = new Date().toISOString();
    const stuck: Material = {
      id: 'зависший-материал',
      title: 'Скан учебника',
      sourceType: 'pdf',
      status: 'processing',
      statusMessage: 'Распознавание: страница 12 из 48',
      originalFileName: 'scan.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      language: 'de',
      level: null,
      charCount: 0,
      chunkCount: 0,
      coveredChunkCount: 0,
      pageCount: 48,
      topics: [],
      summary: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    insertMaterial(stuck, [], null);

    expect(recoverStuckMaterials()).toBe(1);

    const recovered = reload(stuck.id);

    expect(recovered.status).toBe('error_extraction_failed');
    expect(recovered.statusMessage ?? '').toContain('перезапуск');
    // Второй проход менять уже нечего: материалов в `processing` не осталось.
    expect(recoverStuckMaterials()).toBe(0);
  });
});
