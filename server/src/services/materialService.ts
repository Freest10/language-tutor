/**
 * Прикладная логика материалов: приём файла или текста, извлечение текста,
 * разбиение на фрагменты, выдача и удаление.
 *
 * Обработка синхронная: `POST /api/materials` возвращает материал, у которого уже
 * проставлен финальный статус (`ready` либо один из `error_*`). Очередь и фоновые
 * задачи в однопользовательском локальном приложении не нужны, а предсказуемый
 * ответ упрощает интерфейс: показывать «обрабатывается…» не требуется.
 *
 * Оценка уровня (`level`), темы (`topics`) и краткое содержание (`summary`) здесь
 * не заполняются: это работа языковой модели, а не разбора файла.
 */
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

import {
  MATERIAL_SUPPORTED_MIME_TYPES,
  MAX_MATERIAL_UPLOAD_BYTES,
  DEFAULT_LANGUAGE_CODE,
  type GetMaterialResponse,
  type Id,
  type LanguageCode,
  type ListMaterialsQuery,
  type Material,
  type MaterialChunk,
  type MaterialSourceType,
  type Paginated,
  type PaginationQuery,
} from '@lt/shared';

import { env } from '../config/env.js';
import { nowIso } from '../db/mappers.js';
import { chunkSources, estimateTokens, type TextChunk, type TextSource } from '../lib/chunker.js';
import {
  badRequest,
  internalError,
  notFound,
  payloadTooLarge,
  unsupportedMediaType,
} from '../lib/httpErrors.js';
import {
  extractText,
  isTextExtractionError,
  normalizeText,
  type ExtractableFormat,
  type ExtractedText,
} from '../lib/textExtraction.js';
import {
  deleteMaterialById,
  findLearningLanguage,
  findMaterialById,
  findMaterialFilePath,
  findMaterialsByIds,
  insertMaterial,
  listChunksByMaterialIds,
  listMaterialChunks,
  listMaterials as selectMaterials,
} from '../repositories/materialRepository.js';

/** Предел размера загружаемого файла: меньшее из ограничения контракта и `MAX_UPLOAD_MB`. */
export const MAX_UPLOAD_BYTES = Math.min(MAX_MATERIAL_UPLOAD_BYTES, env.maxUploadBytes);

/** Название материала, если его неоткуда взять. */
const FALLBACK_TITLE = 'Материал без названия';

/** Предельные длины полей контракта: значения обрезаются, а не отбрасываются. */
const MAX_TITLE_LENGTH = 200;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_MIME_TYPE_LENGTH = 120;
const MAX_STATUS_MESSAGE_LENGTH = 500;

/** Как распознан загруженный файл. */
interface UploadKind {
  /** Формат для извлечения текста. */
  format: ExtractableFormat;
  /** Тип источника в контракте: Markdown хранится как `txt`. */
  sourceType: MaterialSourceType;
  /**
   * Расширение, с которым файл ложится на диск. Выбирается по распознанному
   * формату, а не по имени из запроса: имя пользователя в путь не попадает.
   */
  extension: string;
}

const PDF_KIND: UploadKind = { format: 'pdf', sourceType: 'pdf', extension: '.pdf' };
const TXT_KIND: UploadKind = { format: 'txt', sourceType: 'txt', extension: '.txt' };
const MARKDOWN_KIND: UploadKind = { format: 'txt', sourceType: 'txt', extension: '.md' };

/** Распознавание по MIME-типу. */
const KIND_BY_MIME_TYPE: Record<string, UploadKind | undefined> = {
  'application/pdf': PDF_KIND,
  'text/plain': TXT_KIND,
  'text/markdown': MARKDOWN_KIND,
  'text/x-markdown': MARKDOWN_KIND,
};

/** Распознавание по расширению: браузеры присылают `.md` как `application/octet-stream`. */
const KIND_BY_EXTENSION: Record<string, UploadKind | undefined> = {
  '.pdf': PDF_KIND,
  '.txt': TXT_KIND,
  '.text': TXT_KIND,
  '.md': MARKDOWN_KIND,
  '.markdown': MARKDOWN_KIND,
};

/** Каталог загруженных файлов; подменяется только тестами. */
let uploadDir = env.uploadDir;

/** Текущий каталог загруженных файлов. */
export function getUploadDir(): string {
  return uploadDir;
}

/**
 * Подменяет каталог загруженных файлов (тесты) — по образцу `setDb()`.
 * Каталог создаётся лениво, при первой записи файла.
 */
