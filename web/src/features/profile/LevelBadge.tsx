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
import { formatDate, parseIsoDate } from '../../lib/format';

/** Свойства значка уровня. */
export interface LevelBadgeProps {
  /** Уровень CEFR, который нужно показать. */
  level: CefrLevel;
  /** Уверенность сервера в оценке (0–1); `null` — показывать нечего. */
  levelConfidence?: number | null;
  /** Когда уровень определён тестом; `null` — уровень задан вручную. */
  placementCompletedAt?: string | null;
}

/** Уровень CEFR, его название и происхождение оценки. */
export function LevelBadge({
  level,
  levelConfidence = null,
  placementCompletedAt = null,
}: LevelBadgeProps) {
  const t = useT('profile');
  const { locale } = useLocale();
  // Неразбираемую дату не показываем вовсе: для неё есть отдельная формулировка.
  const placementDate =
    placementCompletedAt && parseIsoDate(placementCompletedAt)
      ? formatDate(placementCompletedAt, locale, 'long')
      : null;

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
