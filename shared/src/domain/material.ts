/** Учебные материалы пользователя и результат извлечения из них текста. */
import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from '../api/common.js';

import { cefrLevelSchema, languageCodeSchema } from './language.js';

/**
 * Откуда взят материал:
 * - `pdf` — загруженный PDF-файл;
 * - `txt` — загруженный текстовый файл (`text/plain`, `text/markdown`);
 * - `text` — текст, вставленный пользователем в форму.
 */
export const MATERIAL_SOURCE_TYPES = ['pdf', 'txt', 'text'] as const;

/** Откуда взят материал. */
export type MaterialSourceType = (typeof MATERIAL_SOURCE_TYPES)[number];

/** Откуда взят материал. */
export const materialSourceTypeSchema = z.enum(MATERIAL_SOURCE_TYPES);

/**
 * Состояние извлечения текста из материала.
 *
 * Допущение A16: у неудачи всегда машиночитаемая причина, а не свободный текст.
 * `error_no_text_layer` — это как раз скан PDF без текстового слоя.
 */
export const MATERIAL_STATUSES = [
  'pending',
  'processing',
  'ready',
  'error_no_text_layer',
  'error_unsupported_format',
  'error_too_large',
  'error_extraction_failed',
] as const;

/** Состояние извлечения текста из материала. */
export type MaterialStatus = (typeof MATERIAL_STATUSES)[number];

/** Состояние извлечения текста из материала. */
export const materialStatusSchema = z.enum(MATERIAL_STATUSES);

/** Подмножество статусов, означающих неудачу извлечения текста. */
export const MATERIAL_ERROR_STATUSES = [
  'error_no_text_layer',
  'error_unsupported_format',
  'error_too_large',
  'error_extraction_failed',
] as const;

/** Статус неудачного извлечения текста. */
export type MaterialErrorStatus = (typeof MATERIAL_ERROR_STATUSES)[number];

/** Проверяет, что материал непригоден к использованию из-за ошибки извлечения. */
export function isMaterialErrorStatus(status: MaterialStatus): status is MaterialErrorStatus {
  return (MATERIAL_ERROR_STATUSES as readonly string[]).includes(status);
}

/**
 * Предел размера файла по умолчанию, 20 МиБ.
 *
 * Это значение клиента на время, пока не получен `GET /api/config`: сервер
 * применяет собственный предел из `MAX_UPLOAD_MB` и сообщает его в
 * `limits.maxMaterialUploadBytes`. Не используйте константу как потолок —
 * именно так здесь когда-то стоял `Math.min`, из-за которого предел нельзя
 * было поднять через окружение.
 */
export const MAX_MATERIAL_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Предел текста, вставленного в форму вручную, 200 000 символов.
 *
 * Относится только к полю «вставить текст» (`createTextMaterialRequestSchema`).
 * Текст, ИЗВЛЕЧЁННЫЙ из файла, ограничен отдельно и настраивается на сервере
 * через `MAX_MATERIAL_TEXT_CHARS`: книга в PDF весит немного, но
 * разворачивается в миллионы символов.
 */
export const MAX_MATERIAL_TEXT_LENGTH = 200_000;

/** MIME-типы, принимаемые при загрузке материала. */
export const MATERIAL_SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
] as const;

/** Учебный материал пользователя. */
export const materialSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(200),
  sourceType: materialSourceTypeSchema,
  status: materialStatusSchema,
  /** Человекочитаемое пояснение к статусу; обязательно заполняется для `error_*`. */
  statusMessage: z.string().trim().max(500).nullish(),
  originalFileName: z.string().trim().max(255).nullish(),
  mimeType: z.string().trim().max(120).nullish(),
  sizeBytes: z.int().nonnegative().nullish(),
  language: languageCodeSchema,
  /** Оценка сложности материала по CEFR; `null`, пока не определена. */
  level: cefrLevelSchema.nullish(),
  charCount: z.int().nonnegative(),
  chunkCount: z.int().nonnegative(),
  /**
   * Сколько фрагментов материала уже отработано на уроках, 0..`chunkCount`.
   *
   * Отработанным считается фрагмент, попавший в шаг плана со статусом `completed`
   * (см. `findCoveredChunkIds()` на сервере). Значение считается по урокам, а не
   * хранится в материале, поэтому у поля есть значение по умолчанию: источник,
   * который его не заполняет, отдаёт «ничего не пройдено».
   */
  coveredChunkCount: z.int().min(0).default(0),
  pageCount: z.int().nonnegative().nullish(),
  /** Ключевые темы материала, извлечённые при обработке. */
  topics: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  summary: z.string().trim().max(2000).nullish(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/** Учебный материал пользователя. */
export type Material = z.infer<typeof materialSchema>;

/** Фрагмент материала: единица, которой оперируют планировщик урока и тьютор. */
export const materialChunkSchema = z.object({
  id: idSchema,
  materialId: idSchema,
  /** Порядковый номер фрагмента внутри материала, с нуля. */
  order: z.int().nonnegative(),
  content: z.string().min(1),
  charCount: z.int().nonnegative(),
  /** Страница PDF, с которой начинается фрагмент. */
  page: z.int().positive().nullish(),
  heading: z.string().trim().max(200).nullish(),
  createdAt: isoDateTimeSchema,
});

/** Фрагмент материала. */
export type MaterialChunk = z.infer<typeof materialChunkSchema>;
