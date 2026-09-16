/**
 * План урока: из чего он состоит и что делать дальше.
 *
 * Этапы показываются строго в порядке `order` — план читается как сценарий
 * занятия, а сервер не обязан присылать шаги отсортированными.
 *
 * Пересборка плана идёт через ту же локальную модель, что и генерация, поэтому
 * ожидание показано скелетоном и строкой `role="status"`: десятки секунд тишины
 * выглядят как зависшая страница.
 *
 * Новый план, как и новый урок, обходит материал, пройденный на других уроках.
 * Вернуться к нему можно флажком `includeCoveredMaterial` — по умолчанию он снят.
 */
import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import type { Lesson, LessonPlanStep, RegenerateLessonPlanRequest } from '@lt/shared';

import {
  llmHintKey,
  sortLessonPlan,
  useLessonErrorMessage,
  useLessonFormatters,
  useLessonStatusText,
  useLessonStepText,
} from './useLessons';

import { LESSON_FEEDBACK_MAX_LENGTH } from '../../api/lessons';
import { LoadingBlock } from '../../components/LoadingBlock';
import { useT } from '../../i18n/useT';
import { lessonRoomPath } from '../../router';

/** Свойства просмотра плана урока. */
export interface LessonPlanViewProps {
  /** Урок вместе с планом. */
  lesson: Lesson;
  /** Идёт пересборка плана: форма заблокирована, показано ожидание модели. */
  isRegenerating: boolean;
  /** Отказ последней пересборки; `null` — отказа не было. */
  regenerateError?: unknown;
  /** Модель доступна: иначе кнопка пересборки не показывается. */
  canRegenerate?: boolean;
  /** Имя модели — для строки ожидания. */
  model?: string | null;
  /** Запрос на пересборку плана. */
  onRegenerate: (body: RegenerateLessonPlanRequest) => void;
}

/** Свойства карточки этапа. */
interface PlanStepCardProps {
  step: LessonPlanStep;
  /** Номер этапа для человека, с единицы. */
  number: number;
  /** Этап, на котором урок сейчас находится. */
  current: boolean;
}

