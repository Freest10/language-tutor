import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  API_PREFIX,
  apiErrorResponseSchema,
  createMaterialResponseSchema,
  getMaterialResponseSchema,
  listMaterialsResponseSchema,
  MATERIAL_FILE_FIELD_NAME,
  MAX_MATERIAL_TEXT_LENGTH,
  type Material,
} from '@lt/shared';

import { buildApp } from '../src/app.js';
import { getDb, IN_MEMORY_DB_PATH, openDatabase, setDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { chunkText, estimateTokens } from '../src/lib/chunker.js';
import { resetScanSettings, setScanSettings } from '../src/lib/scanExtraction.js';
import { extractText, normalizeText } from '../src/lib/textExtraction.js';
import {
  getChunksForLesson,
  MAX_UPLOAD_BYTES,
  setUploadDir,
} from '../src/services/materialService.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Подстрока, которая обязана найтись в тексте, извлечённом из `sample.pdf`. */
const PDF_MARKER = 'Reading with a language tutor';

/** Часть multipart-запроса с файлом. */
interface FilePart {
  fieldName?: string;
  fileName: string;
  contentType: string;
  content: Buffer;
}

let app: FastifyInstance;
let uploadDir: string;

/** Читает фикстуру из `test/fixtures`. */
function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, name));
}

/**
 * Минимальный корректный PDF: объекты нумеруются с единицы, таблица xref
 * собирается по фактическим смещениям. Нужен, чтобы сделать PDF-скан
 * (страница без текстового слоя) прямо в тесте, не храня его файлом.
 */
