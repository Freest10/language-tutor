/**
 * Уровень CEFR с пояснением, откуда он взялся.
 *
 * Пользователю важно различать уровень, определённый тестом, и выставленный
 * вручную: от этого зависит, насколько можно доверять сложности уроков.
 * Дата последнего определения уровня приходит в `placementCompletedAt`;
 * `null` означает, что тест ни разу не пройден и уровень задан руками.
 */
import type { CefrLevel } from '@lt/shared';

import { useLocale, useT } from '../../i18n/useT';

/** Свойства значка уровня. */
export interface LevelBadgeProps {
  /** Уровень CEFR, который нужно показать. */
  level: CefrLevel;
  /** Уверенность сервера в оценке (0–1); `null` — показывать нечего. */
  levelConfidence?: number | null;
  /** Когда уровень определён тестом; `null` — уровень задан вручную. */
  placementCompletedAt?: string | null;
}

/** Дата в формате языка интерфейса; `null`, если значение не разбирается. */
function formatDate(value: string, locale: string): string | null {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(date);
}

/** Уровень CEFR, его название и происхождение оценки. */
export function LevelBadge({
  level,
  levelConfidence = null,
  placementCompletedAt = null,
}: LevelBadgeProps) {
  const t = useT('profile');
  const { locale } = useLocale();
  const placementDate = placementCompletedAt ? formatDate(placementCompletedAt, locale) : null;

  const source = !placementCompletedAt
    ? t('level.sourceManual')
    : placementDate
      ? t('level.sourcePlacementAt', { date: placementDate })
      : t('level.sourcePlacement');

  return (
    <p>
      <strong>{t('level.badge', { level, name: t(`level.names.${level}`) })}</strong>{' '}
      <span>{source}</span>
      {typeof levelConfidence === 'number' && (
        <>
          {' '}
          <span>{t('level.confidence', { percent: Math.round(levelConfidence * 100) })}</span>
        </>
      )}
    </p>
  );
}
