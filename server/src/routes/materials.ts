/**
 * Учебные материалы: загрузка файла или текста, список, просмотр, удаление.
 *
 * - `GET /api/materials` — список с фильтрами и пагинацией;
 * - `POST /api/materials` — `multipart/form-data` с частью `file` либо JSON с текстом;
 * - `GET /api/materials/:id` — материал и страница его фрагментов;
 * - `DELETE /api/materials/:id` — материал, фрагменты и файл с диска.
 *
 * Текст извлекается синхронно: ответ на загрузку уже содержит финальный статус
 * материала (`ready` или `error_*`). Неудача извлечения — это не ошибка HTTP:
 * 2xx с `status: 'error_*'` и пояснением в `statusMessage` (A16).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  createMaterialResponseSchema,
  createTextMaterialRequestSchema,
  deleteMaterialResponseSchema,
  getMaterialQuerySchema,
  getMaterialResponseSchema,
  listMaterialsQuerySchema,
  listMaterialsResponseSchema,
  materialParamsSchema,
  MATERIAL_FILE_FIELD_NAME,
  uploadMaterialFieldsSchema,
  type CreateMaterialResponse,
  type DeleteMaterialResponse,
  type GetMaterialResponse,
  type ListMaterialsResponse,
} from '@lt/shared';

import { badRequest, payloadTooLarge } from '../lib/httpErrors.js';
import { parseParams, parseQuery, parseWith } from '../lib/validate.js';
import {
  createMaterialFromFile,
  createMaterialFromText,
  deleteMaterial,
  getMaterial,
  listMaterials,
  MAX_UPLOAD_BYTES,
} from '../services/materialService.js';

/** Код ошибки `@fastify/multipart` о превышении предела размера файла. */
const FILE_TOO_LARGE_CODE = 'FST_REQ_FILE_TOO_LARGE';

/** Разобранный multipart-запрос: файл части `file` и текстовые поля. */
interface MultipartUpload {
  data: Buffer;
  fileName: string | null;
  mimeType: string | null;
  fields: Record<string, string>;
}

/** Ошибка `@fastify/multipart` о слишком большом файле. */
function isFileTooLarge(error: unknown): boolean {
  return (error as { code?: unknown }).code === FILE_TOO_LARGE_CODE;
}

/**
 * Читает части multipart-запроса.
 *
 * Части перебираются подряд, поэтому текстовые поля учитываются независимо от того,
 * идут они до файла или после. Лишние файловые части вычитываются и отбрасываются:
 * непрочитанный поток остановил бы разбор запроса.
 */
async function readUpload(request: FastifyRequest): Promise<MultipartUpload> {
  const fields: Record<string, string> = {};
  let upload: Omit<MultipartUpload, 'fields'> | undefined;

  try {
    for await (const part of request.parts({ limits: { fileSize: MAX_UPLOAD_BYTES } })) {
      if (part.type === 'field') {
        fields[part.fieldname] = String(part.value);
        continue;
      }

      const data = await part.toBuffer();

      if (part.fieldname === MATERIAL_FILE_FIELD_NAME && upload === undefined) {
        upload = {
          data,
          fileName: part.filename === '' ? null : part.filename,
          mimeType: part.mimetype === '' ? null : part.mimetype,
        };
      }
    }
  } catch (error) {
    if (isFileTooLarge(error)) {
      throw payloadTooLarge(
        `Файл больше допустимых ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} МиБ`,
        { cause: error },
      );
    }

    throw error;
  }

  if (upload === undefined) {
    throw badRequest(`Не передан файл: ожидается часть запроса «${MATERIAL_FILE_FIELD_NAME}»`);
  }

  return { ...upload, fields };
}

/** Создаёт материал из загруженного файла. */
async function createFromUpload(request: FastifyRequest): Promise<CreateMaterialResponse> {
  const upload = await readUpload(request);
  const fields = parseWith(uploadMaterialFieldsSchema, upload.fields, 'body');

  return createMaterialFromFile({
    data: upload.data,
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    ...(fields.title === undefined ? {} : { title: fields.title }),
    ...(fields.language === undefined ? {} : { language: fields.language }),
  });
}

/** Создаёт материал из текста, вставленного пользователем. */
async function createFromText(request: FastifyRequest): Promise<CreateMaterialResponse> {
  const body = parseWith(createTextMaterialRequestSchema, request.body ?? {}, 'body');

  return createMaterialFromText({
    text: body.text,
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.language === undefined ? {} : { language: body.language }),
  });
}

/** Маршруты учебных материалов. */
export const materialsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/materials',
    { schema: { response: { 200: listMaterialsResponseSchema } } },
    (request): ListMaterialsResponse =>
      listMaterials(parseQuery(request, listMaterialsQuerySchema)),
  );

  app.post(
    '/materials',
    { schema: { response: { 201: createMaterialResponseSchema } } },
    async (request, reply): Promise<CreateMaterialResponse> => {
      const material = request.isMultipart()
        ? await createFromUpload(request)
        : await createFromText(request);

      reply.status(201);

      return material;
    },
  );

  app.get(
    '/materials/:id',
    { schema: { response: { 200: getMaterialResponseSchema } } },
    (request): GetMaterialResponse =>
      getMaterial(
        parseParams(request, materialParamsSchema).id,
        parseQuery(request, getMaterialQuerySchema),
      ),
  );

  app.delete(
    '/materials/:id',
    { schema: { response: { 200: deleteMaterialResponseSchema } } },
    async (request): Promise<DeleteMaterialResponse> => {
      await deleteMaterial(parseParams(request, materialParamsSchema).id);

      return { ok: true };
    },
  );
};
