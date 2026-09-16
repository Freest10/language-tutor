/**
 * Каркас веба: маршруты, переключение языка интерфейса и разбор ошибок API.
 *
 * Запросы к серверу подменяются: тест проверяет поведение каркаса,
 * а не доступность бэкенда.
 */
import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_PREFIX,
  APP_NAME,
  DEFAULT_CEFR_LEVEL,
  DEFAULT_DAILY_MINUTES,
  KNOWN_LANGUAGE_CODES,
  LANGUAGE_LABELS,
  type AppConfig,
  type ApiErrorResponse,
} from '@lt/shared';

import { App } from '../src/App';
import { ApiError, api } from '../src/api/client';
import { detectInitialLocale, i18n, LOCALE_STORAGE_KEY } from '../src/i18n';
import { routes } from '../src/router';

/** Конфигурация, которую обычно отдаёт `GET /api/config`. */
const CONFIG_FIXTURE: AppConfig = {
  appName: APP_NAME,
  apiPrefix: API_PREFIX,
  version: '0.1.0',
  configSource: 'env',
  llm: { available: true, model: 'qwen2.5', reason: null },
  stt: {
    provider: 'browser',
    available: true,
    model: null,
    requiresWav16: false,
    reason: 'Распознаёт браузер',
  },
  tts: {
    provider: 'browser',
    available: true,
    model: null,
    voice: null,
    formats: [],
    reason: null,
  },
  supportedLanguages: KNOWN_LANGUAGE_CODES.map((code) => ({ code, ...LANGUAGE_LABELS[code] })),
  defaults: {
    learningLanguage: 'en',
    interfaceLanguage: 'ru',
    explanationLanguage: 'ru',
    level: DEFAULT_CEFR_LEVEL,
    dailyMinutes: DEFAULT_DAILY_MINUTES,
  },
  limits: {
    maxMaterialUploadBytes: 10_485_760,
    maxMaterialTextLength: 200_000,
    maxAudioUploadBytes: 26_214_400,
    maxTtsTextLength: 4_000,
    maxPageSize: 100,
  },
};

/** Конверт ошибки, которым отвечают ещё не реализованные маршруты сервера. */
const NOT_CONFIGURED_BODY: ApiErrorResponse = {
  error: {
    code: 'not_configured',
    message: 'Маршрут ещё не реализован',
    details: { reason: 'not_implemented', endpoint: 'GET /api/lessons' },
  },
};

/** Ответ с телом-JSON. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Подменяет `fetch` обработчиком, который отвечает по адресу запроса. */
function stubFetch(handler: (url: string) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => Promise.resolve(handler(String(input)))),
  );
}

/** Поднимает приложение на маршрутах в памяти, без истории браузера. */
function renderApp(initialPath = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] });

  return {
    user: userEvent.setup(),
    ...render(<App router={router} queryClient={queryClient} />),
  };
}

beforeEach(async () => {
  window.localStorage.clear();
  await i18n.changeLanguage('en');
  stubFetch(() => jsonResponse(CONFIG_FIXTURE));
});

afterEach(() => {
  // При `globals: false` автоматической очистки DOM нет — убираем её вручную.
  cleanup();
  vi.unstubAllGlobals();
});

describe('маршруты', () => {
  const cases: ReadonlyArray<[path: string, headingKey: string]> = [
    ['/', 'home.title'],
    ['/profile', 'profile:title'],
    ['/placement', 'placement:title'],
    ['/materials', 'materials:title'],
    ['/lessons', 'lessons:title'],
    ['/lessons/l-1/plan', 'lessons:plan.title'],
    ['/lessons/l-1/room', 'lessonRoom:title'],
    ['/progress', 'progress:title'],
  ];

  it.each(cases)('отрисовывает %s', async (path, headingKey) => {
    const { unmount } = renderApp(path);

    expect(
      await screen.findByRole('heading', { level: 1, name: i18n.t(headingKey) }),
    ).toBeInTheDocument();

    unmount();
  });

  it('показывает страницу «не найдено» для неизвестного адреса', async () => {
    renderApp('/unknown-section');

    expect(
      await screen.findByRole('heading', { level: 1, name: i18n.t('page.notFound.title') }),
    ).toBeInTheDocument();
  });

  it('переходит в раздел по ссылке навигации', async () => {
    const { user } = renderApp('/');

    await user.click(screen.getByRole('link', { name: i18n.t('nav.profile') }));

    expect(
      await screen.findByRole('heading', { level: 1, name: i18n.t('profile:title') }),
    ).toBeInTheDocument();
  });

  it('помечает активный пункт навигации', async () => {
    renderApp('/materials');

    const link = await screen.findByRole('link', { name: i18n.t('nav.materials') });

    expect(link).toHaveAttribute('aria-current', 'page');
  });
});

describe('язык интерфейса', () => {
  it('переключает подписи навигации и запоминает выбор', async () => {
    const { user } = renderApp('/');
    const select = await screen.findByLabelText(i18n.t('language.label'));

    expect(screen.getByRole('link', { name: 'Profile' })).toBeInTheDocument();

    await user.selectOptions(select, 'ru');

    expect(await screen.findByRole('link', { name: 'Профиль' })).toBeInTheDocument();
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ru');
    // После перезагрузки страницы определение языка вернёт сохранённый выбор.
    expect(detectInitialLocale()).toBe('ru');
  });

  it('склоняет счётные существительные по правилам языка', () => {
    expect(i18n.t('units.errors', { count: 1, lng: 'ru' })).toBe('1 ошибка');
    expect(i18n.t('units.errors', { count: 3, lng: 'ru' })).toBe('3 ошибки');
    expect(i18n.t('units.errors', { count: 5, lng: 'ru' })).toBe('5 ошибок');
    expect(i18n.t('units.errors', { count: 21, lng: 'ru' })).toBe('21 ошибка');
    expect(i18n.t('units.errors', { count: 2, lng: 'en' })).toBe('2 errors');
  });
});

describe('ApiError', () => {
  it('разбирает конверт ошибки сервера в поля code и message', async () => {
    stubFetch(() => jsonResponse(NOT_CONFIGURED_BODY, 501));

    const error = await api.get('/lessons').catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'not_configured',
      message: NOT_CONFIGURED_BODY.error.message,
      status: 501,
      details: { reason: 'not_implemented', endpoint: 'GET /api/lessons' },
    });
    expect((error as ApiError).isNotConfigured).toBe(true);
  });

  it('превращает недоступность сервера в ApiError без статуса', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    const error = await api.get('/config').catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isNetworkError).toBe(true);
    expect((error as ApiError).status).toBe(0);
  });

  it('не роняет страницу, если конфигурация отвечает заглушкой 501', async () => {
    stubFetch(() => jsonResponse(NOT_CONFIGURED_BODY, 501));

    renderApp('/');

    expect(
      await screen.findByRole('heading', { level: 1, name: i18n.t('home.title') }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText(i18n.t('errors.byCode.not_configured')).length).toBeGreaterThan(0);
  });
});
