/**
 * Шаги плана рядом с диалогом: где урок сейчас и что будет дальше.
 *
 * Панель отвечает на вопрос «сколько ещё осталось»: без неё голосовой урок
 * выглядит как бесконечный разговор. Текущий шаг помечен `aria-current="step"`,
 * поэтому экранная читалка называет его при переходе по списку.
 *
 * Перейти можно только с текущего шага и только вперёд: порядок шагов задаёт
 * план урока, а произвольные прыжки сервер не поддерживает.
 */
import type { LessonPlanStep } from '@lt/shared';

import { useT } from '../../i18n/useT';
import { sortLessonPlan, useLessonStepText } from '../lessons/useLessons';

/** Чем закончился шаг. */
export type StepAdvanceStatus = 'completed' | 'skipped';

/** Свойства панели шагов. */
export interface StepSidebarProps {
  /** Шаги плана; сортируются по `order`. */
  plan: readonly LessonPlanStep[];
  /** Шаг, на котором урок сейчас находится; `null` — урок не начат или пройден. */
  currentStepId?: string | null;
  /** Идёт переход к следующему шагу. */
  isAdvancing?: boolean;
  /** Переходы запрещены: урок не идёт или занят другим запросом. */
  disabled?: boolean;
  /** Закрыть текущий шаг и перейти к следующему. */
  onAdvance?: (stepId: string, status: StepAdvanceStatus) => void;
}

/** Оформление бейджа состояния шага. */
const STATUS_BADGE: Record<LessonPlanStep['status'], string> = {
  pending: 'lt-badge lt-badge--muted',
  in_progress: 'lt-badge lt-badge--warn',
  completed: 'lt-badge lt-badge--ok',
  skipped: 'lt-badge lt-badge--muted',
};

/** Панель шагов плана с переходом к следующему шагу. */
export function StepSidebar({
  plan,
  currentStepId = null,
  isAdvancing = false,
  disabled = false,
  onAdvance,
}: StepSidebarProps) {
  const t = useT('lessonRoom');
  const stepText = useLessonStepText();
  const steps = sortLessonPlan(plan);
  const currentIndex = steps.findIndex((step) => step.id === currentStepId);
  const doneCount = steps.filter(
    (step) => step.status === 'completed' || step.status === 'skipped',
  ).length;

  return (
    <nav className="lt-card" aria-labelledby="lt-lesson-steps-title">
      <h2 id="lt-lesson-steps-title">{t('steps.title')}</h2>

      {steps.length === 0 ? (
        <p className="lt-placeholder">{t('steps.empty')}</p>
      ) : (
        <>
          <p className="lt-status">
            {currentIndex >= 0
              ? t('steps.progress', { current: currentIndex + 1, total: steps.length })
              : t('steps.progressDone', { done: doneCount, total: steps.length })}
          </p>

          <ol className="lt-list">
            {steps.map((step, index) => {
              const isCurrent = step.id === currentStepId;

              return (
                <li
                  key={step.id}
                  className={isCurrent ? 'lt-list__item lt-list__item--selected' : 'lt-list__item'}
                  aria-current={isCurrent ? 'step' : undefined}
                  data-step-status={step.status}
                >
                  <p>
                    <strong>{t('steps.order', { number: index + 1 })}</strong> {step.title}
                  </p>
                  <p>
                    <span className="lt-badge">{stepText.typeLabel(step.type)}</span>{' '}
                    <span className={STATUS_BADGE[step.status]}>
                      {stepText.statusLabel(step.status)}
                    </span>{' '}
                    {isCurrent && (
                      <span className="lt-badge lt-badge--warn">{t('steps.current')}</span>
                    )}
                  </p>
                  <p className="lt-status">
                    {t('steps.minutes', { count: step.estimatedMinutes })}
                  </p>

                  {isCurrent && onAdvance && (
                    <div className="lt-toolbar">
                      <button
                        type="button"
                        className="lt-button"
                        disabled={disabled || isAdvancing}
                        onClick={() => {
                          onAdvance(step.id, 'completed');
                        }}
                      >
                        {isAdvancing ? t('steps.actions.advancing') : t('steps.actions.advance')}
                      </button>
                      <button
                        type="button"
                        className="lt-button"
                        disabled={disabled || isAdvancing}
                        onClick={() => {
                          onAdvance(step.id, 'skipped');
                        }}
                      >
                        {t('steps.actions.skip')}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </nav>
  );
}
