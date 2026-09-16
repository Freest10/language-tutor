/**
 * Профиль ученика: форма по данным сервера, правка целей, откат оптимистичного
 * обновления, клиентская валидация и переключение языка интерфейса.
 *
 * Сервер подменён: тест проверяет поведение страницы по контракту `@lt/shared`,
 * а не доступность бэкенда. Тело `PUT /api/profile` проверяется целиком —
 * важно, что уходит частичное обновление ровно с изменёнными полями.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
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
  type ApiErrorResponse,
  type AppConfig,
  type LearnerProfile,
} from '@lt/shared';

import { App } from '../src/App';
import { ApiError } from '../src/api/client';
import { useProfile } from '../src/features/profile/useProfile';
import { useProgressSummary } from '../src/features/progress/useProgress';
import { i18n, LOCALE_STORAGE_KEY } from '../src/i18n';
import { routes } from '../src/router';

/** Цель, которая уже есть в профиле. */
const SAVED_GOAL = 'Заказать кофе';

/** Цель, которую добавляет пользователь. */
const NEW_GOAL = 'Пройти собеседование';

/** Профиль, который обычно отдаёт `GET /api/profile`. */
const PROFILE_FIXTURE: LearnerProfile = {
  id: 'learner-1',
  learningLanguage: 'en',
  interfaceLanguage: 'en',
  explanationLanguage: 'ru',
  level: 'B1',
  levelConfidence: 0.6,
  goals: [SAVED_GOAL],
  interests: ['Походы в горы'],
  dailyMinutes: 20,
  placementCompletedAt: '2026-09-01T10:00:00.000Z',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
};

/** Конфигурация, которую обычно отдаёт `GET /api/config`. */
const CONFIG_FIXTURE: AppConfig = {
  appName: APP_NAME,
  apiPrefix: API_PREFIX,
  version: '0.1.0',
  configSource: 'env',
  llm: { available: true, model: 'qwen2.5', reason: null },
  stt: { provider: 'browser', available: true, model: null, requiresWav16: false, reason: null },
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

/** Отказ сервера по схеме `@lt/shared`: ещё не реализованный маршрут. */
const NOT_CONFIGURED_BODY: ApiErrorResponse = {
  error: {
    code: 'not_configured',
    message: 'Маршрут ещё не реализован',
    details: { reason: 'not_implemented', endpoint: 'GET /api/profile' },
  },
};

/** Отказ сервера по схеме `@lt/shared`: тело запроса не прошло проверку. */
const VALIDATION_ERROR_BODY: ApiErrorResponse = {
  error: {
    code: 'validation_error',
    message: 'Цель слишком длинная',
    details: { issues: [{ path: ['goals', 1], message: 'too_big' }] },
  },
};

/** Запрос, который перехватил подменённый `fetch`. */
interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

let requests: RecordedRequest[] = [];
let getProfileResponse: () => Response;
let putProfileResponse: (body: unknown) => Response;

/** Ответ с телом-JSON. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Подменяет `fetch` обработчиком профиля и конфигурации. */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;

      requests.push({ method, url, body });

      if (url.endsWith('/config')) {
        return Promise.resolve(jsonResponse(CONFIG_FIXTURE));
      }

      if (url.endsWith('/profile')) {
        return Promise.resolve(method === 'PUT' ? putProfileResponse(body) : getProfileResponse());
      }

      return Promise.resolve(jsonResponse(NOT_CONFIGURED_BODY, 501));
    }),
  );
}

/** Перехваченные запросы на сохранение профиля. */
function putRequests(): RecordedRequest[] {
  return requests.filter((request) => request.method === 'PUT');
}

/** Поднимает приложение на странице профиля, без истории браузера. */
function renderProfile() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: ['/profile'] });

  return {
    user: userEvent.setup(),
    ...render(<App router={router} queryClient={queryClient} />),
  };
}