export function setUploadDir(directory: string): void {
  uploadDir = resolve(directory);
}

/** Файл, пришедший в запросе. */
export interface UploadedFile {
  data: Buffer;
  /** Имя файла из запроса: используется только как название и для распознавания формата. */
  fileName?: string | null;
  /** MIME-тип из запроса. */
  mimeType?: string | null;
}

/** Создание материала из загруженного файла. */
export interface CreateFileMaterialInput extends UploadedFile {
  title?: string;
  language?: LanguageCode;
}

/** Создание материала из текста, вставленного пользователем. */
export interface CreateTextMaterialInput {
  text: string;
  title?: string;
  language?: LanguageCode;
}

// ---------------------------------------------------------------------------
// Создание
// ---------------------------------------------------------------------------

/**
 * Принимает загруженный файл: сохраняет его в каталог загрузок, извлекает текст
 * и разбивает на фрагменты. Неподдерживаемый формат и превышение размера — это
 * ошибки запроса (415 и 413); неудача извлечения текста — материал со статусом
 * `error_*`, потому что файл уже принят и пользователю нужно видеть причину.
 */
export async function createMaterialFromFile(input: CreateFileMaterialInput): Promise<Material> {
  const kind = resolveUploadKind(input.fileName, input.mimeType);

  if (input.data.length > MAX_UPLOAD_BYTES) {
    throw payloadTooLarge(
      `Файл больше допустимых ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} МиБ`,
    );
  }
  if (input.data.length === 0) {
    throw badRequest('Загруженный файл пуст');
  }

  const id = crypto.randomUUID();
  const fileName = safeFileName(input.fileName);
  const filePath = await storeUpload(id, kind.extension, input.data);

  try {
    return await buildMaterial({
      id,
      sourceType: kind.sourceType,
      title: input.title ?? titleFromFileName(fileName),
      language: input.language,
      originalFileName: fileName,
      mimeType: truncate(input.mimeType ?? null, MAX_MIME_TYPE_LENGTH),
      sizeBytes: input.data.length,
      filePath,
      extract: () => extractText(input.data, kind.format),
    });
  } catch (error) {
    // Запись в базу не состоялась — файл без неё не нужен: убираем, чтобы каталог
    // загрузок не копил осиротевшие файлы.
    await removeUpload(filePath).catch(() => undefined);

    throw error;
  }
}

/** Принимает текст, вставленный пользователем: файл на диске при этом не создаётся. */
export async function createMaterialFromText(input: CreateTextMaterialInput): Promise<Material> {
  const text = normalizeText(input.text);

  return buildMaterial({
    id: crypto.randomUUID(),
    sourceType: 'text',
    title: input.title ?? titleFromText(text),
    language: input.language,
    originalFileName: null,
    mimeType: 'text/plain',
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    filePath: null,
    extract: () => Promise.resolve({ text, pages: [{ page: 1, text }], pageCount: null }),
  });
}

