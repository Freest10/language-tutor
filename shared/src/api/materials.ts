/**
 * Материалы: `GET /api/materials`, `POST /api/materials`,
 * `GET /api/materials/:id`, `DELETE /api/materials/:id`.
 */
import { z } from 'zod';

import {
  idParamSchema,
  okResponseSchema,
  paginatedResponseSchema,
  paginationQuerySchema,
} from './common.js';

import { languageCodeSchema } from '../domain/language.js';
import {
  MAX_MATERIAL_TEXT_LENGTH,
  materialChunkSchema,
  materialSchema,
  materialSourceTypeSchema,
  materialStatusSchema,
} from '../domain/material.js';

/** Query `GET /api/materials`. */
export const listMaterialsQuerySchema = paginationQuerySchema.extend({
  status: materialStatusSchema.optional(),
  sourceType: materialSourceTypeSchema.optional(),
  language: languageCodeSchema.optional(),
  /** Поиск по названию и тексту материала. */
  search: z.string().trim().min(1).max(200).optional(),
});

/** Query `GET /api/materials`. */
export type ListMaterialsQuery = z.infer<typeof listMaterialsQuerySchema>;

/** Ответ `GET /api/materials`. */
export const listMaterialsResponseSchema = paginatedResponseSchema(materialSchema);

/** Ответ `GET /api/materials`. */
export type ListMaterialsResponse = z.infer<typeof listMaterialsResponseSchema>;

/**
 * Тело `POST /api/materials` в варианте `application/json`:
 * пользователь вставил текст вручную.
 */
export const createTextMaterialRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  text: z.string().trim().min(1).max(MAX_MATERIAL_TEXT_LENGTH),
  language: languageCodeSchema.optional(),
});

/** Тело `POST /api/materials` с текстом. */
export type CreateTextMaterialRequest = z.infer<typeof createTextMaterialRequestSchema>;

/**
 * Текстовые поля `POST /api/materials` в варианте `multipart/form-data`:
 * файл передаётся частью с именем `file`.
 */
export const uploadMaterialFieldsSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  language: languageCodeSchema.optional(),
});

/** Текстовые поля загрузки файла материала. */
export type UploadMaterialFields = z.infer<typeof uploadMaterialFieldsSchema>;

/** Имя файловой части multipart-запроса загрузки материала. */
export const MATERIAL_FILE_FIELD_NAME = 'file';

/** Ответ `POST /api/materials`. */
export const createMaterialResponseSchema = materialSchema;

/** Ответ `POST /api/materials`. */
export type CreateMaterialResponse = z.infer<typeof createMaterialResponseSchema>;

/** Параметры маршрутов `/api/materials/:id`. */
export const materialParamsSchema = idParamSchema;

/** Параметры маршрутов материала. */
export type MaterialParams = z.infer<typeof materialParamsSchema>;

/** Query `GET /api/materials/:id`: пагинация относится к фрагментам материала. */
export const getMaterialQuerySchema = paginationQuerySchema;

/** Query `GET /api/materials/:id`. */
export type GetMaterialQuery = z.infer<typeof getMaterialQuerySchema>;

/** Ответ `GET /api/materials/:id`. */
export const getMaterialResponseSchema = z.object({
  material: materialSchema,
  chunks: paginatedResponseSchema(materialChunkSchema),
});

/** Ответ `GET /api/materials/:id`. */
export type GetMaterialResponse = z.infer<typeof getMaterialResponseSchema>;

/** Ответ `DELETE /api/materials/:id`. */
export const deleteMaterialResponseSchema = okResponseSchema;

/** Ответ `DELETE /api/materials/:id`. */
export type DeleteMaterialResponse = z.infer<typeof deleteMaterialResponseSchema>;