/** Добавляет цель через поле свободного ввода. */
async function addGoal(user: ReturnType<typeof userEvent.setup>, goal: string): Promise<void> {
  const input = await screen.findByLabelText(i18n.t('profile:goals.addLabel'));

  await user.type(input, goal);
  await user.click(screen.getByRole('button', { name: i18n.t('profile:goals.add') }));
}

/** Кнопка сохранения профиля. */
function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: i18n.t('profile:form.save') });
}

beforeEach(async () => {
  window.localStorage.clear();
  await i18n.changeLanguage('en');
  requests = [];
  getProfileResponse = () => jsonResponse(PROFILE_FIXTURE);
  putProfileResponse = (body) =>
    jsonResponse({
      ...PROFILE_FIXTURE,
      ...(body as Record<string, unknown>),
      updatedAt: '2026-09-16T12:00:00.000Z',
    });
  stubFetch();
});

afterEach(() => {
  // При `globals: false` автоматической очистки DOM нет — убираем её вручную.
  cleanup();
  vi.unstubAllGlobals();
});

describe('состояния данных профиля', () => {
  it('показывает заглушку, пока профиль грузится', async () => {
    renderProfile();

    expect(screen.getByText(i18n.t('profile:states.loading'))).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: i18n.t('profile:form.save') })).toBeVisible();
  });

  it('заполняет форму значениями профиля', async () => {
    renderProfile();

    expect(await screen.findByLabelText(i18n.t('profile:level.label'))).toHaveValue('B1');
    expect(screen.getByLabelText(i18n.t('profile:languages.learning.label'))).toHaveValue('en');
    expect(screen.getByLabelText(i18n.t('profile:languages.explanation.label'))).toHaveValue('ru');
    expect(screen.getByLabelText(i18n.t('profile:dailyMinutes.label'))).toHaveValue(20);
    expect(screen.getByText(SAVED_GOAL)).toBeInTheDocument();
    // Значок уровня: тот же текст есть в списке вариантов, поэтому ищем по тегу.
    expect(
      screen.getByText(
        i18n.t('profile:level.badge', { level: 'B1', name: i18n.t('profile:level.names.B1') }),
        { selector: 'strong' },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(i18n.t('profile:level.confidence', { percent: 60 }))).toBeVisible();
    // Кнопка сохранения недоступна, пока изменений нет.
    expect(saveButton()).toBeDisabled();
  });

  it('показывает ошибку и кнопку повтора, когда профиль отвечает заглушкой 501', async () => {
    getProfileResponse = () => jsonResponse(NOT_CONFIGURED_BODY, 501);

    renderProfile();

    expect(await screen.findByText(i18n.t('profile:states.loadFailed'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('errors.byCode.not_configured'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: i18n.t('actions.retry') })).toBeInTheDocument();
  });
});

describe('контракт хука профиля', () => {
  /** Поднимает хук в клиенте запросов без повторов. */
  function renderDataHook<T>(hook: () => T) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    return renderHook(hook, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
  }

  it('отдаёт тот же плоский DTO, что и остальные хуки данных', async () => {
    const profile = renderDataHook(() => useProfile());
    const progress = renderDataHook(() => useProgressSummary());

    await waitFor(() => {
      expect(profile.result.current.profile).not.toBeNull();
    });

    // Сырой `UseQueryResult` здесь означал бы `isPending` и `.data` вместо
    // `isLoading` и именованного поля — на одной странице из восьми.
    expect(Object.keys(profile.result.current).sort()).toEqual([
      'error',
      'isError',
      'isFetching',
      'isLoading',
      'profile',
      'refetch',
    ]);
    expect(Object.keys(profile.result.current).sort()).toEqual(
      Object.keys(progress.result.current)
        .map((key) => (key === 'summary' ? 'profile' : key))
        .sort(),
    );
    expect(typeof profile.result.current.refetch).toBe('function');
  });

  it('отдаёт отказ как `ApiError`, а не как сырое исключение', async () => {
    getProfileResponse = () => jsonResponse(NOT_CONFIGURED_BODY, 501);

    const { result } = renderDataHook(() => useProfile());

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.error?.code).toBe('not_configured');
    expect(result.current.profile).toBeNull();
  });
});

