/**
 * Загрузка и сохранение профиля через TanStack Query.
 *
 * Профиль читают и другие разделы (план урока, подбор материалов), поэтому
 * ключ запроса вынесен в константу: первый элемент — namespace фичи (`profile`),
 * как договорено для параллельно разрабатываемых страниц.
 *
 * Сохранение оптимистичное: интерфейс показывает новое значение сразу, а при
 * отказе сервера кэш возвращается к прежнему профилю — форма при этом
 * перечитывает значения и пользователь видит, что изменения не применились.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import type { LearnerProfile, UpdateProfileRequest } from '@lt/shared';

import type { ApiError } from '../../api/client';
import { fetchProfile, updateProfile } from '../../api/profile';

/** Ключ запроса профиля: `['profile']`. */
export const PROFILE_QUERY_KEY = ['profile'] as const;

/** Снимок профиля до оптимистичного обновления — к нему откатывается кэш. */
export interface ProfileMutationContext {
  /** Профиль из кэша до мутации; `undefined` — его там не было. */
  previous: LearnerProfile | undefined;
}

/** Применяет частичные изменения к профилю: основа оптимистичного обновления. */
export function applyProfileChanges(
  profile: LearnerProfile,
  changes: UpdateProfileRequest,
): LearnerProfile {
  return {
    ...profile,
    learningLanguage: changes.learningLanguage ?? profile.learningLanguage,
    interfaceLanguage: changes.interfaceLanguage ?? profile.interfaceLanguage,
    explanationLanguage: changes.explanationLanguage ?? profile.explanationLanguage,
    level: changes.level ?? profile.level,
    goals: changes.goals ?? profile.goals,
    interests: changes.interests ?? profile.interests,
    dailyMinutes: changes.dailyMinutes ?? profile.dailyMinutes,
  };
}

/** Профиль ученика: состояние загрузки, ошибка и повторный запрос. */
export function useProfile(): UseQueryResult<LearnerProfile, ApiError> {
  return useQuery<LearnerProfile, ApiError>({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: ({ signal }) => fetchProfile({ signal }),
  });
}

/**
 * Сохранение изменённых полей профиля с оптимистичным обновлением кэша.
 *
 * Успешный ответ содержит профиль целиком (в том числе пересчитанный сервером
 * `levelConfidence`), поэтому кэш заполняется ответом, а не склейкой на клиенте.
 */
export function useUpdateProfile(): UseMutationResult<
  LearnerProfile,
  ApiError,
  UpdateProfileRequest,
  ProfileMutationContext
> {
  const queryClient = useQueryClient();

  return useMutation<LearnerProfile, ApiError, UpdateProfileRequest, ProfileMutationContext>({
    mutationFn: (changes) => updateProfile(changes),
    onMutate: async (changes) => {
      // Иначе ответ уже идущего GET перезапишет оптимистичное значение.
      await queryClient.cancelQueries({ queryKey: PROFILE_QUERY_KEY });

      const previous = queryClient.getQueryData<LearnerProfile>(PROFILE_QUERY_KEY);

      if (previous) {
        queryClient.setQueryData<LearnerProfile>(
          PROFILE_QUERY_KEY,
          applyProfileChanges(previous, changes),
        );
      }

      return { previous };
    },
    onError: (_error, _changes, context) => {
      if (context?.previous) {
        queryClient.setQueryData<LearnerProfile>(PROFILE_QUERY_KEY, context.previous);
      }
    },
    onSuccess: (profile) => {
      queryClient.setQueryData<LearnerProfile>(PROFILE_QUERY_KEY, profile);
    },
  });
}
