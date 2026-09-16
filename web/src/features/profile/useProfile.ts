/**
 * Загрузка и сохранение профиля через TanStack Query.
 *
 * Профиль читают и другие разделы (план урока, подбор материалов), поэтому
 * ключи запросов вынесены в фабрику `profileQueryKeys`: первый элемент —
 * namespace фичи (`['profile', ...]`), как и у остальных разделов.
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
} from '@tanstack/react-query';
import { useCallback } from 'react';

import type { LearnerProfile, UpdateProfileRequest } from '@lt/shared';

import { ApiError } from '../../api/client';
import { fetchProfile, updateProfile } from '../../api/profile';

/** Корень ключей запросов фичи: по нему инвалидируется весь раздел. */
export const PROFILE_QUERY_KEY = ['profile'] as const;

/** Ключи запросов профиля. */
export const profileQueryKeys = {
  /** Весь раздел целиком. */
  all: PROFILE_QUERY_KEY,
  /** Профиль ученика; в разделе он один, поэтому ключ совпадает с корнем. */
  detail: () => PROFILE_QUERY_KEY,
};

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

/** Профиль ученика и состояние его загрузки. */
export interface UseProfileResult {
  /** Профиль с сервера; `null` — ещё не загружен или запрос не удался. */
  profile: LearnerProfile | null;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: ApiError | null;
  refetch: () => void;
}

/**
 * Профиль ученика.
 *
 * Форма результата — общая для всех хуков данных приложения: плоский DTO
 * с `isLoading`/`isFetching`/`isError`/`error`/`refetch`, а не сырой
 * `UseQueryResult`. Иначе одно и то же состояние «идёт первая загрузка»
 * называлось бы на странице профиля иначе, чем на остальных страницах.
 */
export function useProfile(): UseProfileResult {
  const { data, error, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: profileQueryKeys.detail(),
    queryFn: ({ signal }) => fetchProfile(signal),
  });

  const refresh = useCallback((): void => {
    void refetch();
  }, [refetch]);

  return {
    profile: data ?? null,
    isLoading,
    isFetching,
    isError,
    error: error ? ApiError.from(error) : null,
    refetch: refresh,
  };
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
      await queryClient.cancelQueries({ queryKey: profileQueryKeys.all });

      const previous = queryClient.getQueryData<LearnerProfile>(profileQueryKeys.detail());

      if (previous) {
        queryClient.setQueryData<LearnerProfile>(
          profileQueryKeys.detail(),
          applyProfileChanges(previous, changes),
        );
      }

      return { previous };
    },
    onError: (_error, _changes, context) => {
      if (context?.previous) {
        queryClient.setQueryData<LearnerProfile>(profileQueryKeys.detail(), context.previous);
      }
    },
    onSuccess: (profile) => {
      queryClient.setQueryData<LearnerProfile>(profileQueryKeys.detail(), profile);
    },
  });
}
