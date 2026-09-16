/**
 * Тексты подсказок «поправьте настройки» такими, какими их видит пользователь.
 *
 * Подстановку `{{where}}` делает `useT` — один раз на все переводы, чтобы её
 * не забыли в очередной подсказке. Тесту нужно то же самое значение, и ключ
 * фразы он берёт из той же функции, что и `useT`: иначе проверялась бы не
 * подсказка, а копия правила подстановки.
 */
import type { ConfigSource } from '@lt/shared';

import { configWhereKey } from '../../src/i18n/configLocation';
import { i18n } from '../../src/i18n';

/**
 * Перевод с подставленной фразой о том, где лежат настройки.
 *
 * @param key ключ с префиксом namespace, например `lessons:errors.notConfigured`.
 * @param params остальные переменные перевода.
 * @param source откуда приложение берёт настройки.
 */
export function textWithConfigHint(
  key: string,
  params: Record<string, unknown> = {},
  source: ConfigSource = 'env',
): string {
  return i18n.t(key, { where: i18n.t(configWhereKey(source)), ...params });
}
