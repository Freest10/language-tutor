/**
 * Обращения к `/api/materials`: список, просмотр, загрузка файла, вставка текста, удаление.
 *
 * Модуль знает только про HTTP и схемы `@lt/shared`; кэш, инвалидация и состояния
 * интерфейса живут в `features/materials/useMaterials.ts`.
 *
 * Допущение A7: поддерживаются только TXT, MD и PDF, а также текст, вставленный
 * руками. DOCX не принимается ни сервером, ни проверкой на клиенте.
 */
import {
  createMaterialResponseSchema,
  deleteMaterialResponseSchema,
  getMaterialResponseSchema,
  listMaterialsResponseSchema,
  MATERIAL_FILE_FIELD_NAME,
  MATERIAL_SUPPORTED_MIME_TYPES,
  type CreateMaterialResponse,
  type CreateTextMaterialRequest,
  type DeleteMaterialResponse,
  type GetMaterialResponse,
  type LanguageCode,
  type ListMaterialsResponse,
  type MaterialSourceType,
  type MaterialStatus,
} from '@lt/shared';

import { api } from './client';

/** Путь коллекции материалов (без префикса `/api` — его добавляет клиент). */
export const MATERIALS_PATH = '/materials';

/** Путь конкретного материала. */
export function materialPath(materialId: string): string {
  return `${MATERIALS_PATH}/${encodeURIComponent(materialId)}`;
}

/** Расширения файлов, которые принимает сервер (A7: docx в списке нет). */
export const MATERIAL_FILE_EXTENSIONS = ['.txt', '.md', '.pdf'] as const;

/** Значение атрибута `accept` для поля выбора файла. */
export const MATERIAL_FILE_ACCEPT = [
  ...MATERIAL_SUPPORTED_MIME_TYPES,
  ...MATERIAL_FILE_EXTENSIONS,
].join(',');

/** Почему файл отклонён ещё до отправки на сервер. */
export type MaterialFileRejection = 'unsupported_format' | 'too_large' | 'empty';

/**
 * Проверяет файл до отправки: формат, пустоту и размер.
 *
 * Решает расширение, а не `file.type`: браузеры часто не знают MIME-тип `.md`
 * и присылают пустую строку.
 *
 * @param file выбранный или перетащенный файл.
 * @param maxBytes предел размера из `GET /api/config` (`limits.maxMaterialUploadBytes`).
 * @returns причину отказа или `null`, если файл можно отправлять.
 */
export function materialFileRejection(file: File, maxBytes: number): MaterialFileRejection | null {
  const name = file.name.toLowerCase();

  if (!MATERIAL_FILE_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return 'unsupported_format';
  }

  if (file.size === 0) {
    return 'empty';
  }

  if (file.size > maxBytes) {
    return 'too_large';
  }

  return null;
}

/** Параметры списка материалов; пустые значения в query не уходят. */
export interface ListMaterialsParams {
  limit?: number;
  offset?: number;
  status?: MaterialStatus;
  sourceType?: MaterialSourceType;
  language?: LanguageCode;
  search?: string;
}

/** `GET /api/materials` — страница списка материалов. */
export function listMaterials(
  params: ListMaterialsParams = {},
  signal?: AbortSignal,
): Promise<ListMaterialsResponse> {
  return api.get(MATERIALS_PATH, {
    query: {
      limit: params.limit,
      offset: params.offset,
      status: params.status,
      sourceType: params.sourceType,
      language: params.language,
      search: params.search,
    },
    schema: listMaterialsResponseSchema,
    signal,
  });
}

/** Параметры просмотра материала: пагинация относится к его фрагментам. */
export interface GetMaterialParams {
  limit?: number;
  offset?: number;
}

/** `GET /api/materials/:id` — материал и страница его фрагментов. */
export function getMaterial(
  materialId: string,
  params: GetMaterialParams = {},
  signal?: AbortSignal,
): Promise<GetMaterialResponse> {
  return api.get(materialPath(materialId), {
    query: { limit: params.limit, offset: params.offset },
    schema: getMaterialResponseSchema,
    signal,
  });
}

/** `POST /api/materials` с телом-JSON: пользователь вставил текст руками. */
export function createTextMaterial(
  body: CreateTextMaterialRequest,
  signal?: AbortSignal,
): Promise<CreateMaterialResponse> {
  return api.post(MATERIALS_PATH, body, {
    schema: createMaterialResponseSchema,
    signal,
  });
}

/** Файл материала и необязательные текстовые поля запроса. */
export interface UploadMaterialInput {
  file: File;
  title?: string;
  language?: LanguageCode;
}

/** Собирает multipart-тело: файл идёт частью с именем `file`. */
export function buildMaterialFormData(input: UploadMaterialInput): FormData {
  const form = new FormData();

  form.append(MATERIAL_FILE_FIELD_NAME, input.file, input.file.name);

  if (input.title) {
    form.append('title', input.title);
  }

  if (input.language) {
    form.append('language', input.language);
  }

  return form;
}

/** `POST /api/materials` в варианте `multipart/form-data`: загрузка файла. */
export function uploadMaterial(
  input: UploadMaterialInput,
  signal?: AbortSignal,
): Promise<CreateMaterialResponse> {
  return api.upload(MATERIALS_PATH, buildMaterialFormData(input), {
    schema: createMaterialResponseSchema,
    signal,
  });
}

/** `DELETE /api/materials/:id` — удаление материала вместе с его фрагментами. */
export function deleteMaterial(
  materialId: string,
  signal?: AbortSignal,
): Promise<DeleteMaterialResponse> {
  return api.delete(materialPath(materialId), {
    schema: deleteMaterialResponseSchema,
    signal,
  });
}
