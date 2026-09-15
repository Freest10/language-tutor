import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App';
import { i18n } from '../src/i18n';

describe('App', () => {
  beforeEach(() => {
    // Сервера в тесте нет: каркас обязан отрисоваться и без конфигурации.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
  });

  afterEach(() => {
    // При `globals: false` автоматической очистки DOM нет — убираем её вручную.
    cleanup();
    vi.unstubAllGlobals();
  });

  it('рендерит каркас приложения на главной странице', async () => {
    render(
      <App queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />,
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: i18n.t('home.title') }),
    ).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: i18n.t('nav.label') })).toBeInTheDocument();
  });
});
