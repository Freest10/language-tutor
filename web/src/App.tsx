/**
 * Корневой компонент: провайдеры приложения и роутер.
 *
 * Провайдеры собраны здесь, а не в `main.tsx`, чтобы тест рендерил ровно тот же
 * состав контекстов, что и браузер. Роутер и клиент запросов можно подменить
 * через свойства — тесту это нужно, чтобы поднять маршруты в памяти.
 */
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider, type RouterProviderProps } from 'react-router-dom';

import { CapabilitiesProvider } from './context/CapabilitiesProvider';
import { I18nProvider } from './i18n/I18nProvider';
import { queryClient as defaultQueryClient } from './lib/queryClient';
import { router as browserRouter } from './router';

/** Свойства корневого компонента. */
export interface AppProps {
  /** Роутер; по умолчанию — поверх History API браузера. */
  router?: RouterProviderProps['router'];
  /** Клиент TanStack Query; по умолчанию — общий экземпляр приложения. */
  queryClient?: QueryClient;
}

/** Приложение целиком: переводы, запросы, возможности бэкенда и маршруты. */
export function App({ router = browserRouter, queryClient = defaultQueryClient }: AppProps = {}) {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <CapabilitiesProvider>
          <RouterProvider router={router} />
        </CapabilitiesProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

export default App;
