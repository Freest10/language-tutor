/**
 * Обращения к профилю ученика: `GET /api/profile` и `PUT /api/profile`.
 *
 * Модуль — единственное место, где страница профиля знает про HTTP: схемы
 * `@lt/shared` проверяют и ответ сервера, и тело запроса перед отправкой,
 * поэтому в интерфейс не попадут данные, не соответствующие контракту.
 *
 * Тело `PUT` частичное: передаются только изменённые поля, и хотя бы одно
 * (`updateProfileRequestSchema` с `.refine`). `levelConfidence` вручную
 * не обновляется — его пересчитывает сервер.
 */
import {
  getProfileResponseSchema,
  updateProfileRequestSchema,
  updateProfileResponseSchema,
  type LearnerProfile,
  type UpdateProfileRequest,
} from '@lt/shared';

import { api, clientValidationError } from './client';

/** Путь профиля внутри API; префикс `/api` подставляет клиент. */
export const PROFILE_PATH = '/profile';

/** Профиль ученика целиком. Профиль существует всегда: 404 у маршрута не бывает. */
export function fetchProfile(signal?: AbortSignal): Promise<LearnerProfile> {
  return api.get(PROFILE_PATH, { schema: getProfileResponseSchema, signal });
}

/**
 * Проверяет тело `PUT /api/profile` схемой `@lt/shared` до отправки.
 *
 * @throws ApiError если изменения не соответствуют контракту.
 */
export function parseProfileUpdate(changes: UpdateProfileRequest): UpdateProfileRequest {
  const result = updateProfileRequestSchema.safeParse(changes);

  if (!result.success) {
    throw clientValidationError(
      'Изменения профиля не прошли проверку схемы на клиенте',
      result.error.issues,
    );
  }

  return result.data;
}

/** Сохраняет изменённые поля профиля и отдаёт профиль целиком. */
export async function updateProfile(
  changes: UpdateProfileRequest,
  signal?: AbortSignal,
): Promise<LearnerProfile> {
  return api.put(PROFILE_PATH, parseProfileUpdate(changes), {
    schema: updateProfileResponseSchema,
    signal,
  });
}
