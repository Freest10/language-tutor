/**
 * Разбор ответа ученика: верно или нет, оценка и исправления с объяснениями.
 *
 * Одна карточка на все места, где тьютор что-то исправляет: и попытка
 * выполнения задания, и реплика диалога приходят с одинаковым списком
 * `Correction`, поэтому смысла в двух разных представлениях нет.
 *
 * Объяснение — главная часть исправления: без него «было — стало» ничему
 * не учит, поэтому текст объяснения показывается всегда и полностью.
 */
import type { Correction } from '@lt/shared';

import { useT } from '../../i18n/useT';

/** Уровень заголовка карточки: подстраивается под место вставки. */
export type FeedbackHeadingLevel = 3 | 4;

/** Свойства карточки разбора. */
export interface FeedbackCardProps {
  /** Исправления с объяснениями; пустой список допустим. */
  corrections: readonly Correction[];
  /** Заголовок карточки; по умолчанию — «разбор ответа». */
  title?: string;
  /** Ответ засчитан; `null` или `undefined` — оценки не было (реплика диалога). */
  isCorrect?: boolean | null;
  /** Оценка ответа, 0…1; `null` или `undefined` — оценки не было. */
  score?: number | null;
  /** Связный разбор от тьютора на языке объяснений урока. */
  feedback?: string | null;
  /** Уровень заголовка; по умолчанию `4`. */
  headingLevel?: FeedbackHeadingLevel;
}

/** Бейдж тяжести ошибки: серьёзная мешает пониманию, мелкая — нет. */
const SEVERITY_BADGE: Record<Correction['severity'], string> = {
  minor: 'lt-badge lt-badge--warn',
  major: 'lt-badge lt-badge--error',
};

/** Разбор ответа: вердикт, оценка, текст тьютора и список исправлений. */
export function FeedbackCard({
  corrections,
  title,
  isCorrect = null,
  score = null,
  feedback = null,
  headingLevel = 4,
}: FeedbackCardProps) {
  const t = useT('lessonRoom');
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  const feedbackText = feedback?.trim() ?? '';
  const percent = typeof score === 'number' ? Math.round(score * 100) : null;

  return (
    <div className="lt-card" style={{ marginTop: 'var(--lt-space-sm)' }}>
      <Heading style={{ marginTop: 0, fontSize: '1rem' }}>{title ?? t('feedback.title')}</Heading>

      {isCorrect !== null && (
        <p>
          <span className={isCorrect ? 'lt-badge lt-badge--ok' : 'lt-badge lt-badge--error'}>
            {isCorrect ? t('feedback.correct') : t('feedback.incorrect')}
          </span>{' '}
          {percent !== null && (
            <span className="lt-badge lt-badge--muted">{t('feedback.score', { percent })}</span>
          )}
        </p>
      )}

      {feedbackText.length > 0 && <p>{feedbackText}</p>}

      {corrections.length === 0 ? (
        <p className="lt-status">{t('feedback.noCorrections')}</p>
      ) : (
        <ul className="lt-list">
          {corrections.map((correction, index) => (
            <li className="lt-list__item" key={`${correction.original}-${index}`}>
              <p>
                <span className="lt-badge">{t(`feedback.categories.${correction.category}`)}</span>{' '}
                <span className={SEVERITY_BADGE[correction.severity]}>
                  {t(`feedback.severity.${correction.severity}`)}
                </span>
              </p>
              <p>
                <del>{correction.original}</del>
                {correction.corrected.length > 0 && (
                  <>
                    {' → '}
                    <ins>{correction.corrected}</ins>
                  </>
                )}
              </p>
              <p className="lt-status">{correction.explanation}</p>
              {correction.targetItem && (
                <p className="lt-status">
                  {t('feedback.targetItem', { item: correction.targetItem })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
