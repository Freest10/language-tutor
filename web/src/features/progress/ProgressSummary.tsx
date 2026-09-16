/**
 * Сводка прогресса: уровень и его динамика, занятия, лексика и категории ошибок.
 *
 * Блок отвечает на главный вопрос ученика — «как система подо меня подстроилась»,
 * поэтому рядом с уровнем показываются и обоснование последнего изменения
 * (`lastLevelChange.reason`), и готовность уровня к пересчёту (`levelEligibility`)
 * с правилами из `LEVEL_CHANGE_POLICY`: автокоррекция не должна выглядеть произволом.
 *
 * Данные приходят свойствами: страница держит один запрос сводки, а блок только
 * показывает его состояние (загрузка, ошибка, пустой прогресс нового ученика).
 */
import { useId } from 'react';

import {
  KNOWN_LANGUAGE_CODES,
  LANGUAGE_LABELS,
  LEVEL_CHANGE_POLICY,
  VOCABULARY_STATUSES,
  type LanguageCode,
  type LevelHistoryEntry,
  type ProgressSummary as ProgressSummaryData,
} from '@lt/shared';

import { sortedErrorCategories, useProgressFormatters } from './useProgress';

import type { ApiError } from '../../api/client';
import { useApiErrorMessage, useT } from '../../i18n/useT';

/** Свойства сводки прогресса. */
export interface ProgressSummaryProps {
  /** Сводка с сервера; `null` — ещё не загружена или запрос не удался. */
  summary: ProgressSummaryData | null;
  isLoading: boolean;
  isError: boolean;
  /** Отказ запроса; текст для пользователя собирает сама сводка. */
  error: ApiError | null;
  /** Перечитать сводку: и кнопка «Обновить», и повтор после ошибки. */
  onRetry: () => void;
}

/** Название языка на нём самом; для незнакомого кода — сам код. */
function languageName(code: LanguageCode): string {
  const known = KNOWN_LANGUAGE_CODES.find((value) => value === code);

  return known ? LANGUAGE_LABELS[known].nativeName : code.toUpperCase();
}

/** Ученик ещё ничего не сделал: показываем подсказку вместо нулей без объяснения. */
function isEmptyProgress(summary: ProgressSummaryData): boolean {
  return (
    summary.lessonsCompleted === 0 &&
    summary.lessonsInProgress === 0 &&
    summary.exercisesTotal === 0 &&
    summary.vocabulary.total === 0
  );
}

/** Свойства короткой карточки последнего изменения уровня. */
interface LastLevelChangeProps {
  entry: LevelHistoryEntry;
}

/** Последнее изменение уровня: что произошло, откуда взялось и почему. */
function LastLevelChange({ entry }: LastLevelChangeProps) {
  const t = useT('progress');
  const { formatDate, formatPercent } = useProgressFormatters();
  const transition = entry.fromLevel
    ? t('level.transition', { from: entry.fromLevel, to: entry.toLevel })
    : t('level.initialTransition', { to: entry.toLevel });

  return (
    <div className="lt-list__item">
      <div>
        <p>
          <span className="lt-badge">{t(`level.direction.${entry.direction}`)}</span>{' '}
          <strong>{transition}</strong>{' '}
          <span className="lt-badge lt-badge--muted">{t(`level.source.${entry.source}`)}</span>
        </p>
        <p>
          <strong>{t('level.reasonLabel')}: </strong>
          <span>{entry.reason}</span>
        </p>
        <p className="lt-status">
          {t('level.changedAt', { date: formatDate(entry.changedAt) })}
          {' · '}
          {t('level.metrics.accuracy')}: {formatPercent(entry.metrics.accuracy)}
          {' · '}
          {t('level.metrics.exercisesEvaluated')}: {entry.metrics.exercisesEvaluated}
        </p>
      </div>
    </div>
  );
}

/** Свойства блока автокоррекции уровня. */
interface LevelAdjustmentProps {
  summary: ProgressSummaryData;
}

/** Как подстраивается уровень: последнее изменение и готовность к следующему. */
function LevelAdjustment({ summary }: LevelAdjustmentProps) {
  const t = useT('progress');
  const { formatPercent } = useProgressFormatters();
  const headingId = useId();
  const { levelEligibility } = summary;

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId}>{t('level.title')}</h3>
      <p className="lt-page__lead">{t('level.lead')}</p>

      {summary.lastLevelChange ? (
        <LastLevelChange entry={summary.lastLevelChange} />
      ) : (
        <p className="lt-placeholder">{t('level.noChange')}</p>
      )}

      <p>
        <span
          className={
            levelEligibility.canChange ? 'lt-badge lt-badge--ok' : 'lt-badge lt-badge--muted'
          }
        >
          {levelEligibility.canChange ? t('level.eligibility.can') : t('level.eligibility.cannot')}
        </span>
      </p>
      <p>{levelEligibility.reason}</p>
      {!levelEligibility.canChange && levelEligibility.lessonsUntilEligible > 0 && (
        <p>{t('level.eligibility.remaining', { count: levelEligibility.lessonsUntilEligible })}</p>
      )}
      <p className="lt-status">
        {t('level.eligibility.lessonsSinceChange')}: {summary.lessonsSinceLevelChange}
      </p>
      <p className="lt-status">
        {t('level.eligibility.policy', {
          minLessons: LEVEL_CHANGE_POLICY.minCompletedLessons,
          window: LEVEL_CHANGE_POLICY.windowLessons,
          promote: formatPercent(LEVEL_CHANGE_POLICY.promoteAccuracy),
          demote: formatPercent(LEVEL_CHANGE_POLICY.demoteAccuracy),
          maxSteps: LEVEL_CHANGE_POLICY.maxStepsPerChange,
        })}
      </p>
    </section>
  );
}

