/**
 * Задание урока: формулировка, ответ ученика и разбор от тьютора.
 *
 * Отдельного эндпоинта генерации заданий в контракте нет: задания приходят
 * в ответах на реплику и на переход к следующему шагу, поэтому панель только
 * показывает уже выданное задание и отправляет попытку.
 *
 * Поле ответа зависит от вида задания: перевод и вопрос-ответ — текст,
 * подстановка — строка, множественный выбор — радиогруппа (её обходят
 * стрелками с клавиатуры), свободная речь — голос с правкой расшифровки
 * перед отправкой.
 */
import { useId, useRef, useState, type FormEvent } from 'react';

import type { Exercise, LanguageCode } from '@lt/shared';

import { FeedbackCard } from './FeedbackCard';
import {
  useLessonSessionErrorMessage,
  useVoiceDraft,
  type ExerciseFeedback,
  type LessonAnswerOptions,
} from './useLessonSession';

import type { ApiError } from '../../api/client';
import { EXERCISE_ANSWER_MAX_LENGTH } from '../../api/lessonSession';
import { useT } from '../../i18n/useT';
import { PushToTalkButton } from '../voice/PushToTalkButton';
import type { VoiceFailure } from '../voice/useVoiceInput';

/** Свойства панели задания. */
export interface ExercisePanelProps {
  /** Задание, которое выполняет ученик; `null` — заданий пока нет. */
  exercise: Exercise | null;
  /** Разбор последнего ответа; `null` — ответа ещё не было. */
  feedback?: ExerciseFeedback | null;
  /** Язык речи ученика — изучаемый язык урока. */
  language: LanguageCode;
  /** Урок, к которому относится запись: необязательное поле контракта STT. */
  lessonId?: string;
  /** Ответ отправлен, тьютор его проверяет. */
  isSubmitting?: boolean;
  /** Тьютор сейчас говорит. */
  isSpeaking?: boolean;
  /** Отвечать нельзя: урок не идёт или занят другим запросом. */
  disabled?: boolean;
  /** Отказ проверки ответа; текст для пользователя собирает сама панель. */
  error?: ApiError | null;
  /** Повторить отправку ответа. */
  onRetry?: () => void;
  /** Прервать озвучивание: удержание кнопки записи глушит тьютора. */
  onStopSpeaking?: () => void;
  /** Отказ озвучивания: показывается рядом с состоянием голосового ввода. */
  ttsFailure?: VoiceFailure | null;
  /** Отправка ответа на задание. */
  onSubmit: (answer: string, options: LessonAnswerOptions) => void;
  /** Перейти к следующему заданию. */
  onNext?: () => void;
}

