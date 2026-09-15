/**
 * Точка входа веб-приложения.
 *
 * Здесь только монтирование: состав провайдеров (переводы, TanStack Query,
 * возможности бэкенда) и маршруты живут в `App.tsx` — так тест поднимает
 * приложение ровно в той же конфигурации, что и браузер.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles/global.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Не найден корневой элемент #root');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
