/**
 * Диалог определения уровня: лента «вопрос — ответ», прогресс и ввод ответа.
 *
 * Лента объявлена как `role="log"` с `aria-live="polite"`: новый вопрос,
 * разбор ответа и состояние «тьютор думает» читаются экранной читалкой сами,
 * без перевода фокуса — ученик в это время печатает ответ.
 *
 * Ввод вынесен в слот `renderInput`: по умолчанию это текстовое поле, но тот же
 * компонент принимает кнопку «говорить» из голосового пакета — ему достаточно
 * вызвать `onSubmit` с распознанным текстом и уважать `disabled`.
 */
import { useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';

import type { PlacementTurn } from '@lt/shared';

import type { ApiError } from '../../api/client';
import { PLACEMENT_ANSWER_MAX_LENGTH } from '../../api/placement';
import { useT } from '../../i18n/useT';
import { usePlacementErrorMessage, type PlacementAnswerOptions } from './usePlacement';

/**
 * Что слот ввода получает от диалога.
 *
 * `onSubmit(text)` — весь обязательный договор со слотом; второй аргумент
 * необязателен и нужен голосовому вводу, чтобы пометить ответ как распознанный
 * (`source: 'voice'`) и передать длительность реплики.
 */
export interface PlacementInputSlotProps {
  /** Отправляет ответ на текущий вопрос. */
  onSubmit: (text: string, options?: PlacementAnswerOptions) => void;
  /** Ввод заблокирован: идёт запрос или вопросов больше нет. */
  disabled: boolean;
}

/** Свойства диалога определения уровня. */
export interface PlacementChatProps {
  /** Уже заданные вопросы вместе с ответами — история диалога. */
  history: readonly PlacementTurn[];
  /** Вопрос, на который ждут ответа; `null` — вопросы кончились. */
  currentTurn: PlacementTurn | null;
  /** Номер текущего вопроса, с единицы. */
  questionNumber: number;
  /** Сколько вопросов планируется задать всего. */
  maxTurns: number;
  /** Ответ ушёл на сервер, тьютор готовит следующий вопрос. */
  isAnswering: boolean;
  /** Идёт завершение теста и подсчёт уровня. */
  isFinishing: boolean;
  /** Отказ сервера; текст для пользователя собирает сам диалог. */
  error?: ApiError | null;
  /** Повторить последнее действие; не задан — повторять нечего. */
  onRetry?: () => void;
  /** Отправка ответа на текущий вопрос. */
  onSubmit: (text: string, options?: PlacementAnswerOptions) => void;
  /** Завершить тест, не отвечая на оставшиеся вопросы. */
  onFinish: () => void;
  /** Замена поля ввода: сюда встраивается голосовой ввод. */
  renderInput?: (props: PlacementInputSlotProps) => ReactNode;
}

/** Свойства поля ввода ответа. */
interface PlacementTextInputProps extends PlacementInputSlotProps {
  /** Идентификатор для связи подписи, подсказки и ошибки с полем. */
  fieldId: string;
}

/** Поле ввода ответа по умолчанию: текст, который отправляется кнопкой или Ctrl+Enter. */
function PlacementTextInput({ fieldId, onSubmit, disabled }: PlacementTextInputProps) {
  const t = useT('placement');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  const submit = (): void => {
    const text = draft.trim();

    if (text.length === 0) {
      setError(t('chat.input.empty'));

      return;
    }

    if (text.length > PLACEMENT_ANSWER_MAX_LENGTH) {
      setError(t('chat.input.tooLong', { max: PLACEMENT_ANSWER_MAX_LENGTH }));

      return;
    }

    setError(null);
    setDraft('');
    onSubmit(text);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Перевод строки в ответе нужен, поэтому отправляет сочетание, а не Enter.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="lt-field">
        <label className="lt-field__label" htmlFor={fieldId}>
          {t('chat.input.label')}
        </label>
        <textarea
          id={fieldId}
          rows={3}
          value={draft}
          disabled={disabled}
          maxLength={PLACEMENT_ANSWER_MAX_LENGTH}
          placeholder={t('chat.input.placeholder')}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={handleKeyDown}
        />
        <p className="lt-field__hint" id={hintId}>
          {t('chat.input.hint')}
        </p>
        {error && (
          <p className="lt-field__error" id={errorId} role="alert">
            {error}
          </p>
        )}
      </div>
      <button type="submit" className="lt-button" disabled={disabled}>
        {t('chat.input.submit')}
      </button>
    </form>
  );
}

/** Одна запись ленты: вопрос тьютора и, если он уже дан, ответ ученика с разбором. */
function PlacementTurnItem({ turn }: { turn: PlacementTurn }) {
  const t = useT('placement');
  const answer = turn.answer?.trim() ?? '';
  const feedback = turn.feedback?.trim() ?? '';

  return (
    <li className="lt-list__item">
      <div>
        <p>
          <strong>{t('chat.question', { number: turn.order + 1 })}</strong> {turn.question}
        </p>
        {answer.length > 0 && (
          <p>
            <strong>{t('chat.answer')}</strong> {answer}
          </p>
        )}
        {feedback.length > 0 && <p className="lt-status">{feedback}</p>}
      </div>
    </li>
  );
}

/** Диалог определения уровня: лента, прогресс, ввод ответа и досрочное завершение. */
export function PlacementChat({
  history,
  currentTurn,
  questionNumber,
  maxTurns,
  isAnswering,
  isFinishing,
  error = null,
  onRetry,
  onSubmit,
  onFinish,
  renderInput,
}: PlacementChatProps) {
  const t = useT('placement');
  const toErrorMessage = usePlacementErrorMessage();
  const fieldId = useId();
  const isBusy = isAnswering || isFinishing;
  const inputDisabled = isBusy || currentTurn === null;
  const slotProps: PlacementInputSlotProps = { onSubmit, disabled: inputDisabled };

  return (
    <section className="lt-card" aria-labelledby="lt-placement-chat-title">
      <h2 id="lt-placement-chat-title">{t('chat.title')}</h2>

      <p className="lt-status">
        {t('chat.progress', {
          current: Math.min(Math.max(questionNumber, 1), maxTurns),
          total: maxTurns,
        })}
      </p>

      <div role="log" aria-live="polite" aria-busy={isBusy} aria-label={t('chat.logLabel')}>
        <ol className="lt-list">
          {history.map((turn) => (
            <PlacementTurnItem key={turn.id} turn={turn} />
          ))}
          {currentTurn && <PlacementTurnItem key={currentTurn.id} turn={currentTurn} />}
        </ol>

        {isAnswering && <p className="lt-status">{t('chat.thinking')}</p>}
        {isFinishing && <p className="lt-status">{t('chat.finishing')}</p>}
        {!isBusy && currentTurn === null && <p className="lt-status">{t('chat.allAnswered')}</p>}
      </div>

      {error !== null && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p>{toErrorMessage(error)}</p>
          <p>{t('errors.progressKept')}</p>
          {onRetry && (
            <button type="button" className="lt-button" disabled={isBusy} onClick={onRetry}>
              {t('common:actions.retry')}
            </button>
          )}
        </div>
      )}

      {renderInput ? (
        renderInput(slotProps)
      ) : (
        <PlacementTextInput fieldId={fieldId} onSubmit={onSubmit} disabled={inputDisabled} />
      )}

      <div className="lt-toolbar">
        <button type="button" className="lt-button" disabled={isBusy} onClick={onFinish}>
          {currentTurn === null ? t('chat.finish') : t('chat.finishEarly')}
        </button>
      </div>
    </section>
  );
}