/** Карточка этапа: вид, цели, целевые единицы, минуты и привязанные фрагменты. */
function PlanStepCard({ step, number, current }: PlanStepCardProps) {
  const t = useT('lessons');
  const stepText = useLessonStepText();
  const titleId = useId();

  return (
    <li
      className="lt-card"
      style={{ marginBottom: 'var(--lt-space-md)' }}
      data-step-type={step.type}
    >
      <h3 id={titleId} style={{ marginTop: 0, fontSize: '1rem' }}>
        {t('plan.steps.order', { number })} {step.title}
      </h3>
      <p>
        <span className="lt-badge">{stepText.typeLabel(step.type)}</span>{' '}
        <span className="lt-badge lt-badge--muted" data-step-status={step.status}>
          {stepText.statusLabel(step.status)}
        </span>{' '}
        {current && <span className="lt-badge lt-badge--warn">{t('plan.steps.current')}</span>}
      </p>
      <p className="lt-status">{stepText.typeHint(step.type)}</p>
      <p>{step.instructions}</p>

      {step.objectives.length > 0 && (
        <>
          <h4 style={{ margin: '0 0 var(--lt-space-xs)', fontSize: '0.9rem' }}>
            {t('plan.steps.objectives')}
          </h4>
          <ul>
            {step.objectives.map((objective) => (
              <li key={objective}>{objective}</li>
            ))}
          </ul>
        </>
      )}

      {step.targetItems.length > 0 && (
        <>
          <h4 style={{ margin: '0 0 var(--lt-space-xs)', fontSize: '0.9rem' }}>
            {t('plan.steps.targetItems')}
          </h4>
          <ul className="lt-chips">
            {step.targetItems.map((item) => (
              <li key={item} className="lt-chip">
                {item}
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="lt-status">
        {t('plan.steps.minutes', { count: step.estimatedMinutes })}
        {step.materialChunkIds.length > 0
          ? ` · ${t('plan.steps.chunks', { count: step.materialChunkIds.length })}`
          : ` · ${t('plan.steps.noChunks')}`}
        {step.exerciseIds.length > 0
          ? ` · ${t('plan.steps.exercises', { count: step.exerciseIds.length })}`
          : ''}
      </p>
    </li>
  );
}

/** План урока: этапы, переход в комнату урока и пересборка плана. */
export function LessonPlanView({
  lesson,
  isRegenerating,
  regenerateError = null,
  canRegenerate = true,
  model = null,
  onRegenerate,
}: LessonPlanViewProps) {
  const t = useT('lessons');
  const toErrorMessage = useLessonErrorMessage();
  const { formatDateTime } = useLessonFormatters();
  const statusText = useLessonStatusText();
  const status = statusText(lesson.status);
  const baseId = useId();
  const summaryId = `${baseId}-summary`;
  const stepsId = `${baseId}-steps`;
  const regenerateId = `${baseId}-regenerate`;
  const feedbackId = `${baseId}-feedback`;
  const feedbackHintId = `${baseId}-feedback-hint`;
  const keepId = `${baseId}-keep`;
  const coveredId = `${baseId}-covered`;
  const coveredHintId = `${baseId}-covered-hint`;

  const [feedback, setFeedback] = useState('');
  const [keepCompletedSteps, setKeepCompletedSteps] = useState(true);
  const [includeCoveredMaterial, setIncludeCoveredMaterial] = useState(false);

  const plan = sortLessonPlan(lesson.plan);
  // `keepCompletedSteps` бережёт всё, что уже не `pending`: пройденное,
  // пропущенное и начатое. Предлагать выбор раньше, чем такие этапы появились,
  // незачем.
  const hasStartedSteps = plan.some((step) => step.status !== 'pending');
  const isCompleted = lesson.status === 'completed';
  const regenerateHint = llmHintKey(regenerateError);
  const plannedSteps = plan.reduce((sum, step) => sum + step.estimatedMinutes, 0);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const trimmed = feedback.trim();
    const body: RegenerateLessonPlanRequest = { keepCompletedSteps, includeCoveredMaterial };

    if (trimmed.length > 0) {
      body.feedback = trimmed;
    }

    onRegenerate(body);
  };

  return (
    <>
      <section className="lt-card" aria-labelledby={summaryId}>
        <h2 id={summaryId}>{lesson.title}</h2>
        <p>
          <span className={`lt-badge lt-badge--${status.tone}`} data-status={lesson.status}>
            {status.label}
          </span>
        </p>
        <dl className="lt-facts">
          <dt>{t('plan.fields.level')}</dt>
          <dd>{lesson.level}</dd>

          <dt>{t('plan.fields.duration')}</dt>
          <dd>{t('common:units.minutes', { count: lesson.plannedMinutes })}</dd>

          <dt>{t('plan.fields.topic')}</dt>
          <dd>{lesson.topic?.trim() || t('list.noTopic')}</dd>

          <dt>{t('plan.fields.steps')}</dt>
          <dd>{t('plan.fields.stepsValue', { count: plan.length, minutes: plannedSteps })}</dd>

          <dt>{t('plan.fields.materials')}</dt>
          <dd>{t('plan.fields.materialsValue', { count: lesson.materialIds.length })}</dd>

          <dt>{t('plan.fields.createdAt')}</dt>
          <dd>{formatDateTime(lesson.createdAt)}</dd>
        </dl>

        {lesson.goals.length > 0 && (
          <>
            <h3 style={{ fontSize: '0.9rem' }}>{t('plan.fields.goals')}</h3>
            <ul className="lt-chips">
              {lesson.goals.map((goal) => (
                <li key={goal} className="lt-chip">
                  {goal}
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="lt-toolbar" style={{ marginTop: 'var(--lt-space-md)', marginBottom: 0 }}>
          <Link className="lt-button" to={lessonRoomPath(lesson.id)}>
            {t('plan.actions.start')}
          </Link>
        </div>
      </section>

      <section
        className="lt-card"
        aria-labelledby={stepsId}
        style={{ marginTop: 'var(--lt-space-lg)' }}
      >
        <h2 id={stepsId}>{t('plan.steps.title')}</h2>

        {plan.length === 0 && <p className="lt-placeholder">{t('plan.steps.empty')}</p>}

        {plan.length > 0 && (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-labelledby={stepsId}>
            {plan.map((step, index) => (
              <PlanStepCard
                key={step.id}
                step={step}
                number={index + 1}
                current={step.id === lesson.currentStepId}
              />
            ))}
          </ol>
        )}
      </section>

      <section
        className="lt-card"
        aria-labelledby={regenerateId}
        style={{ marginTop: 'var(--lt-space-lg)' }}
      >
        <h2 id={regenerateId}>{t('plan.regenerate.title')}</h2>
        <p className="lt-page__lead">{t('plan.regenerate.description')}</p>

        <form onSubmit={handleSubmit} noValidate>
          <div className="lt-field">
            <label className="lt-field__label" htmlFor={feedbackId}>
              {t('plan.regenerate.feedback.label')}
            </label>
            <textarea
              id={feedbackId}
              rows={3}
              value={feedback}
              disabled={isRegenerating}
              maxLength={LESSON_FEEDBACK_MAX_LENGTH}
              placeholder={t('plan.regenerate.feedback.placeholder')}
              aria-describedby={feedbackHintId}
              onChange={(event) => {
                setFeedback(event.target.value);
              }}
            />
            <span className="lt-field__hint" id={feedbackHintId}>
              {t('plan.regenerate.feedback.hint')}
            </span>
          </div>

          {hasStartedSteps && (
            <div className="lt-field">
              <span>
                <input
                  id={keepId}
                  type="checkbox"
                  checked={keepCompletedSteps}
                  disabled={isRegenerating}
                  onChange={(event) => {
                    setKeepCompletedSteps(event.target.checked);
                  }}
                />{' '}
                <label htmlFor={keepId}>{t('plan.regenerate.keepCompleted.label')}</label>
              </span>
              <span className="lt-field__hint">{t('plan.regenerate.keepCompleted.hint')}</span>
            </div>
          )}

          <div className="lt-field">
            <span>
              <input
                id={coveredId}
                type="checkbox"
                checked={includeCoveredMaterial}
                disabled={isRegenerating}
                aria-describedby={coveredHintId}
                onChange={(event) => {
                  setIncludeCoveredMaterial(event.target.checked);
                }}
              />{' '}
              <label htmlFor={coveredId}>{t('plan.regenerate.includeCovered.label')}</label>
            </span>
            <span className="lt-field__hint" id={coveredHintId}>
              {t('plan.regenerate.includeCovered.hint')}
            </span>
          </div>

          {isRegenerating && (
            <LoadingBlock label={t('plan.regenerate.pending.title')}>
              <p className="lt-status">{t('plan.regenerate.pending.description')}</p>
              {model && (
                <p className="lt-status">{t('plan.regenerate.pending.model', { model })}</p>
              )}
            </LoadingBlock>
          )}

          {regenerateError !== null && regenerateError !== undefined && (
            <div className="lt-banner lt-banner--error" role="alert">
              <p className="lt-banner__title">{t('plan.regenerate.errors.failed')}</p>
              <p>{toErrorMessage(regenerateError)}</p>
              {regenerateHint !== null && <p>{t(regenerateHint)}</p>}
            </div>
          )}

          {/* Завершённый урок сервер пересобирать отказывается (409): говорим об этом заранее. */}
          {isCompleted && <p className="lt-status">{t('errors.lessonCompleted')}</p>}
          {!isCompleted && !canRegenerate && (
            <p className="lt-status">{t('plan.regenerate.unavailable')}</p>
          )}
          {!isCompleted && canRegenerate && (
            <button type="submit" className="lt-button" disabled={isRegenerating}>
              {t('plan.regenerate.submit')}
            </button>
          )}
        </form>
      </section>
    </>
  );
}
