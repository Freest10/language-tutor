/**
 * Диалог создания урока: тема, материалы, акценты и длительность.
 *
 * Диалог модальный: `role="dialog"` с `aria-modal`, фокус уходит внутрь и не
 * покидает его по Tab, Escape закрывает, а после закрытия фокус возвращается
 * туда, откуда диалог открыли.
 *
 * Генерация плана идёт через локальную языковую модель и занимает десятки
 * секунд, поэтому ожидание показано явно — скелетоном и строкой `role="status"`.
 * Без этого пользователь решает, что приложение зависло, и уходит со страницы,
 * оборвав запрос.
 *
 * Необработанный материал сервер не пропускает молча: он отвечает 400
 * `materials_not_ready` и урок не создаёт. Диалог перечисляет такие материалы
 * с их статусом — иначе непонятно, почему урок не строится на загруженном скане.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';

import {
  LESSON_STEP_TYPES,
  type CreateLessonRequest,
  type Lesson,
  type LessonStepType,
} from '@lt/shared';

import { MaterialPicker } from './MaterialPicker';
import {
  LESSON_DURATION_OPTIONS,
  isLlmSetupError,
  useCreateLesson,
  useLessonErrorMessage,
  useLessonGenerationReadiness,
  useLessonStepText,
  type LessonDuration,
} from './useLessons';

import { LESSON_TOPIC_MAX_LENGTH, notReadyMaterials } from '../../api/lessons';
import { useT } from '../../i18n/useT';

/**
 * Свойства диалога создания урока.
 *
 * Диалог монтируется только открытым: страница рисует его по своему состоянию.
 * Так черновик формы и состояние генерации начинаются заново при каждом
 * открытии, а закрытие не оставляет за собой невидимый диалог.
 */
export interface CreateLessonDialogProps {
  /** Закрыть диалог: кнопка отмены, Escape, крестик. */
  onClose: () => void;
  /** Урок создан и его план можно открыть. */
  onCreated: (lesson: Lesson) => void;
}

/** Длительность урока по умолчанию, минуты. */
const DEFAULT_DURATION: LessonDuration = 30;

/** Что фокусируется внутри диалога: ловушка Tab перебирает именно эти элементы. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Интерактивные элементы диалога в порядке обхода. */
function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) {
    return [];
  }

  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

