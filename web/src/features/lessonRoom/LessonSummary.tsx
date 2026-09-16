/**
 * Итог урока: что получилось, что повторить и как это отразилось на уровне.
 *
 * Изменение уровня показывается вместе с обоснованием (`reason`): решение
 * принимает сервер по правилам A13, и ученик должен видеть, почему уровень
 * сдвинулся, а не просто новую букву.
 *
 * Добавленная лексика и записанные ошибки ведут в раздел прогресса: итог урока
 * — точка входа в долгую работу над ними, а не отдельный справочник.
 */
import { Link } from 'react-router-dom';

import type {
  ErrorLogEntry,
  LessonSummary as LessonSummaryData,
  LevelHistoryEntry,
  VocabularyItem,
} from '@lt/shared';

import { FeedbackCard } from './FeedbackCard';

import { useT } from '../../i18n/useT';
import { ROUTE_PATHS } from '../../router';

/** Свойства итога урока. */
export interface LessonSummaryProps {
  /** Итог, посчитанный сервером. */
  summary: LessonSummaryData;
  /** Изменение уровня; `null` — уровень остался прежним. */
  levelChange?: LevelHistoryEntry | null;
  /** Слова, добавленные в личный словарь на этом уроке. */
  vocabularyAdded?: readonly VocabularyItem[];
  /** Ошибки, записанные в журнал на этом уроке. */
  errorsLogged?: readonly ErrorLogEntry[];
}

/** Список пунктов итога; пустой список не показывается. */
function SummaryList({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <>
      <h3 style={{ fontSize: '1rem', marginBottom: 'var(--lt-space-xs)' }}>{title}</h3>
      <ul className="lt-list">
        {items.map((item) => (
          <li className="lt-list__item" key={item}>
            {item}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Итог завершённого урока вместе с изменением уровня и новой лексикой. */
export function LessonSummary({
  summary,
  levelChange = null,
  vocabularyAdded = [],
  errorsLogged = [],
}: LessonSummaryProps) {
  const t = useT('lessonRoom');
  const accuracyPercent = Math.round(summary.accuracy * 100);

  return (
    <section className="lt-card" aria-labelledby="lt-lesson-summary-title">
      <h2 id="lt-lesson-summary-title">{t('summary.title')}</h2>

      <p>{summary.text}</p>

      <p>
        <span className="lt-badge lt-badge--ok">
          {t('summary.accuracy', { percent: accuracyPercent })}
        </span>{' '}
        <span className="lt-badge lt-badge--muted">
          {t('summary.exercises', {
            correct: summary.exercisesCorrect,
            total: summary.exercisesTotal,
          })}
        </span>{' '}
        <span className="lt-badge lt-badge--muted">
          {t('summary.duration', { count: summary.durationMinutes })}
        </span>
      </p>

      {levelChange && (
        <div className="lt-banner" role="status">
          <p className="lt-banner__title">
            {t(`summary.levelChange.${levelChange.direction}`, {
              from: levelChange.fromLevel ?? '—',
              to: levelChange.toLevel,
            })}
          </p>
          <p>{t('summary.levelChange.reason', { reason: levelChange.reason })}</p>
        </div>
      )}

      <SummaryList title={t('summary.strengths')} items={summary.strengths} />
      <SummaryList title={t('summary.weaknesses')} items={summary.weaknesses} />
      <SummaryList title={t('summary.recommendations')} items={summary.recommendations} />

      {summary.newVocabulary.length > 0 && (
        <>
          <h3 style={{ fontSize: '1rem', marginBottom: 'var(--lt-space-xs)' }}>
            {t('summary.newVocabulary')}
          </h3>
          <ul className="lt-chips">
            {summary.newVocabulary.map((term) => (
              <li className="lt-chip" key={term}>
                {term}
              </li>
            ))}
          </ul>
        </>
      )}

      {vocabularyAdded.length > 0 && (
        <>
          <h3 style={{ fontSize: '1rem', marginBottom: 'var(--lt-space-xs)' }}>
            {t('summary.vocabularyAdded')}
          </h3>
          <table className="lt-table">
            <caption className="lt-status">
              {t('summary.vocabularyCount', { count: vocabularyAdded.length })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('summary.vocabularyTerm')}</th>
                <th scope="col">{t('summary.vocabularyTranslation')}</th>
              </tr>
            </thead>
            <tbody>
              {vocabularyAdded.map((item) => (
                <tr key={item.id}>
                  <td>{item.term}</td>
                  <td>{item.translation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {errorsLogged.length > 0 && (
        <FeedbackCard
          corrections={errorsLogged}
          title={t('summary.errorsLogged', { count: errorsLogged.length })}
          headingLevel={3}
        />
      )}

      <div className="lt-toolbar">
        <Link className="lt-button" to={ROUTE_PATHS.progress}>
          {t('summary.actions.progress')}
        </Link>
        <Link className="lt-button" to={ROUTE_PATHS.lessons}>
          {t('summary.actions.lessons')}
        </Link>
      </div>
    </section>
  );
}
