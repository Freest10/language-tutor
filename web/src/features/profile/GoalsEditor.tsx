/**
 * Редактор списка коротких формулировок: целей обучения или интересов.
 *
 * Оба списка устроены одинаково — свободный текст плюс готовые варианты, —
 * поэтому компонент один, а подписи, пресеты и ограничения выбираются по `field`.
 * Значение хранится ровно так, как его ввёл пользователь: тьютор использует
 * эти строки как есть, поэтому нормализация ограничена обрезкой пробелов.
 *
 * Клавиатура: `Enter` в поле ввода добавляет значение и не отправляет форму,
 * готовые варианты — кнопки-переключатели с `aria-pressed`, удаление возвращает
 * фокус в поле ввода, чтобы он не терялся вместе с удалённой кнопкой.
 */
import { useRef, useState, type KeyboardEvent } from 'react';

import {
  MAX_LEARNER_GOALS,
  MAX_LEARNER_INTERESTS,
  learnerGoalSchema,
  learnerInterestSchema,
} from '@lt/shared';

import { useT } from '../../i18n/useT';

/** Какой список редактируется: от него зависят подписи, пресеты и ограничения. */
export type ListField = 'goals' | 'interests';

/** Свойства редактора списка. */
export interface GoalsEditorProps {
  /** Редактируемый список: цели обучения или интересы. */
  field: ListField;
  /** Текущие значения списка. */
  values: readonly string[];
  /** Новый список после добавления, удаления или переключения пресета. */
  onChange: (values: readonly string[]) => void;
  /** Ошибка списка целиком (например, «нужна хотя бы одна цель»). */
  error?: string | null;
  /** Блокирует редактирование — например, на время сохранения. */
  disabled?: boolean;
}

/** Готовые варианты: ключи внутри `<field>.presets` в namespace `profile`. */
const PRESET_KEYS: Record<ListField, readonly string[]> = {
  goals: ['interview', 'travel', 'work', 'study', 'relocation', 'smallTalk'],
  interests: ['movies', 'music', 'sports', 'technology', 'cooking', 'books'],
};

/** Схема одного значения: она же ограничивает длину поля ввода. */
const ITEM_SCHEMAS: Record<ListField, typeof learnerGoalSchema> = {
  goals: learnerGoalSchema,
  interests: learnerInterestSchema,
};

/** Сколько значений допускает контракт профиля. */
const MAX_ITEMS: Record<ListField, number> = {
  goals: MAX_LEARNER_GOALS,
  interests: MAX_LEARNER_INTERESTS,
};

/** Редактор целей обучения или интересов: чипы, свободный ввод и пресеты. */
export function GoalsEditor({ field, values, onChange, error, disabled }: GoalsEditorProps) {
  const t = useT('profile');
  const [text, setText] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const itemSchema = ITEM_SCHEMAS[field];
  const maxItems = MAX_ITEMS[field];
  const inputId = `lt-profile-${field}-input`;
  const hintId = `lt-profile-${field}-hint`;
  const errorId = `lt-profile-${field}-error`;
  const message = error ?? localError;

  /** Добавляет значение в список; `false` — значение отклонено с пояснением. */
  const addValue = (raw: string): boolean => {
    const value = raw.trim();

    if (value.length === 0) {
      setLocalError(t(`${field}.errors.empty`));

      return false;
    }

    if (values.length >= maxItems) {
      setLocalError(t(`${field}.errors.tooMany`, { max: maxItems }));

      return false;
    }

    if (!itemSchema.safeParse(value).success) {
      setLocalError(t(`${field}.errors.tooLong`, { max: itemSchema.maxLength ?? 0 }));

      return false;
    }

    if (values.some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) {
      setLocalError(t(`${field}.errors.duplicate`));

      return false;
    }

    setLocalError(null);
    onChange([...values, value]);

    return true;
  };

  /** Убирает значение и возвращает фокус в поле ввода. */
  const removeValue = (value: string): void => {
    setLocalError(null);
    onChange(values.filter((item) => item !== value));
    inputRef.current?.focus();
  };

  const submitText = (): void => {
    if (addValue(text)) {
      setText('');
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      // Иначе Enter в поле ввода отправил бы форму профиля целиком.
      event.preventDefault();
      submitText();
    }
  };

  return (
    <fieldset disabled={disabled}>
      <legend>{t(`${field}.label`)}</legend>
      <p id={hintId}>{t(`${field}.hint`)}</p>

      {values.length === 0 ? (
        <p className="lt-placeholder">{t(`${field}.empty`)}</p>
      ) : (
        <ul aria-label={t(`${field}.listLabel`)}>
          {values.map((value) => (
            <li key={value}>
              <span>{value}</span>{' '}
              <button
                type="button"
                className="lt-button"
                aria-label={t(`${field}.remove`, { value })}
                onClick={() => {
                  removeValue(value);
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p>{t(`${field}.counter`, { current: values.length, max: maxItems })}</p>

      <div>
        <label htmlFor={inputId}>{t(`${field}.addLabel`)}</label>{' '}
        <input
          id={inputId}
          ref={inputRef}
          type="text"
          value={text}
          maxLength={itemSchema.maxLength ?? undefined}
          placeholder={t(`${field}.placeholder`)}
          aria-describedby={message ? `${hintId} ${errorId}` : hintId}
          aria-invalid={message ? true : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setLocalError(null);
          }}
          onKeyDown={handleKeyDown}
        />{' '}
        <button type="button" className="lt-button" onClick={submitText}>
          {t(`${field}.add`)}
        </button>
      </div>

      {message !== null && message !== undefined && (
        <p id={errorId} role="alert">
          {message}
        </p>
      )}

      <div role="group" aria-label={t(`${field}.presetsLabel`)}>
        {PRESET_KEYS[field].map((key) => {
          const preset = t(`${field}.presets.${key}`);
          const selected = values.includes(preset);

          return (
            <button
              key={key}
              type="button"
              className="lt-button"
              aria-pressed={selected}
              onClick={() => {
                if (selected) {
                  setLocalError(null);
                  onChange(values.filter((item) => item !== preset));
                } else {
                  addValue(preset);
                }
              }}
            >
              {preset}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
