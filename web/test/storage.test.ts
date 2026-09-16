/**
 * Безопасный доступ к `localStorage`.
 *
 * Два условия, которые легко нарушить незаметно: приложение обязано работать
 * там, где хранилище запрещено (приватный режим), и имена ключей нельзя менять —
 * они уже записаны в браузерах пользователей, и переименование тихо потеряет
 * выбранный язык интерфейса, начатый тест уровня и тумблер автоозвучки.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LESSON_ROOM_AUTO_SPEAK_KEY } from '../src/features/lessonRoom/useLessonSession';
import {
  clearStoredPlacementSessionId,
  PLACEMENT_SESSION_STORAGE_KEY,
  readStoredPlacementSessionId,
  storePlacementSessionId,
} from '../src/features/placement/usePlacement';
import { LOCALE_STORAGE_KEY, readStoredLocale, storeLocale } from '../src/i18n';
import { readStoredValue, removeStoredValue, writeStoredValue } from '../src/lib/storage';

/** Исходное описание `window.localStorage`, если тест его подменял. */
let originalStorage: PropertyDescriptor | undefined;

afterEach(() => {
  if (originalStorage) {
    Object.defineProperty(window, 'localStorage', originalStorage);
    originalStorage = undefined;
  }

  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('имена ключей', () => {
  it('совпадают с уже записанными в браузерах пользователей', () => {
    // Менять эти строки нельзя: сохранённые настройки перестанут находиться.
    expect(LOCALE_STORAGE_KEY).toBe('lt.interfaceLanguage');
    expect(PLACEMENT_SESSION_STORAGE_KEY).toBe('lt.placementSessionId');
    expect(LESSON_ROOM_AUTO_SPEAK_KEY).toBe('lt.lessonRoom.autoSpeak');
  });
});

describe('чтение и запись', () => {
  it('возвращает записанное значение и забывает удалённое', () => {
    writeStoredValue('lt.test', 'значение');

    expect(readStoredValue('lt.test')).toBe('значение');
    expect(window.localStorage.getItem('lt.test')).toBe('значение');

    removeStoredValue('lt.test');

    expect(readStoredValue('lt.test')).toBeNull();
  });

  it('пустую строку читает как отсутствие значения', () => {
    window.localStorage.setItem('lt.test', '');

    expect(readStoredValue('lt.test')).toBeNull();
  });
});

describe('хранилище недоступно', () => {
  /** Запрещает доступ к хранилищу — так ведёт себя приватный режим. */
  function denyStorage(): void {
    const denied = (): never => {
      throw new DOMException('Access denied', 'SecurityError');
    };

    originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => ({ getItem: denied, setItem: denied, removeItem: denied }),
    });
  }

  it('чтение, запись и удаление не бросают исключений', () => {
    denyStorage();

    expect(() => {
      writeStoredValue('lt.test', 'значение');
    }).not.toThrow();
    expect(readStoredValue('lt.test')).toBeNull();
    expect(() => {
      removeStoredValue('lt.test');
    }).not.toThrow();
  });

  it('язык интерфейса и сессия теста переживают отказ хранилища', () => {
    denyStorage();

    expect(() => {
      storeLocale('ru');
    }).not.toThrow();
    expect(readStoredLocale()).toBeNull();

    expect(() => {
      storePlacementSessionId('session-1');
    }).not.toThrow();
    expect(readStoredPlacementSessionId()).toBeNull();
    expect(() => {
      clearStoredPlacementSessionId();
    }).not.toThrow();
  });
});

describe('идентификатор начатой сессии', () => {
  it('запоминается, читается и забывается', () => {
    expect(readStoredPlacementSessionId()).toBeNull();

    storePlacementSessionId('session-1');

    expect(readStoredPlacementSessionId()).toBe('session-1');
    expect(window.localStorage.getItem(PLACEMENT_SESSION_STORAGE_KEY)).toBe('session-1');

    clearStoredPlacementSessionId();

    expect(readStoredPlacementSessionId()).toBeNull();
  });
});