function buildPdf(objects: string[]): Buffer {
  const header = '%PDF-1.4\n';
  const offsets: number[] = [];
  let body = '';
  let position = Buffer.byteLength(header, 'latin1');

  objects.forEach((object, index) => {
    const serialized = `${index + 1} 0 obj\n${object}\nendobj\n`;

    offsets.push(position);
    body += serialized;
    position += Buffer.byteLength(serialized, 'latin1');
  });

  const xref = offsets.reduce(
    (table, offset) => `${table}${String(offset).padStart(10, '0')} 00000 n \n`,
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
  );
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` + `startxref\n${position}\n%%EOF\n`;

  return Buffer.from(header + body + xref + trailer, 'latin1');
}

/** PDF-скан: одна страница с прямоугольником и без единой текстовой операции. */
function scannedPdf(): Buffer {
  const content = '0.85 0.85 0.85 rg\n56 520 500 220 re\nf';

  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]);
}

/** Собирает тело `multipart/form-data` для `app.inject()`. */
function multipart(
  file: FilePart | null,
  fields: Record<string, string> = {},
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----LanguageTutorTestBoundary';
  const parts: Buffer[] = [];

  if (file !== null) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; ` +
          `name="${file.fieldName ?? MATERIAL_FILE_FIELD_NAME}"; filename="${file.fileName}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
        'utf8',
      ),
      file.content,
      Buffer.from('\r\n', 'utf8'),
    );
  }

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** Загружает файл и возвращает ответ `POST /api/materials`. */
async function upload(file: FilePart, fields: Record<string, string> = {}) {
  const { payload, headers } = multipart(file, fields);

  return app.inject({ method: 'POST', url: `${API_PREFIX}/materials`, payload, headers });
}

/** Загружает файл и разбирает материал по схеме контракта. */
async function uploadMaterial(
  file: FilePart,
  fields: Record<string, string> = {},
): Promise<Material> {
  const response = await upload(file, fields);

  expect(response.statusCode).toBe(201);

  return createMaterialResponseSchema.parse(response.json());
}

/** Путь к исходному файлу материала: в контракт он не входит, поэтому берётся из базы. */
function filePathOf(id: string): string | null | undefined {
  const row = getDb().prepare('SELECT file_path FROM materials WHERE id = ?').get(id) as
    { file_path: string | null } | undefined;

  return row === undefined ? undefined : row.file_path;
}

/** Число фрагментов материала в базе. */
function chunkCountOf(id: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS total FROM material_chunks WHERE material_id = ?')
    .get(id) as { total: number };

  return row.total;
}

/** Все фрагменты материала одной страницей. */
async function fetchChunks(id: string) {
  const response = await app.inject({
    method: 'GET',
    url: `${API_PREFIX}/materials/${id}?limit=100`,
  });

  expect(response.statusCode).toBe(200);

  return getMaterialResponseSchema.parse(response.json()).chunks;
}

beforeAll(async () => {
  const db = openDatabase(IN_MEMORY_DB_PATH);

  migrate(db);
  setDb(db);

  // Тесты не должны оставлять файлы в реальном каталоге загрузок.
  uploadDir = mkdtempSync(join(tmpdir(), 'lt-materials-'));
  setUploadDir(uploadDir);

  // Этот файл проверяет синхронную обработку, поэтому распознавание сканов
  // выключено: с ним PDF-скан уходит в фон со статусом `processing`
  // (см. test/scan.test.ts).
  setScanSettings({ mode: 'off' });

  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  resetScanSettings();
  rmSync(uploadDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().exec('DELETE FROM materials');

  for (const entry of readdirSync(uploadDir)) {
    rmSync(join(uploadDir, entry), { force: true, recursive: true });
  }
});

describe('извлечение текста из фикстур', () => {
  it.each([
    { name: 'sample.txt', format: 'txt' as const },
    { name: 'sample.md', format: 'txt' as const },
    { name: 'sample.pdf', format: 'pdf' as const },
  ])('$name даёт непустой текст', async ({ name, format }) => {
    const extracted = await extractText(fixture(name), format);

    expect(extracted.text.length).toBeGreaterThan(0);
    expect(extracted.pages.length).toBeGreaterThan(0);
    expect(chunkText(extracted.text).length).toBeGreaterThan(0);
  });

  it('находит известную подстроку в тексте PDF', async () => {
    const extracted = await extractText(fixture('sample.pdf'), 'pdf');

    expect(extracted.text).toContain(PDF_MARKER);
    expect(extracted.pageCount).toBe(1);
  });

  it('приводит переводы строк и убирает управляющие символы', () => {
    expect(normalizeText('\uFEFFпервая\r\nвторая\rтретья\u0007  \n\n\n\nчетвёртая  ')).toBe(
      'первая\nвторая\nтретья\n\nчетвёртая',
    );
  });
});

describe('разбиение на фрагменты', () => {
  it('держит размер фрагмента в заданных границах и перекрывает соседние', () => {
    const paragraph =
      'Каждое утро начинается одинаково, и в этом вся его польза. ' +
      'Привычка не требует решимости, она требует только повторения. ';
    const chunks = chunkText(paragraph.repeat(40));

    expect(chunks.length).toBeGreaterThan(2);

    for (const chunk of chunks) {
      expect(chunk.charCount).toBe(chunk.content.length);
      expect(chunk.charCount).toBeLessThanOrEqual(1300);
    }

    const [first, second] = chunks;

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.content.endsWith(second?.content.split('\n', 1)[0] ?? '')).toBe(true);
  });

  it('оценивает токены как символы, делённые на четыре', () => {
    expect(estimateTokens('12345678')).toBe(2);
  });
});

describe('POST /api/materials: загрузка файла', () => {
  it.each([
    { name: 'sample.txt', contentType: 'text/plain', sourceType: 'txt' },
    { name: 'sample.md', contentType: 'text/markdown', sourceType: 'txt' },
    { name: 'sample.pdf', contentType: 'application/pdf', sourceType: 'pdf' },
  ])('принимает $name и разбивает его на фрагменты', async ({ name, contentType, sourceType }) => {
    const material = await uploadMaterial({
      fileName: name,
      contentType,
      content: fixture(name),
    });

    expect(material.status).toBe('ready');
    expect(material.sourceType).toBe(sourceType);
    expect(material.charCount).toBeGreaterThan(0);
    expect(material.chunkCount).toBeGreaterThan(0);
    expect(material.originalFileName).toBe(name);

    const chunks = await fetchChunks(material.id);

    expect(chunks.total).toBe(material.chunkCount);
    expect(chunks.items.length).toBeGreaterThan(0);
    expect(chunks.items.map((chunk) => chunk.order)).toEqual(
      chunks.items.map((_chunk, index) => index),
    );

    for (const chunk of chunks.items) {
      expect(chunk.content.length).toBeGreaterThan(0);
      expect(chunk.charCount).toBe(chunk.content.length);
    }

    if (sourceType === 'pdf') {
      expect(chunks.items.map((chunk) => chunk.content).join('\n')).toContain(PDF_MARKER);
    }
  });

  it('сохраняет файл в каталоге загрузок под сгенерированным именем', async () => {
    const material = await uploadMaterial({
      fileName: 'sample.txt',
      contentType: 'text/plain',
      content: fixture('sample.txt'),
    });

    const filePath = filePathOf(material.id);

    expect(filePath).toBe(join(uploadDir, `${material.id}.txt`));
    expect(existsSync(filePath ?? '')).toBe(true);
    expect(readdirSync(uploadDir)).toEqual([`${material.id}.txt`]);
  });

  it('берёт название и язык из полей формы', async () => {
    const material = await uploadMaterial(
      { fileName: 'sample.md', contentType: 'text/markdown', content: fixture('sample.md') },
      { title: 'Свой заголовок', language: 'de' },
    );

    expect(material.title).toBe('Свой заголовок');
    expect(material.language).toBe('de');
  });

  it('распознаёт markdown по расширению, когда MIME-тип бесполезен', async () => {
    const material = await uploadMaterial({
      fileName: 'notes.md',
      contentType: 'application/octet-stream',
      content: fixture('sample.md'),
    });

    expect(material.status).toBe('ready');
    expect(material.title).toBe('notes');
    expect(filePathOf(material.id)).toBe(join(uploadDir, `${material.id}.md`));
  });

  it('сохраняет PDF-скан со статусом error_no_text_layer и пояснением', async () => {
    const material = await uploadMaterial({
      fileName: 'scan.pdf',
      contentType: 'application/pdf',
      content: scannedPdf(),
    });

    expect(material.status).toBe('error_no_text_layer');
    expect(material.statusMessage ?? '').toMatch(/скан/i);
    expect(material.chunkCount).toBe(0);
    expect(chunkCountOf(material.id)).toBe(0);
    // Файл принят и остаётся на диске: пользователь должен иметь возможность его удалить.
    expect(existsSync(filePathOf(material.id) ?? '')).toBe(true);
  });

  it('сохраняет повреждённый PDF со статусом error_extraction_failed', async () => {
    const material = await uploadMaterial({
      fileName: 'broken.pdf',
      contentType: 'application/pdf',
      content: Buffer.from('%PDF-1.4 и дальше мусор', 'utf8'),
    });

    expect(material.status).toBe('error_extraction_failed');
    expect(material.statusMessage ?? '').not.toBe('');
  });

  it('отвечает 415 на неподдерживаемый формат', async () => {
    const response = await upload({
      fileName: 'setup.exe',
      contentType: 'application/octet-stream',
      content: Buffer.from('MZ\u0000\u0000исполняемый файл', 'utf8'),
    });

    expect(response.statusCode).toBe(415);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('unsupported_media_type');
    expect(readdirSync(uploadDir)).toEqual([]);
  });

  it('отвечает 413 на файл больше предела', async () => {
    const response = await upload({
      fileName: 'huge.txt',
      contentType: 'text/plain',
      content: Buffer.alloc(MAX_UPLOAD_BYTES + 1, 'a'),
    });

    expect(response.statusCode).toBe(413);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('payload_too_large');
    expect(readdirSync(uploadDir)).toEqual([]);
  });

  it('отвечает 400 на пустой файл', async () => {
    const response = await upload({
      fileName: 'empty.txt',
      contentType: 'text/plain',
      content: Buffer.alloc(0),
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('bad_request');
    expect(readdirSync(uploadDir)).toEqual([]);
  });

  it('отвечает 400, если часть file не передана', async () => {
    const { payload, headers } = multipart(
      {
        fieldName: 'attachment',
        fileName: 'sample.txt',
        contentType: 'text/plain',
        content: fixture('sample.txt'),
      },
      { title: 'Без файла' },
    );
    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/materials`,
      payload,
      headers,
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('bad_request');
  });

  it('не выпускает запись за пределы каталога загрузок при имени с ../', async () => {
    const material = await uploadMaterial({
      fileName: '../../etc/passwd',
      contentType: 'text/plain',
      content: fixture('sample.txt'),
    });

    const filePath = filePathOf(material.id);

    expect(filePath).toBe(join(uploadDir, `${material.id}.txt`));
    expect(dirname(filePath ?? '')).toBe(uploadDir);
    expect(readdirSync(uploadDir)).toEqual([`${material.id}.txt`]);
    expect(existsSync(join(uploadDir, '..', 'passwd'))).toBe(false);
    expect(existsSync(join(uploadDir, '..', '..', 'passwd'))).toBe(false);
    // Имя из запроса сохраняется только как справочное, без разделителей пути.
    expect(material.originalFileName).toBe('passwd');
    expect(material.title).toBe('passwd');
  });

  it('отвечает 413 на запрос с лишними текстовыми полями', async () => {
    // Пределы разбора multipart заданы на маршруте: без них один запрос
    // удерживал бы в памяти сколько угодно полей и файловых частей.
    const fields = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`field-${String(index)}`, 'x'.repeat(100)]),
    );
    const { payload, headers } = multipart(
      { fileName: 'sample.txt', contentType: 'text/plain', content: fixture('sample.txt') },
      fields,
    );
    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/materials`,
      payload,
      headers,
    });

    expect(response.statusCode).toBe(413);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('payload_too_large');
    expect(readdirSync(uploadDir)).toEqual([]);
  });

  it('не принимает имя файла с обратными слешами как путь', async () => {
    const material = await uploadMaterial({
      fileName: 'C:\\\\Windows\\\\system32\\\\notes.txt',
      contentType: 'text/plain',
      content: fixture('sample.txt'),
    });

    expect(material.originalFileName).toBe('notes.txt');
    expect(readdirSync(uploadDir)).toEqual([`${material.id}.txt`]);
  });
});

describe('POST /api/materials: вставленный текст', () => {
  it('создаёт материал без файла на диске', async () => {
    const text = fixture('sample.txt').toString('utf8');
    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/materials`,
      payload: { text },
    });

    expect(response.statusCode).toBe(201);

    const material = createMaterialResponseSchema.parse(response.json());

    expect(material.sourceType).toBe('text');
    expect(material.status).toBe('ready');
    expect(material.chunkCount).toBeGreaterThan(0);
    expect(material.title).toBe('Morning routines in a new language');
    expect(material.originalFileName).toBeNull();
    expect(filePathOf(material.id)).toBeNull();
    expect(readdirSync(uploadDir)).toEqual([]);
  });

  it('отвечает 400 на текст длиннее предела контракта', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/materials`,
      payload: { text: 'а'.repeat(MAX_MATERIAL_TEXT_LENGTH + 1) },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
    // Материал не создан: длинный текст отсекается до разбора на фрагменты.
    const page = await app.inject({ method: 'GET', url: `${API_PREFIX}/materials` });

    expect(listMaterialsResponseSchema.parse(page.json()).total).toBe(0);
  });

  it('принимает текст ровно по пределу контракта', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/materials`,
      payload: { text: `Предельный текст\n${'а'.repeat(MAX_MATERIAL_TEXT_LENGTH - 17)}` },
    });

    expect(response.statusCode).toBe(201);
    expect(createMaterialResponseSchema.parse(response.json()).status).toBe('ready');
  });

  it('отвечает 400 на пустой текст', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/materials`,
      payload: { text: '   ' },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });
});

describe('GET /api/materials', () => {
  it('отдаёт страницу списка с фильтрами', async () => {
    await uploadMaterial({
      fileName: 'sample.txt',
      contentType: 'text/plain',
      content: fixture('sample.txt'),
    });
    await uploadMaterial({
      fileName: 'sample.pdf',
      contentType: 'application/pdf',
      content: fixture('sample.pdf'),
    });

    const all = await app.inject({ method: 'GET', url: `${API_PREFIX}/materials` });

    expect(all.statusCode).toBe(200);

    const page = listMaterialsResponseSchema.parse(all.json());

    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(false);

    const onlyPdf = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/materials?sourceType=pdf`,
    });

    expect(listMaterialsResponseSchema.parse(onlyPdf.json()).total).toBe(1);

    const firstPage = await app.inject({ method: 'GET', url: `${API_PREFIX}/materials?limit=1` });
    const parsedFirstPage = listMaterialsResponseSchema.parse(firstPage.json());

    expect(parsedFirstPage.items).toHaveLength(1);
    expect(parsedFirstPage.hasMore).toBe(true);
  });

  it('ищет по названию и по тексту фрагментов', async () => {
    await uploadMaterial(
      { fileName: 'sample.txt', contentType: 'text/plain', content: fixture('sample.txt') },
      { title: 'Утренние привычки' },
    );

    const byTitle = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/materials?search=${encodeURIComponent('привычки')}`,
    });

    expect(listMaterialsResponseSchema.parse(byTitle.json()).total).toBe(1);

    const byContent = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/materials?search=${encodeURIComponent('neighbour')}`,
    });

    expect(listMaterialsResponseSchema.parse(byContent.json()).total).toBe(1);

    const missing = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/materials?search=${encodeURIComponent('дирижабль')}`,
    });

    expect(listMaterialsResponseSchema.parse(missing.json()).total).toBe(0);
  });
});

describe('GET /api/materials/:id', () => {
  it('отдаёт материал и страницу его фрагментов', async () => {
    const material = await uploadMaterial({
      fileName: 'sample.txt',
      contentType: 'text/plain',
      content: fixture('sample.txt'),
    });

    const response = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/materials/${material.id}?limit=1`,
    });

    expect(response.statusCode).toBe(200);

    const body = getMaterialResponseSchema.parse(response.json());

    expect(body.material.id).toBe(material.id);
    expect(body.chunks.items).toHaveLength(1);
    expect(body.chunks.limit).toBe(1);
    expect(body.chunks.total).toBe(material.chunkCount);
    expect(body.chunks.hasMore).toBe(material.chunkCount > 1);
  });

  it('отвечает 404 на неизвестный материал', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/materials/нет-такого`,
    });

    expect(response.statusCode).toBe(404);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('not_found');
  });
});

describe('DELETE /api/materials/:id', () => {
  it('удаляет материал, его фрагменты и файл с диска', async () => {
    const material = await uploadMaterial({
      fileName: 'sample.pdf',
      contentType: 'application/pdf',
      content: fixture('sample.pdf'),
    });
    const filePath = filePathOf(material.id) ?? '';

    expect(existsSync(filePath)).toBe(true);
    expect(chunkCountOf(material.id)).toBeGreaterThan(0);

    const response = await app.inject({
      method: 'DELETE',
      url: `${API_PREFIX}/materials/${material.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(existsSync(filePath)).toBe(false);
    expect(readdirSync(uploadDir)).toEqual([]);
    expect(chunkCountOf(material.id)).toBe(0);
    expect(filePathOf(material.id)).toBeUndefined();
  });

  it('отвечает 404 на неизвестный материал', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `${API_PREFIX}/materials/нет-такого`,
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('getChunksForLesson', () => {
  it('не выходит за бюджет символов и отмечает усечение', async () => {
    const material = await uploadMaterial({
      fileName: 'sample.txt',
      contentType: 'text/plain',
      content: fixture('sample.txt'),
    });

    const full = getChunksForLesson([material.id], 100_000);

    expect(full.chunks.length).toBe(material.chunkCount);
    expect(full.truncated).toBe(false);
    expect(full.estimatedTokens).toBe(Math.ceil(full.totalChars / 4));

    const budget = 900;
    const limited = getChunksForLesson([material.id], budget);

    expect(limited.totalChars).toBeLessThanOrEqual(budget);
    expect(limited.chunks.length).toBeGreaterThan(0);
    expect(limited.chunks.length).toBeLessThan(full.chunks.length);
    expect(limited.truncated).toBe(true);
    expect(limited.chunks.map((entry) => entry.chunk.order)).toEqual(
      [...limited.chunks.map((entry) => entry.chunk.order)].sort((left, right) => left - right),
    );
    expect(limited.chunks[0]?.materialTitle).toBe(material.title);
  });

  it('поднимает наверх фрагменты с ключевыми словами', async () => {
    const material = await uploadMaterial({
      fileName: 'sample.txt',
      contentType: 'text/plain',
      content: fixture('sample.txt'),
    });
    const selection = getChunksForLesson([material.id], 1200, { keywords: ['neighbour'] });

    expect(selection.chunks.length).toBeGreaterThan(0);
    expect(selection.chunks.some((entry) => entry.chunk.content.includes('neighbour'))).toBe(true);
    expect(selection.chunks[0]?.score).toBeGreaterThan(0);
  });

  it('пропускает материалы без готового текста и неизвестные идентификаторы', async () => {
    const scan = await uploadMaterial({
      fileName: 'scan.pdf',
      contentType: 'application/pdf',
      content: scannedPdf(),
    });

    expect(getChunksForLesson([scan.id], 5000)).toMatchObject({
      chunks: [],
      totalChars: 0,
      skippedMaterialIds: [scan.id],
    });
    expect(getChunksForLesson([], 5000).chunks).toEqual([]);
    // Бюджет нормальный, материала не существует: пропущен по идентификатору.
    expect(getChunksForLesson(['нет-такого'], 5000)).toMatchObject({
      chunks: [],
      totalChars: 0,
      skippedMaterialIds: ['нет-такого'],
    });
  });

  it('не берёт ни одного фрагмента при нулевом бюджете', async () => {
    // Материал настоящий и готовый: пустой результат обязан быть следствием
    // бюджета, а не того, что брать было нечего.
    const material = await uploadMaterial({
      fileName: 'sample.txt',
      contentType: 'text/plain',
      content: fixture('sample.txt'),
    });

    expect(getChunksForLesson([material.id], 100_000).chunks.length).toBeGreaterThan(0);
    expect(getChunksForLesson([material.id], 0)).toMatchObject({
      chunks: [],
      totalChars: 0,
      estimatedTokens: 0,
      skippedMaterialIds: [material.id],
    });
    expect(getChunksForLesson([material.id], -1).chunks).toEqual([]);
  });
});