/** Панель задания: формулировка, поле ответа по виду задания и разбор. */
export function ExercisePanel({
  exercise,
  feedback = null,
  language,
  lessonId,
  isSubmitting = false,
  isSpeaking = false,
  disabled = false,
  error = null,
  onRetry,
  onStopSpeaking,
  ttsFailure = null,
  onSubmit,
  onNext,
}: ExercisePanelProps) {
  const t = useT('lessonRoom');
  const toErrorMessage = useLessonSessionErrorMessage();
  const fieldId = useId();
  const draft = useVoiceDraft();
  const [choice, setChoice] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);

  if (!exercise) {
    return (
      <section className="lt-card" aria-labelledby="lt-lesson-exercise-title">
        <h2 id="lt-lesson-exercise-title">{t('exercise.title')}</h2>
        <p className="lt-placeholder">{t('exercise.empty')}</p>
      </section>
    );
  }

  const isChoice = exercise.type === 'multiple_choice' && exercise.options.length > 0;
  const isVoice = exercise.type === 'free_speech';
  const answer = isChoice ? choice : draft.text;
  const blocked = disabled || isSubmitting;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const attemptOfExercise = feedback?.exercise.id === exercise.id ? feedback : null;

  const submit = (): void => {
    const text = answer.trim();

    if (text.length === 0) {
      setInputError(isChoice ? t('exercise.errors.noChoice') : t('exercise.errors.empty'));

      return;
    }

    if (text.length > EXERCISE_ANSWER_MAX_LENGTH) {
      setInputError(t('exercise.errors.tooLong', { max: EXERCISE_ANSWER_MAX_LENGTH }));

      return;
    }

    setInputError(null);
    onSubmit(text, { source: isChoice ? 'text' : draft.source, durationMs: draft.durationMs });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (blocked) {
      return;
    }

    submit();
  };

  return (
    <section className="lt-card" aria-labelledby="lt-lesson-exercise-title">
      <h2 id="lt-lesson-exercise-title">{t('exercise.title')}</h2>

      <p>
        <span className="lt-badge">{t(`exercise.types.${exercise.type}`)}</span>{' '}
        {exercise.level && <span className="lt-badge lt-badge--muted">{exercise.level}</span>}
      </p>

      <h3 style={{ marginTop: 0, fontSize: '1rem' }}>{exercise.prompt}</h3>

      {exercise.instructions && <p className="lt-status">{exercise.instructions}</p>}

      {exercise.hints.length > 0 && (
        <ul className="lt-chips" aria-label={t('exercise.hints')}>
          {exercise.hints.map((hint) => (
            <li className="lt-chip" key={hint}>
              {hint}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit} noValidate>
        {isChoice ? (
          <fieldset className="lt-field" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="lt-field__label">{t('exercise.answer.choiceLabel')}</legend>
            {exercise.options.map((option, index) => (
              <label
                className="lt-field__hint"
                htmlFor={`${fieldId}-option-${index}`}
                key={option}
                style={{ display: 'block', color: 'inherit' }}
              >
                <input
                  id={`${fieldId}-option-${index}`}
                  type="radio"
                  name={`${fieldId}-options`}
                  value={option}
                  checked={choice === option}
                  disabled={blocked}
                  onChange={() => {
                    setChoice(option);
                    setInputError(null);
                  }}
                />{' '}
                {option}
              </label>
            ))}
            {inputError && (
              <p className="lt-field__error" id={errorId} role="alert">
                {inputError}
              </p>
            )}
          </fieldset>
        ) : (
          <div className="lt-field">
            <label className="lt-field__label" htmlFor={fieldId}>
              {t('exercise.answer.label')}
            </label>
            <textarea
              id={fieldId}
              ref={fieldRef}
              rows={isVoice ? 3 : 2}
              value={draft.text}
              disabled={blocked}
              maxLength={EXERCISE_ANSWER_MAX_LENGTH}
              placeholder={t('exercise.answer.placeholder')}
              aria-describedby={inputError ? `${hintId} ${errorId}` : hintId}
              aria-invalid={inputError ? true : undefined}
              onChange={(event) => {
                draft.setText(event.target.value);
                setInputError(null);
              }}
            />
            <p className="lt-field__hint" id={hintId}>
              {isVoice ? t('exercise.answer.voiceHint') : t('exercise.answer.hint')}
            </p>
            {inputError && (
              <p className="lt-field__error" id={errorId} role="alert">
                {inputError}
              </p>
            )}
          </div>
        )}

        <div className="lt-toolbar">
          <button type="submit" className="lt-button" disabled={blocked}>
            {isSubmitting ? t('exercise.actions.checking') : t('exercise.actions.submit')}
          </button>
          {onNext && attemptOfExercise && (
            <button type="button" className="lt-button" disabled={blocked} onClick={onNext}>
              {attemptOfExercise.nextExercise
                ? t('exercise.actions.next')
                : t('exercise.actions.backToDialogue')}
            </button>
          )}
        </div>
      </form>

      {isVoice && (
        <PushToTalkButton
          mode="toggle"
          language={language}
          lessonId={lessonId}
          prompt={exercise.prompt}
          busy={isSubmitting}
          speaking={isSpeaking}
          disabled={disabled}
          ttsFailure={ttsFailure}
          onInterruptSpeaking={onStopSpeaking}
          onResult={(result) => {
            draft.applyVoiceResult(result);
            setInputError(null);
            // Расшифровка почти всегда требует правки: курсор сразу в поле.
            fieldRef.current?.focus();
          }}
        />
      )}

      {error !== null && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p className="lt-banner__title">{t('exercise.errors.attemptFailed')}</p>
          <p>{toErrorMessage(error)}</p>
          {onRetry && (
            <button type="button" className="lt-button" disabled={blocked} onClick={onRetry}>
              {t('common:actions.retry')}
            </button>
          )}
        </div>
      )}

      {attemptOfExercise && (
        <FeedbackCard
          corrections={attemptOfExercise.attempt.corrections}
          isCorrect={attemptOfExercise.attempt.isCorrect}
          score={attemptOfExercise.attempt.score}
          feedback={attemptOfExercise.attempt.feedback}
        />
      )}
    </section>
  );
}