/** Сводка прогресса: уровень, занятия, лексика и ошибки по категориям. */
export function ProgressSummary({
  summary,
  isLoading,
  isError,
  error,
  onRetry,
}: ProgressSummaryProps) {
  const t = useT('progress');
  const toApiErrorMessage = useApiErrorMessage();
  const { formatDateTime, formatNumber, formatPercent } = useProgressFormatters();
  const headingId = useId();
  const categories = sortedErrorCategories(summary?.errorsByCategory ?? {});
  const hasErrors = categories.some((entry) => entry.count > 0);

  return (
    <section className="lt-card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t('summary.title')}</h2>

      <div className="lt-toolbar">
        <button type="button" className="lt-button" disabled={isLoading} onClick={onRetry}>
          {t('common:actions.refresh')}
        </button>
      </div>

      {isLoading && (
        <p className="lt-placeholder" role="status">
          {t('common:status.loading')}
        </p>
      )}

      {isError && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p className="lt-banner__title">{t('summary.error')}</p>
          <p>{toApiErrorMessage(error)}</p>
          <button type="button" className="lt-button" onClick={onRetry}>
            {t('common:actions.retry')}
          </button>
        </div>
      )}

      {summary && !isError && (
        <>
          <p>
            <strong>
              {t('summary.levelValue', {
                level: summary.level,
                name: t(`profile:level.names.${summary.level}`),
              })}
            </strong>{' '}
            <span className="lt-badge lt-badge--muted">
              {t('summary.levelConfidence', {
                percent: formatPercent(summary.levelConfidence),
              })}
            </span>
          </p>
          <p className="lt-status">
            {t('summary.learningLanguage')}: {languageName(summary.learningLanguage)}
            {' · '}
            {t('summary.updatedAt', { date: formatDateTime(summary.updatedAt) })}
          </p>

          {isEmptyProgress(summary) && <p className="lt-placeholder">{t('summary.empty')}</p>}

          <h3>{t('summary.practiceTitle')}</h3>
          <dl className="lt-facts">
            <dt>{t('summary.lessonsCompleted')}</dt>
            <dd>{formatNumber(summary.lessonsCompleted)}</dd>

            <dt>{t('summary.lessonsInProgress')}</dt>
            <dd>{formatNumber(summary.lessonsInProgress)}</dd>

            <dt>{t('summary.practiceMinutes')}</dt>
            <dd>{t('common:units.minutes', { count: summary.practiceMinutes })}</dd>

            <dt>{t('summary.exercisesLabel')}</dt>
            <dd>
              {t('summary.exercisesValue', {
                correct: formatNumber(summary.exercisesCorrect),
                total: formatNumber(summary.exercisesTotal),
              })}
            </dd>

            <dt>{t('summary.accuracyOverall')}</dt>
            <dd>{formatPercent(summary.accuracyOverall)}</dd>

            <dt>{t('summary.accuracyRecent')}</dt>
            <dd>{formatPercent(summary.accuracyRecent)}</dd>

            <dt>{t('summary.streak')}</dt>
            <dd>{t('summary.days', { count: summary.streakDays })}</dd>

            <dt>{t('summary.longestStreak')}</dt>
            <dd>{t('summary.days', { count: summary.longestStreakDays })}</dd>
          </dl>

          <h3>{t('summary.vocabularyTitle')}</h3>
          <p>
            {t('summary.vocabularyTotal')}:{' '}
            {t('common:units.words', { count: summary.vocabulary.total })}
          </p>
          <table className="lt-table">
            <caption>{t('summary.vocabularyCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('summary.vocabularyColumn')}</th>
                <th scope="col">{t('summary.vocabularyCountColumn')}</th>
              </tr>
            </thead>
            <tbody>
              {VOCABULARY_STATUSES.map((status) => (
                <tr key={status}>
                  <th scope="row">{t(`vocabulary.status.${status}`)}</th>
                  <td>{formatNumber(summary.vocabulary[status])}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>{t('summary.errorsTitle')}</h3>
          {hasErrors ? (
            <table className="lt-table">
              <caption>{t('summary.errorsCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('summary.errorsCategoryColumn')}</th>
                  <th scope="col">{t('summary.errorsCountColumn')}</th>
                </tr>
              </thead>
              <tbody>
                {categories.map(({ category, count }) => (
                  <tr key={category}>
                    <th scope="row">{t(`errors.category.${category}`)}</th>
                    <td>{formatNumber(count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="lt-placeholder">{t('summary.errorsEmpty')}</p>
          )}

          <LevelAdjustment summary={summary} />
        </>
      )}
    </section>
  );
}
