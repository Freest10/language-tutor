/**
 * Итог определения уровня: уровень CEFR, обоснование и что делать дальше.
 *
 * Уровень записывается в профиль ответом `POST /api/placement/sessions/:id/finish`
 * (`applyToProfile: true`), поэтому обычно кнопка сохранения не нужна — вместо
 * неё показывается подтверждение. Кнопка появляется, когда сервер уровень не
 * применил: иначе результат остался бы только на экране.
 */
import { Link } from 'react-router-dom';

import type { PlacementResult as PlacementResultData } from '@lt/shared';

import type { ApiError } from '../../api/client';
import { useT } from '../../i18n/useT';
import { ROUTE_PATHS } from '../../router';
import { usePlacementErrorMessage } from './usePlacement';

/** Свойства итога определения уровня. */
export interface PlacementResultProps {
  /** Оценка уровня с обоснованием, сильными и слабыми сторонами. */
  result: PlacementResultData;
  /** Уровень уже записан в профиль ответом сервера. */
  appliedToProfile: boolean;
  /** Идёт запись уровня в профиль. */
  isSaving?: boolean;
  /** Отказ записи уровня; текст для пользователя собирает сам итог. */
  saveError?: ApiError | null;
  /** Записать уровень в профиль (повторная попытка). */
  onSaveToProfile: () => void;
  /** Пройти тест заново с первого вопроса. */
  onRestart: () => void;
}

/** Доля 0..1 в процентах для подписи. */
function toPercent(value: number): number {
  return Math.round(value * 100);
}

/** Список кратких формулировок тьютора; пустой список не показывается. */
function ResultChips({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div>
      <h3>{title}</h3>
      <ul className="lt-chips">
        {items.map((item) => (
          <li className="lt-chip" key={item}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Итог определения уровня и переход к следующему шагу. */
export function PlacementResult({
  result,
  appliedToProfile,
  isSaving = false,
  saveError = null,
  onSaveToProfile,
  onRestart,
}: PlacementResultProps) {
  const t = useT('placement');
  const toErrorMessage = usePlacementErrorMessage();

  return (
    <section className="lt-card" aria-labelledby="lt-placement-result-title">
      <h2 id="lt-placement-result-title">{t('result.title')}</h2>

      <p>
        <span className="lt-badge lt-badge--ok" style={{ fontSize: '1.75rem' }}>
          {t('result.level', {
            level: result.level,
            name: t(`profile:level.names.${result.level}`),
          })}
        </span>
      </p>

      <p className="lt-status">
        {t('result.confidence', { percent: toPercent(result.confidence) })} ·{' '}
        {t('result.turnsEvaluated', { count: result.turnsEvaluated })} ·{' '}
        {t('result.accuracy', { percent: toPercent(result.accuracy) })}
      </p>

      <h3>{t('result.rationale')}</h3>
      <p>{result.rationale}</p>

      <ResultChips title={t('result.strengths')} items={result.strengths} />
      <ResultChips title={t('result.weaknesses')} items={result.weaknesses} />
      <ResultChips title={t('result.recommendedGoals')} items={result.recommendedGoals} />

      <p role="status">
        {isSaving
          ? t('result.saving')
          : appliedToProfile
            ? t('result.savedToProfile', { level: result.level })
            : t('result.notSavedToProfile')}
      </p>

      {saveError !== null && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p>{t('result.saveFailed')}</p>
          <p>{toErrorMessage(saveError)}</p>
        </div>
      )}

      <div className="lt-toolbar">
        {!appliedToProfile && (
          <button type="button" className="lt-button" disabled={isSaving} onClick={onSaveToProfile}>
            {t('result.saveToProfile')}
          </button>
        )}
        <button type="button" className="lt-button" disabled={isSaving} onClick={onRestart}>
          {t('result.restart')}
        </button>
        <Link className="lt-button" to={ROUTE_PATHS.lessons}>
          {t('result.createLesson')}
        </Link>
      </div>
    </section>
  );
}
