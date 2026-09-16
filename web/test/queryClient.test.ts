/**
 * Политика повторов TanStack Query.
 *
 * Повтор осмыслен только там, где вторая попытка может пройти: обрыв связи и
 * временная недоступность сервиса (503). Ответ с ошибкой повторять бессмысленно —
 * особенно 501 `not_configured`, который означает выключенного провайдера
 * и не изменится от повторного запроса.
 */
import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiError, type ClientErrorReason } from '../src/api/client';
import {
  createQueryClient,
  DEFAULT_STALE_TIME_MS,
  MAX_QUERY_RETRIES,
  queryClient,
  shouldRetryQuery,
} from '../src/lib/queryClient';

/** Ошибка ответа сервера с заданным кодом и статусом. */
function serverError(code: ApiError['code'], status: number): ApiError {
  return new ApiError({ code, message: `ошибка ${String(status)}`, status });
}

/** Отказ на стороне клиента: обрыв связи или таймаут. */
function clientError(reason: ClientErrorReason): ApiError {
  return new ApiError({
    code: 'upstream_unavailable',
    message: `отказ: ${reason}`,
    status: 0,
    clientReason: reason,
  });
}

const clients: QueryClient[] = [];

/** Клиент запросов, который будет очищен после теста. */
function trackedClient(): QueryClient {
  const client = createQueryClient();

  clients.push(client);

  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.clear();
  }
});

describe('константы политики', () => {
  it('задают два повтора и полминуты свежести', () => {
    expect(MAX_QUERY_RETRIES).toBe(2);
    expect(DEFAULT_STALE_TIME_MS).toBe(30_000);
  });
});

describe('shouldRetryQuery', () => {
  it('повторяет при обрыве связи', () => {
    expect(shouldRetryQuery(0, clientError('network'))).toBe(true);
    expect(shouldRetryQuery(1, clientError('network'))).toBe(true);
  });

  it('повторяет при временной недоступности сервиса (503)', () => {
    expect(shouldRetryQuery(0, serverError('upstream_unavailable', 503))).toBe(true);
  });

  it('перестаёт повторять после MAX_QUERY_RETRIES неудач', () => {
    expect(shouldRetryQuery(MAX_QUERY_RETRIES, clientError('network'))).toBe(false);
    expect(shouldRetryQuery(MAX_QUERY_RETRIES + 5, serverError('upstream_unavailable', 503))).toBe(
      false,
    );
  });

  it('не повторяет выключенного провайдера (501)', () => {
    expect(shouldRetryQuery(0, serverError('not_configured', 501))).toBe(false);
  });

  it('не повторяет отказ проверки запроса (400)', () => {
    expect(shouldRetryQuery(0, serverError('validation_error', 400))).toBe(false);
    expect(shouldRetryQuery(0, serverError('bad_request', 400))).toBe(false);
  });

  it('не повторяет отсутствующий ресурс (404)', () => {
    expect(shouldRetryQuery(0, serverError('not_found', 404))).toBe(false);
  });

  it('не повторяет прочие ответы сервера с ошибкой', () => {
    expect(shouldRetryQuery(0, serverError('internal_error', 500))).toBe(false);
    expect(shouldRetryQuery(0, serverError('upstream_error', 502))).toBe(false);
    expect(shouldRetryQuery(0, serverError('conflict', 409))).toBe(false);
  });

  it('не повторяет таймаут и неразобранный ответ: причина не во временном сбое сети', () => {
    expect(shouldRetryQuery(0, clientError('timeout'))).toBe(false);
    expect(shouldRetryQuery(0, clientError('invalid_response'))).toBe(false);
  });

  it('не повторяет ошибку, которая не пришла от клиента API', () => {
    expect(shouldRetryQuery(0, new Error('обычная ошибка'))).toBe(false);
    expect(shouldRetryQuery(0, 'строка')).toBe(false);
    expect(shouldRetryQuery(0, null)).toBe(false);
    expect(shouldRetryQuery(0, undefined)).toBe(false);
  });
});

describe('createQueryClient', () => {
  it('задаёт настройки запросов по умолчанию', () => {
    const options = trackedClient().getDefaultOptions().queries;

    expect(options?.staleTime).toBe(DEFAULT_STALE_TIME_MS);
    expect(options?.gcTime).toBe(5 * 60_000);
    expect(options?.refetchOnWindowFocus).toBe(false);
    expect(options?.refetchOnReconnect).toBe(true);
  });

  it('не повторяет мутации', () => {
    expect(trackedClient().getDefaultOptions().mutations?.retry).toBe(false);
  });

  it('создаёт независимые экземпляры', () => {
    const first = trackedClient();
    const second = trackedClient();

    expect(first).not.toBe(second);
    expect(first).toBeInstanceOf(QueryClient);
  });

  it('повторяет запрос, оборвавшийся по сети, ровно MAX_QUERY_RETRIES раз', async () => {
    const client = trackedClient();
    let attempts = 0;

    await expect(
      client.fetchQuery({
        queryKey: ['test', 'network'],
        queryFn: () => {
          attempts += 1;

          return Promise.reject(clientError('network'));
        },
        retryDelay: 0,
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(attempts).toBe(MAX_QUERY_RETRIES + 1);
  });

  it('не повторяет запрос к выключенному провайдеру', async () => {
    const client = trackedClient();
    let attempts = 0;

    await expect(
      client.fetchQuery({
        queryKey: ['test', 'not-configured'],
        queryFn: () => {
          attempts += 1;

          return Promise.reject(serverError('not_configured', 501));
        },
        retryDelay: 0,
      }),
    ).rejects.toMatchObject({ code: 'not_configured' });

    expect(attempts).toBe(1);
  });

  it('отдаёт удачный ответ со второй попытки после обрыва связи', async () => {
    const client = trackedClient();
    let attempts = 0;

    const result = await client.fetchQuery({
      queryKey: ['test', 'recovers'],
      queryFn: () => {
        attempts += 1;

        return attempts === 1 ? Promise.reject(clientError('network')) : Promise.resolve('готово');
      },
      retryDelay: 0,
    });

    expect(result).toBe('готово');
    expect(attempts).toBe(2);
  });
});

describe('клиент приложения', () => {
  it('существует в единственном экземпляре с той же политикой', () => {
    expect(queryClient).toBeInstanceOf(QueryClient);
    expect(queryClient.getDefaultOptions().queries?.staleTime).toBe(DEFAULT_STALE_TIME_MS);
    expect(queryClient.getDefaultOptions().queries?.retry).toBe(shouldRetryQuery);
  });
});
