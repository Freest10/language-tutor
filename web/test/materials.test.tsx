/**
 * Раздел материалов: загрузка файла, список, статусы обработки, удаление и просмотр.
 *
 * Сервер подменяется мок-`fetch`: бэкенд материалов пишется параллельно, поэтому
 * тест проверяет интерфейс против контракта `@lt/shared`, а не против маршрутов.
 */
import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  MATERIAL_FILE_FIELD_NAME,
  type ApiErrorResponse,
  type AppConfig,
  type Material,
  type MaterialChunk,
} from '@lt/shared';

import { App } from '../src/App';
import { formatBytes } from '../src/features/materials/useMaterials';
import { i18n } from '../src/i18n';
import { routes } from '../src/router';

/** Конфигурация сервера: предел размера файла берётся интерфейсом именно отсюда. */
const CONFIG_FIXTURE: AppConfig = {
  appName: APP_NAME,
  apiPrefix: API_PREFIX,
  version: '0.1.0',
  llm: { available: true, model: 'qwen2.5', reason: null },
  stt: { provider: 'browser', available: true, model: null, reason: null },
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
    interfaceLanguage: 'en',
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

/** Предел размера файла в том же виде, в каком его показывает интерфейс. */
const MAX_UPLOAD_LABEL = formatBytes(CONFIG_FIXTURE.limits.maxMaterialUploadBytes, 'en');

/** Материал с заполненными по умолчанию полями схемы. */
function material(overrides: Partial<Material> & Pick<Material, 'id' | 'title'>): Material {
  return {
    sourceType: 'txt',
    status: 'ready',
    statusMessage: null,
    originalFileName: 'notes.txt',
    mimeType: 'text/plain',
    sizeBytes: 2048,
    language: 'en',
    level: 'B1',
    charCount: 1200,
    chunkCount: 3,
    pageCount: null,
    topics: [],
    summary: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

/** Фрагмент материала. */
function chunk(materialId: string, order: number): MaterialChunk {
  return {
    id: `${materialId}-c${order}`,
    materialId,
    order,
    content: `Fragment number ${order} of the material.`,
    charCount: 40,
    page: null,
    heading: null,
    createdAt: '2026-09-01T10:00:00.000Z',
  };
}

/** Страница списка материалов. */
function listPage(items: Material[]) {
  return { items, total: items.length, limit: 20, offset: 0, hasMore: false };
}

/** Ответ просмотра материала с постраничной выдачей фрагментов. */
function detailPage(item: Material, chunks: MaterialChunk[], url: string) {
  const query = new URL(url, 'http://localhost').searchParams;
  const limit = Number(query.get('limit') ?? '3');
  const offset = Number(query.get('offset') ?? '0');
  const items = chunks.slice(offset, offset + limit);

  return {
    material: item,
    chunks: {
      items,
      total: chunks.length,
      limit,
      offset,
      hasMore: offset + items.length < chunks.length,
    },
  };
}

/** Запрос, дошедший до подменённого `fetch`. */
interface FetchRecord {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
}

/** Все запросы текущего теста в порядке отправки. */
let calls: FetchRecord[] = [];

/** Ответ с телом-JSON. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Конверт ошибки сервера. */
function errorResponse(code: ApiErrorResponse['error']['code'], status: number): Response {
  return jsonResponse(
    { error: { code, message: `HTTP ${status}` } } satisfies ApiErrorResponse,
    status,
  );
}

/** Подменяет `fetch` обработчиком, который отвечает по адресу и методу запроса. */
function stubFetch(handler: (record: FetchRecord) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const record: FetchRecord = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body,
      };

      calls.push(record);

      return Promise.resolve(handler(record));
    }),
  );
}

/** Поднимает приложение на разделе материалов, без истории браузера. */
function renderMaterials() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: ['/materials'] });

  return {
    user: userEvent.setup(),
    ...render(<App router={router} queryClient={queryClient} />),
  };
}

/** Строка списка, в которой лежит материал с таким названием. */
function rowOf(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 3, name: title });
  const row = heading.closest('li');

  if (!row) {
    throw new Error(`Материал «${title}» не найден в списке`);
  }

  return row;
}

/** Сколько раз интерфейс сходил за списком материалов. */
function listRequestCount(): number {
  return calls.filter((call) => call.method === 'GET' && call.url.includes('/materials?')).length;
}

beforeEach(async () => {
  calls = [];
  window.localStorage.clear();
  await i18n.changeLanguage('en');
});

afterEach(() => {
  // При `globals: false` автоматической очистки DOM нет — убираем её вручную.
  cleanup();
  vi.unstubAllGlobals();
});

