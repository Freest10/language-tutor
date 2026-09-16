/**
 * Проверка кодов языка в запросах.
 *
 * Языки принимаются только из списка пресетов (`KNOWN_LANGUAGE_CODES`): для
 * неизвестного языка у приложения нет ни подписей, ни голосов, ни промптов.
 * Набор проверяемых полей у каждого запроса свой, поэтому он передаётся
 * параметром, а сама проверка и текст ошибки — общие.
 */
import { KNOWN_LANGUAGE_CODES } from '@lt/shared';

import { badRequest } from './httpErrors.js';

/** Языки пресетов: быстрая проверка допустимости кода. */
const SUPPORTED_LANGUAGE_CODES = new Set<string>(KNOWN_LANGUAGE_CODES);

/**
 * Проверяет, что все заданные поля запроса содержат код языка из пресетов.
 * Незаданные поля (`undefined`) пропускаются: запрос частичный по замыслу.
 */
export function assertSupportedLanguages<Input extends object>(
  input: Input,
  fields: readonly (keyof Input & string)[],
): void {
  for (const field of fields) {
    const value: unknown = input[field];

    if (typeof value === 'string' && !SUPPORTED_LANGUAGE_CODES.has(value)) {
      // Кода `unsupported_language` в `API_ERROR_CODES` нет, поэтому машиночитаемый
      // признак уходит в `details`, а код ошибки остаётся из контракта.
      throw badRequest(`Язык «${value}» не поддерживается`, {
        details: {
          reason: 'unsupported_language',
          field,
          value,
          supported: [...KNOWN_LANGUAGE_CODES],
        },
      });
    }
  }
}
