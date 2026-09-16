/**
 * Подсказки «поправьте настройки» должны вести туда, где настройки лежат.
 *
 * У веб-версии это файл `.env` и перезапуск сервера, у десктопной — пункт меню,
 * а файла `.env` там нет вовсе. Источник приходит с сервера в `GET /api/config`,
 * и подстановка общая для всех переводов (`useT`), поэтому проверяется она
 * здесь один раз, а не в каждой подсказке.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '../src/i18n';
import { configWhereKey, resetConfigSource, setConfigSource } from '../src/i18n/configLocation';
import { useT } from '../src/i18n/useT';

afterEach(() => {
  resetConfigSource();
});

/** Подсказка о ненайденной модели: её видит пользователь, у которого нет модели. */
function modelHint(): string {
  return renderHook(() => useT('lessons')).result.current('errors.modelNotFoundHint');
}

describe('подсказка «где настройки»', () => {
  it('по умолчанию ведёт в .env и к перезапуску сервера', () => {
    const hint = modelHint();

    expect(hint).toContain(i18n.t(configWhereKey('env')));
    expect(hint).toContain('.env');
    // Незакрытая подстановка означала бы, что пользователь видит `{{where}}`.
    expect(hint).not.toContain('{{where}}');
  });

  it('в десктопной сборке ведёт в меню, а не в несуществующий .env', () => {
    setConfigSource('desktop');

    const hint = modelHint();

    expect(hint).toContain(i18n.t(configWhereKey('desktop')));
    expect(hint).not.toContain('.env');
  });

  it('оставляет саму подсказку на месте: подставляется только место настроек', () => {
    setConfigSource('desktop');

    // Совет «модели с таким именем нет, поставьте или выберите другую» не зависит
    // от того, где живёт конфигурация.
    expect(modelHint()).toContain('ollama list');
  });
});
