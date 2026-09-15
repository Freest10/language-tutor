/**
 * Настройки HTTP-клиента: база адресов, таймауты и сборка URL.
 *
 * Отделены от `client.ts`, чтобы их можно было импортировать из кода,
 * который сам запросов не делает (например, `<audio src={buildApiUrl(...)}>`).
 */
import { API_PREFIX } from '@lt/shared';

/** Переопределение базы адресов на случай нестандартного размещения API. */
const envBaseUrl: unknown = import.meta.env.VITE_API_BASE_URL;

/** Убирает завершающий слэш, чтобы склейка с путём не давала `//`. */
function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** База всех адресов API: в dev её проксирует Vite на сервер Fastify. */
export const API_BASE_URL = normalizeBaseUrl(
  typeof envBaseUrl === 'string' && envBaseUrl.length > 0 ? envBaseUrl : API_PREFIX,
);

/** Таймаут обычного запроса: локальный сервер отвечает быстро. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Таймаут запроса, за которым стоит внешняя модель (LLM, STT, TTS). */
export const LONG_TIMEOUT_MS = 120_000;

/** Таймаут загрузки файла: ограничен размером материала, а не скоростью модели. */
export const UPLOAD_TIMEOUT_MS = 60_000;

/** Скалярное значение query-параметра; `null` и `undefined` не отправляются. */
export type QueryValue = string | number | boolean | null | undefined;

/** Query-параметры запроса; массив разворачивается в повторяющийся ключ. */
export type QueryParams = Record<string, QueryValue | readonly QueryValue[]>;

/** Собирает строку query, пропуская пустые значения. */
export function buildQueryString(query: QueryParams | undefined): string {
  if (!query) {
    return '';
  }

  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value as QueryValue];

    for (const item of values) {
      if (item !== null && item !== undefined) {
        search.append(key, String(item));
      }
    }
  }

  const serialized = search.toString();

  return serialized.length > 0 ? `?${serialized}` : '';
}

/**
 * Полный адрес эндпоинта API.
 *
 * @param path путь внутри API, начиная со слэша: `/lessons/42`.
 * @param query необязательные query-параметры.
 */
export function buildApiUrl(path: string, query?: QueryParams): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  return `${API_BASE_URL}${normalizedPath}${buildQueryString(query)}`;
}
