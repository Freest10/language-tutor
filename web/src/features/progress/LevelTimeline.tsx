/**
 * История уровня вертикальной лентой: что изменилось, откуда взялось и почему.
 *
 * Лента рисуется разметкой и токенами темы, без графических библиотек: каждая
 * запись — элемент списка с цветной полосой слева, цвет зависит от направления
 * изменения. Порядок — от свежих к давним (`order: 'desc'`).
 *
 * `reason` сервера показывается целиком и без сокращений: это объяснение ученику,
 * почему уровень изменился, а `metrics` рядом — измеримое основание решения (A13).
 */
import { useId, useState } from 'react';

import type { LevelChangeDirection, LevelHistoryEntry } from '@lt/shared';

import { LEVEL_HISTORY_PAGE_SIZE, useLevelHistory, useProgressFormatters } from './useProgress';

import { useApiErrorMessage, useT } from '../../i18n/useT';

/** Свойства ленты истории уровня. */
export interface LevelTimelineProps {
  /** Сколько записей показывать до нажатия «показать более ранние». */
  pageSize?: number;
}

/** Цвет полосы записи: повышение — акцент, понижение — предупреждение. */
function markerColor(direction: LevelChangeDirection): string {
  if (direction === 'up') {
    return 'var(--lt-color-accent)';
  }

  return direction === 'down' ? 'var(--lt-color-warning-border)' : 'var(--lt-color-border)';
}

/** Свойства записи ленты. */
interface LevelTimelineEntryProps {
  entry: LevelHistoryEntry;
}

/** Одно изменение уровня: направление, источник, обоснование и метрика решения. */
function LevelTimelineEntry({ entry }: LevelTimelineEntryProps) {
  const t = useT('progress');
  const { formatDate, formatPercent } = useProgressFormatters();
  const direction = t(`level.direction.${entry.direction}`);
  const transition = entry.fromLevel
    ? t('level.transition', { from: entry.fromLevel, to: entry.toLevel })
    : t('level.initialTransition', { to: entry.toLevel });
  const windowLabel =
    entry.metrics.windowFrom && entry.metrics.windowTo
      ? t('level.metrics.window', {
          from: formatDate(entry.metrics.windowFrom),
          to: formatDate(entry.metrics.windowTo),
        })
      : null;

  return (
    <li
      className="lt-list__item"
      style={{ borderInlineStart: `3px solid ${markerColor(entry.direction)}` }}
    >
      <div>
        <p>
          <strong>
            {t('timeline.entryLabel', { direction, date: formatDate(entry.changedAt) })}
          </strong>{' '}
          <span className="lt-badge">{transition}</span>{' '}
          <span className="lt-badge lt-badge--muted">{t(`level.source.${entry.source}`)}</span>
        </p>
        <p>
          <strong>{t('level.reasonLabel')}: </strong>
          <span>{entry.reason}</span>
        </p>
        <dl className="lt-facts">
          <dt>{t('level.metrics.accuracy')}</dt>
          <dd>{formatPercent(entry.metrics.accuracy)}</dd>

          <dt>{t('level.metrics.lessonsConsidered')}</dt>
          <dd>{entry.metrics.lessonsConsidered}</dd>

          <dt>{t('level.metrics.lessonsSinceLastChange')}</dt>
          <dd>{entry.metrics.lessonsSinceLastChange}</dd>

          <dt>{t('level.metrics.exercisesEvaluated')}</dt>
          <dd>{entry.metrics.exercisesEvaluated}</dd>

          <dt>{t('level.confidence')}</dt>
          <dd>{formatPercent(entry.confidence)}</dd>
        </dl>
        {windowLabel && <p className="lt-status">{windowLabel}</p>}
      </div>
    </li>
  );
}

/** История изменений уровня вертикальной лентой. */
export function LevelTimeline({ pageSize = LEVEL_HISTORY_PAGE_SIZE }: LevelTimelineProps = {}) {
  const t = useT('progress');
  const toApiErrorMessage = useApiErrorMessage();
  const headingId = useId();
  const [limit, setLimit] = useState(pageSize);
  const { items, total, hasMore, isLoading, isError, error, refetch } = useLevelHistory({
    limit,
    order: 'desc',
  });

  return (
    <section className="lt-card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t('timeline.title')}</h2>
      <p className="lt-page__lead">{t('timeline.lead')}</p>

      {isLoading && (
        <p className="lt-placeholder" role="status">
          {t('common:status.loading')}
        </p>
      )}

      {isError && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p className="lt-banner__title">{t('timeline.error')}</p>
          <p>{toApiErrorMessage(error)}</p>
          <button type="button" className="lt-button" onClick={refetch}>
            {t('common:actions.retry')}
          </button>
        </div>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <p className="lt-placeholder">{t('timeline.empty')}</p>
      )}

      {!isError && items.length > 0 && (
        <>
          <ol className="lt-list" aria-label={t('timeline.listLabel')}>
            {items.map((entry) => (
              <LevelTimelineEntry key={entry.id} entry={entry} />
            ))}
          </ol>
          <p className="lt-status">{t('timeline.range', { shown: items.length, total })}</p>
          {hasMore && (
            <button
              type="button"
              className="lt-button"
              onClick={() => {
                setLimit((current) => current + pageSize);
              }}
            >
              {t('timeline.loadMore')}
            </button>
          )}
        </>
      )}
    </section>
  );
}