/** Общая часть создания: извлечение текста, разбиение и запись в базу. */
async function buildMaterial(draft: {
  id: Id;
  sourceType: MaterialSourceType;
  title: string;
  language: LanguageCode | undefined;
  originalFileName: string | null;
  mimeType: string | null;
  sizeBytes: number;
  filePath: string | null;
  extract: () => Promise<ExtractedText>;
}): Promise<Material> {
  const timestamp = nowIso();
  const base: Material = {
    id: draft.id,
    title: truncate(draft.title, MAX_TITLE_LENGTH) ?? FALLBACK_TITLE,
    sourceType: draft.sourceType,
    status: 'ready',
    statusMessage: null,
    originalFileName: draft.originalFileName,
    mimeType: draft.mimeType,
    sizeBytes: draft.sizeBytes,
    language: draft.language ?? findLearningLanguage() ?? DEFAULT_LANGUAGE_CODE,
    level: null,
    charCount: 0,
    chunkCount: 0,
    pageCount: null,
    topics: [],
    summary: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  let extracted: ExtractedText;

  try {
    extracted = await draft.extract();
  } catch (error) {
    const failed: Material = isTextExtractionError(error)
      ? {
          ...base,
          status: error.status,
          statusMessage: truncate(error.message, MAX_STATUS_MESSAGE_LENGTH),
        }
      : {
          ...base,
          status: 'error_extraction_failed',
          statusMessage: 'Не удалось извлечь текст из файла',
        };

    insertMaterial(failed, [], draft.filePath);

    return failed;
  }

  const chunks = toMaterialChunks(draft.id, extracted, timestamp);
  const material: Material = {
    ...base,
    charCount: extracted.text.length,
    chunkCount: chunks.length,
    pageCount: extracted.pageCount,
  };

  insertMaterial(material, chunks, draft.filePath);

  return material;
}

/** Переводит извлечённый текст в фрагменты `material_chunks`. */
function toMaterialChunks(
  materialId: Id,
  extracted: ExtractedText,
  createdAt: string,
): MaterialChunk[] {
  const sources: TextSource[] = extracted.pages.map((page) => ({
    text: page.text,
    page: extracted.pageCount === null ? null : page.page,
  }));

  return chunkSources(sources).map((chunk: TextChunk, index) => ({
    id: crypto.randomUUID(),
    materialId,
    order: index,
    content: chunk.content,
    charCount: chunk.charCount,
    page: chunk.page,
    heading: chunk.heading,
    createdAt,
  }));
}

// ---------------------------------------------------------------------------
// Чтение и удаление
// ---------------------------------------------------------------------------

/** Страница списка материалов. */
export function listMaterials(query: ListMaterialsQuery): Paginated<Material> {
  return selectMaterials(query);
}

/** Материал и страница его фрагментов; 404, если материала нет. */
export function getMaterial(id: Id, pagination: PaginationQuery): GetMaterialResponse {
  const material = findMaterialById(id);

  if (material === undefined) {
    throw notFound(`Материал ${id} не найден`);
  }

  return { material, chunks: listMaterialChunks(id, pagination) };
}

/**
 * Удаляет материал, его фрагменты (каскадом) и исходный файл с диска.
 * Отсутствующий на диске файл не считается ошибкой: запись всё равно удаляется.
 */
export async function deleteMaterial(id: Id): Promise<void> {
  const filePath = findMaterialFilePath(id);

  if (filePath === undefined) {
    throw notFound(`Материал ${id} не найден`);
  }

  deleteMaterialById(id);

  if (filePath !== null) {
    await removeUpload(filePath);
  }
}

// ---------------------------------------------------------------------------
// Точка интеграции с планировщиком урока
// ---------------------------------------------------------------------------

/** Настройки отбора фрагментов под промпт. */
export interface LessonChunkOptions {
  /**
   * Ключевые слова темы урока: по ним фрагменты ранжируются. Пустой список —
   * отбор идёт с начала материалов, как читатель открыл бы их с первой страницы.
   */
  keywords?: readonly string[];
  /** Верхняя граница числа фрагментов независимо от бюджета символов. */
  maxChunks?: number;
}

/** Отобранный фрагмент вместе с материалом, из которого он взят. */
export interface LessonChunk {
  materialId: Id;
  materialTitle: string;
  chunk: MaterialChunk;
  /** Оценка релевантности: 0 — совпадений с ключевыми словами нет. */
  score: number;
}

/** Результат отбора фрагментов под бюджет промпта. */
export interface LessonChunkSelection {
  /** Фрагменты в порядке чтения: сначала по порядку материалов, затем по `order`. */
  chunks: LessonChunk[];
  /** Суммарная длина `content` отобранных фрагментов; не превышает бюджет. */
  totalChars: number;
  /** Грубая оценка токенов (символы / 4). */
  estimatedTokens: number;
  /** `true` — часть фрагментов не поместилась в бюджет. */
  truncated: boolean;
  /** Материалы, не давшие ни одного фрагмента: не готовы, пусты или не существуют. */
  skippedMaterialIds: Id[];
}

/**
 * Отбирает фрагменты материалов под бюджет символов промпта — точка интеграции
 * с генерацией плана урока.
 *
 * Стратегия (A11 — без эмбеддингов и векторного поиска, чтобы не тянуть в локальную
 * установку ещё одну модель):
 * 1. берутся только материалы со статусом `ready`; остальные попадают в `skippedMaterialIds`;
 * 2. каждый фрагмент получает оценку — число вхождений ключевых слов в текст
 *    (вхождение в заголовок фрагмента весит втрое); без ключевых слов оценка нулевая
 *    и порядок остаётся исходным, то есть от начала материала;
 * 3. фрагменты добираются по кругу из всех материалов, чтобы один длинный материал
 *    не занял весь бюджет;
 * 4. фрагмент берётся целиком или не берётся вовсе: обрезанный текст портит промпт.
 *
 * Ограничение честное: на длинном PDF без ключевых слов отбор вырождается в «первые
 * N фрагментов», а поиск по подстроке не знает ни словоформ, ни синонимов. Для больших
 * материалов релевантность заметно падает — это цена отказа от векторного поиска.
 *
 * @param materialIds материалы урока; порядок задаёт приоритет при равной оценке
 * @param budgetChars бюджет промпта в символах; суммарная длина фрагментов его не превысит
 */
export function getChunksForLesson(
  materialIds: readonly Id[],
  budgetChars: number,
  options: LessonChunkOptions = {},
): LessonChunkSelection {
  const empty: LessonChunkSelection = {
    chunks: [],
    totalChars: 0,
    estimatedTokens: 0,
    truncated: false,
    skippedMaterialIds: [...materialIds],
  };

  if (materialIds.length === 0 || budgetChars <= 0) {
    return empty;
  }

  const materials = findMaterialsByIds(materialIds).filter(
    (material) => material.status === 'ready',
  );

  if (materials.length === 0) {
    return empty;
  }

  const keywords = normalizeKeywords(options.keywords ?? []);
  const maxChunks = options.maxChunks ?? Number.POSITIVE_INFINITY;
  const chunksByMaterial = groupChunks(materials, keywords);
  const selected = pickWithinBudget(chunksByMaterial, budgetChars, maxChunks);
  const positionOfMaterial = new Map(materials.map((material, index) => [material.id, index]));

  selected.chunks.sort((left, right) => {
    const byMaterial =
      (positionOfMaterial.get(left.materialId) ?? 0) -
      (positionOfMaterial.get(right.materialId) ?? 0);

    return byMaterial === 0 ? left.chunk.order - right.chunk.order : byMaterial;
  });

  const used = new Set(selected.chunks.map((entry) => entry.materialId));
  const totalChars = selected.chunks.reduce(
    (total, entry) => total + entry.chunk.content.length,
    0,
  );

  return {
    chunks: selected.chunks,
    totalChars,
    estimatedTokens: estimateTokens(selected.chunks.map((entry) => entry.chunk.content).join('')),
    truncated: selected.truncated,
    skippedMaterialIds: materialIds.filter((id) => !used.has(id)),
  };
}

/** Раскладывает фрагменты по материалам и сортирует каждую стопку по релевантности. */
function groupChunks(materials: Material[], keywords: string[]): LessonChunk[][] {
  const chunks = listChunksByMaterialIds(materials.map((material) => material.id));
  const titleById = new Map(materials.map((material) => [material.id, material.title]));
  const byMaterial = new Map<Id, LessonChunk[]>(materials.map((material) => [material.id, []]));

  for (const chunk of chunks) {
    byMaterial.get(chunk.materialId)?.push({
      materialId: chunk.materialId,
      materialTitle: titleById.get(chunk.materialId) ?? '',
      chunk,
      score: scoreChunk(chunk, keywords),
    });
  }

  return materials
    .map((material) => byMaterial.get(material.id) ?? [])
    .filter((stack) => stack.length > 0)
    .map((stack) =>
      [...stack].sort((left, right) =>
        right.score === left.score
          ? left.chunk.order - right.chunk.order
          : right.score - left.score,
      ),
    );
}

/** Берёт фрагменты по кругу из всех материалов, пока они помещаются в бюджет. */
function pickWithinBudget(
  stacks: LessonChunk[][],
  budgetChars: number,
  maxChunks: number,
): { chunks: LessonChunk[]; truncated: boolean } {
  const cursors = stacks.map(() => 0);
  const chunks: LessonChunk[] = [];
  let remaining = budgetChars;
  let truncated = false;
  let progressed = true;

  while (progressed && chunks.length < maxChunks) {
    progressed = false;

    for (const [index, stack] of stacks.entries()) {
      if (chunks.length >= maxChunks) {
        break;
      }

      const cursor = cursors[index] ?? 0;
      const candidate = stack[cursor];

      if (candidate === undefined) {
        continue;
      }

      cursors[index] = cursor + 1;
      progressed = true;

      if (candidate.chunk.content.length > remaining) {
        truncated = true;
        continue;
      }

      chunks.push(candidate);
      remaining -= candidate.chunk.content.length;
    }
  }

  const leftovers = stacks.reduce(
    (total, stack, index) => total + Math.max(0, stack.length - (cursors[index] ?? 0)),
    0,
  );

  return { chunks, truncated: truncated || leftovers > 0 };
}

/** Ключевые слова в нормализованном виде: без регистра, без пустых значений. */
function normalizeKeywords(keywords: readonly string[]): string[] {
  return [
    ...new Set(
      keywords
        .map((keyword) => keyword.trim().toLowerCase())
        .filter((keyword) => keyword.length > 0),
    ),
  ];
}

/** Оценка фрагмента: число вхождений ключевых слов, вхождение в заголовок весит втрое. */
function scoreChunk(chunk: MaterialChunk, keywords: string[]): number {
  if (keywords.length === 0) {
    return 0;
  }

  const content = chunk.content.toLowerCase();
  const heading = (chunk.heading ?? '').toLowerCase();

  return keywords.reduce(
    (total, keyword) =>
      total + countOccurrences(content, keyword) + 3 * countOccurrences(heading, keyword),
    0,
  );
}

/** Число вхождений подстроки (совпадения не перекрываются). */
function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  let count = 0;
  let index = text.indexOf(needle);

  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }

  return count;
}