describe('загрузка материала', () => {
  it('отправляет файл частью «file» и показывает его в списке', async () => {
    const uploaded = material({
      id: 'm-2',
      title: 'Grammar drills',
      sourceType: 'pdf',
      status: 'pending',
      originalFileName: 'grammar.pdf',
      mimeType: 'application/pdf',
      chunkCount: 0,
    });
    let items = [material({ id: 'm-1', title: 'Weekly news' })];

    stubFetch((record) => {
      if (record.url.includes('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      if (record.method === 'POST') {
        items = [uploaded, ...items];

        return jsonResponse(uploaded);
      }

      return jsonResponse(listPage(items));
    });

    const { user } = renderMaterials();

    expect(
      await screen.findByRole('heading', { level: 3, name: 'Weekly news' }),
    ).toBeInTheDocument();

    const file = new File(['%PDF-1.7 text'], 'grammar.pdf', { type: 'application/pdf' });

    await user.upload(screen.getByLabelText(i18n.t('materials:uploader.file.inputLabel')), file);
    await user.click(
      screen.getByRole('button', { name: i18n.t('materials:uploader.file.submit') }),
    );

    expect(
      await screen.findByRole('heading', { level: 3, name: 'Grammar drills' }),
    ).toBeInTheDocument();

    const upload = calls.find((call) => call.method === 'POST');

    expect(upload?.url).toContain('/materials');
    expect(upload?.body).toBeInstanceOf(FormData);

    const sent = (upload?.body as FormData).get(MATERIAL_FILE_FIELD_NAME);

    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe('grammar.pdf');
  });

  it('показывает сообщение про размер, когда сервер отвечает 413', async () => {
    stubFetch((record) => {
      if (record.url.includes('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      if (record.method === 'POST') {
        return errorResponse('payload_too_large', 413);
      }

      return jsonResponse(listPage([]));
    });

    const { user } = renderMaterials();

    await screen.findByText(i18n.t('materials:list.empty'));

    await user.upload(
      screen.getByLabelText(i18n.t('materials:uploader.file.inputLabel')),
      new File(['%PDF-1.7 text'], 'huge.pdf', { type: 'application/pdf' }),
    );
    await user.click(
      screen.getByRole('button', { name: i18n.t('materials:uploader.file.submit') }),
    );

    const message = await screen.findByText(
      i18n.t('materials:errors.tooLarge', { size: MAX_UPLOAD_LABEL }),
    );

    expect(message).toBeInTheDocument();
    // Общий текст ошибки 413 здесь не годится: он ничего не говорит про предел.
    expect(screen.queryByText(i18n.t('errors.byCode.payload_too_large'))).not.toBeInTheDocument();
  });

  it('не отправляет файл больше предела из конфигурации сервера', async () => {
    stubFetch((record) =>
      record.url.includes('/config') ? jsonResponse(CONFIG_FIXTURE) : jsonResponse(listPage([])),
    );

    const { user } = renderMaterials();

    await screen.findByText(i18n.t('materials:list.empty'));

    const file = new File(['%PDF-1.7 text'], 'huge.pdf', { type: 'application/pdf' });

    Object.defineProperty(file, 'size', {
      value: CONFIG_FIXTURE.limits.maxMaterialUploadBytes + 1,
    });

    await user.upload(screen.getByLabelText(i18n.t('materials:uploader.file.inputLabel')), file);

    expect(
      await screen.findByText(
        i18n.t('materials:uploader.validation.tooLarge', { size: MAX_UPLOAD_LABEL }),
      ),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('отклоняет перетащенный файл неподдерживаемого формата', async () => {
    stubFetch((record) =>
      record.url.includes('/config') ? jsonResponse(CONFIG_FIXTURE) : jsonResponse(listPage([])),
    );

    renderMaterials();

    await screen.findByText(i18n.t('materials:list.empty'));

    const dropzone = screen.getByRole('group', {
      name: i18n.t('materials:uploader.file.dropzoneLabel'),
    });

    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: [new File(['x'], 'lecture.docx', { type: 'application/vnd.openxmlformats' })],
      },
    });

    expect(
      await screen.findByText(i18n.t('materials:uploader.validation.unsupportedFormat')),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });
});

describe('список материалов', () => {
  it('объясняет, что PDF без текстового слоя — это скан', async () => {
    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(CONFIG_FIXTURE)
        : jsonResponse(
            listPage([
              material({
                id: 'm-3',
                title: 'Scanned book',
                sourceType: 'pdf',
                status: 'error_no_text_layer',
                chunkCount: 0,
                charCount: 0,
              }),
            ]),
          ),
    );

    renderMaterials();

    const row = await screen
      .findByRole('heading', { level: 3, name: 'Scanned book' })
      .then((heading) => heading.closest('li')!);

    expect(
      within(row).getByText(i18n.t('materials:status.error_no_text_layer.label')),
    ).toBeInTheDocument();
    expect(
      within(row).getByText(i18n.t('materials:status.error_no_text_layer.hint')),
    ).toBeInTheDocument();
    // Общей формулировки «ошибка» недостаточно: у каждого error_* свой текст.
    expect(
      within(row).queryByText(i18n.t('materials:status.error_extraction_failed.hint')),
    ).not.toBeInTheDocument();
  });

  it('удаляет материал только после подтверждения и перечитывает список', async () => {
    let items = [
      material({ id: 'm-1', title: 'Weekly news' }),
      material({ id: 'm-2', title: 'Podcast notes' }),
    ];

    stubFetch((record) => {
      if (record.url.includes('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      if (record.method === 'DELETE') {
        const deletedId = record.url.split('/').pop() ?? '';

        items = items.filter((item) => item.id !== deletedId);

        return jsonResponse({ ok: true });
      }

      return jsonResponse(listPage(items));
    });

    const { user } = renderMaterials();

    await screen.findByRole('heading', { level: 3, name: 'Weekly news' });

    const requestsBefore = listRequestCount();

    await user.click(
      within(rowOf('Weekly news')).getByRole('button', { name: i18n.t('actions.delete') }),
    );

    expect(
      screen.getByText(i18n.t('materials:delete.question', { title: 'Weekly news' })),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    await user.click(screen.getByRole('button', { name: i18n.t('materials:delete.confirm') }));

    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { level: 3, name: 'Weekly news' }),
      ).not.toBeInTheDocument();
    });

    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/m-1'))).toBe(true);
    // Инвалидация кэша: после удаления список перечитан с сервера.
    expect(listRequestCount()).toBeGreaterThan(requestsBefore);
    expect(screen.getByRole('heading', { level: 3, name: 'Podcast notes' })).toBeInTheDocument();
  });

  it('отменяет удаление, не отправляя запрос', async () => {
    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(CONFIG_FIXTURE)
        : jsonResponse(listPage([material({ id: 'm-1', title: 'Weekly news' })])),
    );

    const { user } = renderMaterials();

    await screen.findByRole('heading', { level: 3, name: 'Weekly news' });

    await user.click(
      within(rowOf('Weekly news')).getByRole('button', { name: i18n.t('actions.delete') }),
    );
    await user.click(screen.getByRole('button', { name: i18n.t('actions.cancel') }));

    expect(
      screen.queryByText(i18n.t('materials:delete.question', { title: 'Weekly news' })),
    ).not.toBeInTheDocument();
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('показывает состояние ошибки, когда список отвечает заглушкой 501', async () => {
    stubFetch((record) =>
      record.url.includes('/config')
        ? jsonResponse(CONFIG_FIXTURE)
        : errorResponse('not_configured', 501),
    );

    renderMaterials();

    expect(
      await screen.findByRole('heading', { level: 1, name: i18n.t('materials:title') }),
    ).toBeInTheDocument();
    expect(await screen.findByText(i18n.t('materials:list.error'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('errors.byCode.not_configured'))).toBeInTheDocument();
  });
});

describe('просмотр материала', () => {
  it('догружает текст страницами фрагментов', async () => {
    const item = material({ id: 'm-1', title: 'Weekly news', chunkCount: 4 });
    const chunks = [0, 1, 2, 3].map((order) => chunk(item.id, order));

    stubFetch((record) => {
      if (record.url.includes('/config')) {
        return jsonResponse(CONFIG_FIXTURE);
      }

      if (record.url.includes('/materials/m-1')) {
        return jsonResponse(detailPage(item, chunks, record.url));
      }

      return jsonResponse(listPage([item]));
    });

    const { user } = renderMaterials();

    await screen.findByRole('heading', { level: 3, name: 'Weekly news' });

    expect(screen.getByText(i18n.t('materials:preview.nothingSelected'))).toBeInTheDocument();

    await user.click(
      within(rowOf('Weekly news')).getByRole('button', {
        name: i18n.t('materials:list.actions.preview'),
      }),
    );

    expect(await screen.findByText(chunks[0]!.content)).toBeInTheDocument();
    expect(screen.queryByText(chunks[3]!.content)).not.toBeInTheDocument();
    expect(
      screen.getByText(i18n.t('materials:preview.shown', { shown: 3, total: 4 })),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: i18n.t('materials:preview.loadMore') }));

    expect(await screen.findByText(chunks[3]!.content)).toBeInTheDocument();
    expect(
      screen.getByText(i18n.t('materials:preview.shown', { shown: 4, total: 4 })),
    ).toBeInTheDocument();
  });
});