/** Диалог создания урока с генерацией плана. */
export function CreateLessonDialog({ onClose, onCreated }: CreateLessonDialogProps) {
  const t = useT('lessons');
  const toErrorMessage = useLessonErrorMessage();
  const stepText = useLessonStepText();
  const readiness = useLessonGenerationReadiness();
  const create = useCreateLesson();

  const dialogRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;
  const topicId = `${baseId}-topic`;
  const topicHintId = `${baseId}-topic-hint`;
  const focusHintId = `${baseId}-focus-hint`;

  const [topic, setTopic] = useState('');
  const [materialIds, setMaterialIds] = useState<readonly string[]>([]);
  const [focus, setFocus] = useState<readonly LessonStepType[]>([]);
  const [duration, setDuration] = useState<LessonDuration>(DEFAULT_DURATION);

  useEffect(() => {
    // Фокус уходит в диалог, а при закрытии возвращается туда, откуда его открыли.
    const previouslyFocused = document.activeElement;

    dialogRef.current?.focus();

    return () => {
      if (previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus();
      }
    };
  }, []);

  // Материалы, из-за которых сервер отказался планировать урок (400).
  const notReady = useMemo(() => notReadyMaterials(create.error), [create.error]);
  const isBusy = create.isPending;
  // Кнопку генерации прячем, только когда сервер прямо сказал, что модели нет:
  // при неизвестной конфигурации попытку стоит дать.
  const canSubmit = readiness.isAvailable || readiness.isUnknown || readiness.isChecking;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();

      return;
    }

    if (event.key !== 'Tab') {
      return;
    }

    const focusable = focusableElements(dialogRef.current);

    if (focusable.length === 0) {
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (!first || !last) {
      return;
    }

    if (event.shiftKey && (active === first || active === dialogRef.current)) {
      event.preventDefault();
      last.focus();

      return;
    }

    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const toggleFocus = (type: LessonStepType, selected: boolean): void => {
    setFocus((current) =>
      selected ? [...current, type] : current.filter((item) => item !== type),
    );
  };

  const submit = (): void => {
    const trimmedTopic = topic.trim();
    const body: CreateLessonRequest = { durationMinutes: duration };

    if (trimmedTopic.length > 0) {
      body.topic = trimmedTopic;
    }

    if (materialIds.length > 0) {
      body.materialIds = [...materialIds];
    }

    if (focus.length > 0) {
      body.focus = [...focus];
    }

    create.mutate(body, { onSuccess: onCreated });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    submit();
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 'var(--lt-space-lg)',
        overflow: 'auto',
        background: 'rgb(0 0 0 / 45%)',
        zIndex: 10,
      }}
    >
      <div
        ref={dialogRef}
        className="lt-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={isBusy}
        tabIndex={-1}
        style={{ width: 'min(40rem, 100%)' }}
        onKeyDown={handleKeyDown}
      >
        <div className="lt-toolbar">
          <h2 id={titleId} style={{ margin: 0, flexGrow: 1 }}>
            {t('create.title')}
          </h2>
          <button type="button" className="lt-button" disabled={isBusy} onClick={onClose}>
            {t('common:actions.close')}
          </button>
        </div>
        <p id={descriptionId} className="lt-page__lead">
          {t('create.description')}
        </p>

        {readiness.isChecking && (
          <p className="lt-status" role="status">
            {t('create.llm.checking')}
          </p>
        )}

        {readiness.isUnknown && (
          <div className="lt-banner" role="status">
            <p>{t('create.llm.unknown')}</p>
          </div>
        )}

        {!readiness.isChecking && !readiness.isUnknown && !readiness.isAvailable && (
          <div className="lt-banner lt-banner--error" role="alert">
            <p className="lt-banner__title">{t('create.llm.unavailable.title')}</p>
            <p>{t('create.llm.unavailable.description')}</p>
            {readiness.reason && <p>{readiness.reason}</p>}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="lt-field">
            <label className="lt-field__label" htmlFor={topicId}>
              {t('create.topic.label')}
            </label>
            <input
              id={topicId}
              type="text"
              value={topic}
              disabled={isBusy}
              maxLength={LESSON_TOPIC_MAX_LENGTH}
              placeholder={t('create.topic.placeholder')}
              aria-describedby={topicHintId}
              onChange={(event) => {
                setTopic(event.target.value);
              }}
            />
            <span className="lt-field__hint" id={topicHintId}>
              {t('create.topic.hint')}
            </span>
          </div>

          <MaterialPicker selectedIds={materialIds} onChange={setMaterialIds} disabled={isBusy} />

          <fieldset
            className="lt-field"
            style={{ border: 0, margin: '0 0 var(--lt-space-md)', padding: 0 }}
            disabled={isBusy}
          >
            <legend className="lt-field__label">{t('create.focus.label')}</legend>
            <p className="lt-field__hint" id={focusHintId}>
              {t('create.focus.hint')}
            </p>
            <ul className="lt-chips" aria-describedby={focusHintId}>
              {LESSON_STEP_TYPES.map((type) => {
                const selected = focus.includes(type);
                const optionId = `${baseId}-focus-${type}`;

                return (
                  <li key={type} className={selected ? 'lt-chip lt-chip--selected' : 'lt-chip'}>
                    <input
                      id={optionId}
                      type="checkbox"
                      checked={selected}
                      onChange={(event) => {
                        toggleFocus(type, event.target.checked);
                      }}
                    />
                    <label htmlFor={optionId}>{stepText.typeLabel(type)}</label>
                  </li>
                );
              })}
            </ul>
          </fieldset>

          <fieldset
            className="lt-field"
            style={{ border: 0, margin: '0 0 var(--lt-space-md)', padding: 0 }}
            disabled={isBusy}
          >
            <legend className="lt-field__label">{t('create.duration.label')}</legend>
            <ul className="lt-chips">
              {LESSON_DURATION_OPTIONS.map((minutes) => {
                const selected = minutes === duration;
                const optionId = `${baseId}-duration-${minutes}`;

                return (
                  <li key={minutes} className={selected ? 'lt-chip lt-chip--selected' : 'lt-chip'}>
                    <input
                      id={optionId}
                      type="radio"
                      name={`${baseId}-duration`}
                      value={minutes}
                      checked={selected}
                      onChange={() => {
                        setDuration(minutes);
                      }}
                    />
                    <label htmlFor={optionId}>
                      {t('common:units.minutes', { count: minutes })}
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>

          {isBusy && (
            <div className="lt-card" style={{ marginBottom: 'var(--lt-space-md)' }}>
              <p role="status" style={{ marginTop: 0 }}>
                {t('create.generating.title')}
              </p>
              <p className="lt-status">{t('create.generating.description')}</p>
              {readiness.model && (
                <p className="lt-status">
                  {t('create.generating.model', { model: readiness.model })}
                </p>
              )}
              <p
                className="lt-skeleton"
                aria-hidden="true"
                style={{ height: '1rem', marginBottom: 'var(--lt-space-sm)' }}
              />
              <p
                className="lt-skeleton"
                aria-hidden="true"
                style={{ height: '1rem', marginBottom: 'var(--lt-space-sm)' }}
              />
              <p className="lt-skeleton" aria-hidden="true" style={{ height: '1rem', margin: 0 }} />
            </div>
          )}

          {create.isError && (
            <div className="lt-banner lt-banner--error" role="alert">
              <p className="lt-banner__title">{t('create.errors.failed')}</p>
              <p>{toErrorMessage(create.error)}</p>
              {notReady.length > 0 && (
                <>
                  <p>{t('create.notReady.description')}</p>
                  <ul className="lt-banner__list">
                    {notReady.map((item) => (
                      <li key={item.id}>
                        <strong>{item.title ?? item.id}</strong>
                        {item.status ? ` — ${t(`materials.status.${item.status}.label`)}` : ''}{' '}
                        {item.status ? t(`materials.status.${item.status}.hint`) : ''}{' '}
                        {item.statusMessage ?? ''}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {isLlmSetupError(create.error) && <p>{t('errors.setupHint')}</p>}
            </div>
          )}

          <div className="lt-toolbar">
            {canSubmit && (
              <button type="submit" className="lt-button" disabled={isBusy || readiness.isChecking}>
                {t('create.submit')}
              </button>
            )}
            <button type="button" className="lt-button" disabled={isBusy} onClick={onClose}>
              {t('common:actions.cancel')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