// ---------------------------------------------------------------------------
// Файлы на диске
// ---------------------------------------------------------------------------

/**
 * Распознаёт формат файла по MIME-типу, а если он бесполезен
 * (`application/octet-stream` у Markdown) — по расширению имени.
 */
export function resolveUploadKind(
  fileName: string | null | undefined,
  mimeType: string | null | undefined,
): UploadKind {
  const normalizedMime = (mimeType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const byMime = KIND_BY_MIME_TYPE[normalizedMime];

  if (byMime !== undefined) {
    return byMime;
  }

  const extension = extname(safeFileName(fileName) ?? '').toLowerCase();
  const byExtension = KIND_BY_EXTENSION[extension];

  if (byExtension !== undefined) {
    return byExtension;
  }

  throw unsupportedMediaType(
    `Формат не поддерживается: принимаются ${MATERIAL_SUPPORTED_MIME_TYPES.join(', ')} ` +
      '(файлы .pdf, .txt, .md)',
    {
      details: {
        mimeType: normalizedMime === '' ? null : normalizedMime,
        extension: extension === '' ? null : extension,
      },
    },
  );
}

/**
 * Кладёт файл в каталог загрузок под именем `<uuid><расширение>`.
 *
 * Имя из запроса в путь не попадает: ни один его символ не участвует в построении
 * пути, поэтому `../../etc/passwd` или `C:\Windows\x.txt` записать невозможно.
 * Итоговый путь дополнительно сверяется с каталогом загрузок.
 */
async function storeUpload(id: Id, extension: string, data: Buffer): Promise<string> {
  const directory = getUploadDir();
  const filePath = join(directory, `${id}${extension}`);

  if (dirname(resolve(filePath)) !== resolve(directory)) {
    throw internalError('Не удалось определить путь для загруженного файла');
  }

  await mkdir(directory, { recursive: true });
  await writeFile(filePath, data, { flag: 'wx' });

  return filePath;
}

/** Удаляет файл материала; отсутствие файла ошибкой не считается. */
async function removeUpload(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw internalError('Не удалось удалить файл материала', { cause: error });
    }
  }
}

