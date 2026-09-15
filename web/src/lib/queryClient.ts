/**
 * Настройки TanStack Query для всего приложения.
 *
 * Приложение локальное и однопользовательское: данные не устаревают сами по себе,
 * поэтому фоновые перезапросы отключены, а повторы делаются только там,
 * где они осмысленны — при обрыве связи и временной недоступности сервиса.
 *
 * Соглашение о ключах запросов: первый элемент — имя namespace фичи
 * (`['lessons', 'list', query]`, `['progress', 'summary']`), чтобы ключи
 * параллельно разрабатываемых страниц не пересекались.
 */
import { QueryClient } from '@tanstack/react-query';

import { isApiError } from '../api/client';

/** Сколько раз повторять запрос, у которого есть шанс пройти со второй попытки. */
export const MAX_QUERY_RETRIES = 2;

/** Данные считаются свежими 30 секунд: повторный переход на страницу не дёргает сервер. */
export const DEFAULT_STALE_TIME_MS = 30_000;

/** Стоит ли повторять запрос: обрыв связи и 503 — да, ответ с ошибкой — нет. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) {
    return false;
  }

  if (!isApiError(error)) {
    return false;
  }

  return error.isNetworkError || error.status === 503;
}

/** Создаёт клиент запросов; отдельный экземпляр удобен в тестах. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_STALE_TIME_MS,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        retry: shouldRetryQuery,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/** Клиент запросов приложения. */
export const queryClient = createQueryClient();
