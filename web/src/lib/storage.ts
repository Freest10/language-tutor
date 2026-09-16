/**
 * Безопасный доступ к `localStorage` — один на всё приложение.
 *
 * В приватном режиме и при отключённом хранилище обращение к `localStorage`
 * бросает исключение, поэтому каждое обращение обёрнуто в `try/catch`: без
 * хранилища приложение работает, просто не помнит выбор между загрузками
 * страницы. Раньше этот `try/catch` был скопирован в трёх местах (язык
 * интерфейса, сессия определения уровня, тумблер автоозвучки), и каждая копия
 * могла разойтись с остальными.
 *
 * Имена ключей собраны здесь же: они уже записаны в браузерах пользователей,
 * поэтому менять их нельзя — сохранённые настройки перестали бы находиться.
 */

/** Ключ с выбранным языком интерфейса. */
export const LOCALE_STORAGE_KEY = 'lt.interfaceLanguage';

/** Ключ с идентификатором начатой сессии определения уровня. */
export const PLACEMENT_SESSION_STORAGE_KEY = 'lt.placementSessionId';

/** Ключ с состоянием тумблера автоозвучки в комнате урока. */
export const LESSON_ROOM_AUTO_SPEAK_KEY = 'lt.lessonRoom.autoSpeak';

/**
 * Читает значение из `localStorage`.
 *
 * @param key имя ключа.
 * @returns значение или `null`, если его нет или хранилище недоступно.
 */
export function readStoredValue(key: string): string | null {
  try {
    const stored = window.localStorage.getItem(key);

    return stored !== null && stored.length > 0 ? stored : null;
  } catch {
    // Приватный режим или отключённое хранилище: работаем без него.
    return null;
  }
}

/**
 * Записывает значение в `localStorage`.
 *
 * @param key имя ключа.
 * @param value значение; пустую строку писать не нужно — она читается как `null`.
 */
export function writeStoredValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // См. `readStoredValue`: без хранилища выбор живёт до перезагрузки страницы.
  }
}

/**
 * Удаляет значение из `localStorage`.
 *
 * @param key имя ключа.
 */
export function removeStoredValue(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // См. `readStoredValue`.
  }
}
