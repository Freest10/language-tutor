/**
 * Где у этого запуска лежат настройки приложения.
 *
 * Подсказки в интерфейсе заканчиваются словами «поправьте настройки»: у
 * веб-версии это файл `.env` и перезапуск сервера, у десктопной — пункт меню,
 * а файла `.env` там нет вовсе. Значение приходит с сервера в `GET /api/config`
 * и подставляется во все переводы разом — см. `useT`.
 *
 * Хранилище своё, а не контекст React: `useT` зовут в том числе компоненты
 * выше `CapabilitiesProvider`, и зависимость от контекста замкнула бы их
 * друг на друга. Подписка даёт то же, что дал бы контекст: пришедшая
 * конфигурация перерисовывает подсказки.
 */
import { useSyncExternalStore } from 'react';

import type { ConfigSource } from '@lt/shared';

/** До ответа сервера считаем, что настройки в `.env`: так работает веб-версия. */
const DEFAULT_SOURCE: ConfigSource = 'env';

let source: ConfigSource = DEFAULT_SOURCE;

const listeners = new Set<() => void>();

/** Запоминает источник настроек и будит подписчиков. */
export function setConfigSource(next: ConfigSource): void {
  if (next === source) {
    return;
  }

  source = next;
  listeners.forEach((listener) => {
    listener();
  });
}

/** Текущий источник настроек. */
export function getConfigSource(): ConfigSource {
  return source;
}

/** Подписка на смену источника настроек. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** Источник настроек с перерисовкой при его смене. */
export function useConfigSource(): ConfigSource {
  return useSyncExternalStore(subscribe, getConfigSource, getConfigSource);
}

/** Ключ фразы «где лежат настройки» для источника. */
export function configWhereKey(source: ConfigSource): string {
  return source === 'desktop' ? 'common:config.whereDesktop' : 'common:config.whereEnv';
}

/** Сбрасывает источник к значению по умолчанию (тесты). */
export function resetConfigSource(): void {
  setConfigSource(DEFAULT_SOURCE);
}