/**
 * Безопасное имя файла для хранения и показа: от пути остаётся только последний
 * сегмент, разделители каталогов и управляющие символы отбрасываются.
 */
export function safeFileName(fileName: string | null | undefined): string | null {
  if (fileName === null || fileName === undefined) {
    return null;
  }

  const lastSegment = basename(fileName.replace(/\\/g, '/'));
  const cleaned = [...lastSegment]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;

      return code > 0x1f && code !== 0x7f && character !== '/';
    })
    .join('')
    .replace(/^\.+/, '')
    .trim();

  return truncate(cleaned, MAX_FILE_NAME_LENGTH);
}

/** Название материала по имени файла. */
function titleFromFileName(fileName: string | null): string {
  if (fileName === null) {
    return FALLBACK_TITLE;
  }

  const withoutExtension = fileName.slice(0, fileName.length - extname(fileName).length).trim();

  return withoutExtension.length > 0 ? withoutExtension : FALLBACK_TITLE;
}

/** Название материала по первой непустой строке вставленного текста. */
function titleFromText(text: string): string {
  const firstLine = text
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
    .find((line) => line.length > 0);

  return firstLine === undefined ? FALLBACK_TITLE : firstLine.slice(0, 80);
}

/** Обрезает строку до предела контракта; пустая строка превращается в `null`. */
function truncate(value: string | null, limit: number): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim().slice(0, limit).trim();

  return trimmed.length === 0 ? null : trimmed;
}
