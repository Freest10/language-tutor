/**
 * Профиль ученика.
 *
 * - `GET /api/profile` — профиль целиком; он существует всегда (строку-заготовку
 *   создаёт миграция), поэтому 404 у этого маршрута не бывает;
 * - `PUT /api/profile` — частичное обновление: языки, уровень, цели, интересы,
 *   дневная норма. Хотя бы одно поле обязательно (`updateProfileRequestSchema`).
 *
 * Правила (ручная смена уровня пишется в историю, смена изучаемого языка сбрасывает
 * уверенность и признак пройденного определения уровня) живут в `profileService`.
 */
import type { FastifyPluginAsync } from 'fastify';

import {
  getProfileResponseSchema,
  updateProfileRequestSchema,
  updateProfileResponseSchema,
  type GetProfileResponse,
  type UpdateProfileResponse,
} from '@lt/shared';

import { parseBody } from '../lib/validate.js';
import { getProfile, updateProfile } from '../services/profileService.js';

/** Профиль ученика. */
export const profileRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/profile',
    { schema: { response: { 200: getProfileResponseSchema } } },
    (): GetProfileResponse => getProfile(),
  );

  app.put(
    '/profile',
    { schema: { response: { 200: updateProfileResponseSchema } } },
    (request): UpdateProfileResponse =>
      updateProfile(parseBody(request, updateProfileRequestSchema)),
  );
};