describe('сохранение профиля', () => {
  it('отправляет PUT с телом из изменённых полей', async () => {
    const { user } = renderProfile();

    await addGoal(user, NEW_GOAL);
    expect(screen.getByText(NEW_GOAL)).toBeInTheDocument();

    await user.click(saveButton());

    await waitFor(() => {
      expect(putRequests()).toHaveLength(1);
    });

    expect(putRequests()[0]?.url).toBe(`${API_PREFIX}/profile`);
    expect(putRequests()[0]?.body).toEqual({ goals: [SAVED_GOAL, NEW_GOAL] });
    expect(await screen.findByText(i18n.t('profile:form.saved'))).toBeInTheDocument();
  });

  it('откатывает оптимистичное обновление, когда сервер отвечает 400', async () => {
    putProfileResponse = () => jsonResponse(VALIDATION_ERROR_BODY, 400);

    const { user } = renderProfile();

    await addGoal(user, NEW_GOAL);
    expect(screen.getByText(NEW_GOAL)).toBeInTheDocument();

    await user.click(saveButton());

    expect(await screen.findByText(i18n.t('profile:form.saveFailed'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('errors.byCode.validation_error'))).toBeInTheDocument();

    // Откат: в списке снова только сохранённая цель.
    expect(screen.queryByText(NEW_GOAL)).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText(i18n.t('profile:goals.listLabel'))).getAllByRole('listitem'),
    ).toHaveLength(1);
    expect(screen.getByText(SAVED_GOAL)).toBeInTheDocument();
  });

  it('не отправляет пустой список целей', async () => {
    const { user } = renderProfile();

    await user.click(
      await screen.findByRole('button', {
        name: i18n.t('profile:goals.remove', { value: SAVED_GOAL }),
      }),
    );

    expect(screen.getByText(i18n.t('profile:goals.errors.required'))).toBeInTheDocument();

    await user.click(saveButton());

    expect(screen.getByText(i18n.t('profile:form.invalid'))).toBeInTheDocument();
    expect(putRequests()).toHaveLength(0);
  });
});

describe('язык интерфейса', () => {
  it('переключает подписи сразу и запоминает выбор', async () => {
    const { user } = renderProfile();
    const languages = await screen.findByRole('region', {
      name: i18n.t('profile:sections.languages'),
    });

    await user.selectOptions(
      within(languages).getByLabelText(i18n.t('profile:languages.interface.label')),
      'ru',
    );

    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ru');
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: i18n.t('profile:title', { lng: 'ru' }),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: i18n.t('profile:form.save', { lng: 'ru' }) }),
    ).toBeInTheDocument();
  });

  it('сохраняет выбранный язык интерфейса в профиле', async () => {
    const { user } = renderProfile();
    const languages = await screen.findByRole('region', {
      name: i18n.t('profile:sections.languages'),
    });

    await user.selectOptions(
      within(languages).getByLabelText(i18n.t('profile:languages.interface.label')),
      'ru',
    );
    await user.click(
      screen.getByRole('button', { name: i18n.t('profile:form.save', { lng: 'ru' }) }),
    );

    await waitFor(() => {
      expect(putRequests()).toHaveLength(1);
    });

    expect(putRequests()[0]?.body).toEqual({ interfaceLanguage: 'ru' });
  });

  it('применяет язык интерфейса из профиля, пока на устройстве нет своего выбора', async () => {
    getProfileResponse = () => jsonResponse({ ...PROFILE_FIXTURE, interfaceLanguage: 'ru' });

    renderProfile();

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: i18n.t('profile:title', { lng: 'ru' }),
      }),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ru');
    // Профиль и интерфейс совпали — сохранять нечего.
    expect(
      screen.getByRole('button', { name: i18n.t('profile:form.save', { lng: 'ru' }) }),
    ).toBeDisabled();
  });
});
