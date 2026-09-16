/**
 * Форма профиля: три языка (A12), уровень CEFR, цели, интересы и дневная норма.
 *
 * Форма держит черновик и отправляет только изменённые поля — контракт
 * `PUT /api/profile` частичный. Черновик пересобирается, как только приходит
 * новый профиль: и после успешного сохранения, и после отката оптимистичного
 * обновления, — поэтому на экране всегда то, что реально лежит на сервере.
 *
 * Проверки идут по схемам `@lt/shared` до отправки: сначала поля по отдельности
 * (чтобы показать понятное сообщение рядом с полем), затем собранное тело
 * запроса целиком через `updateProfileRequestSchema`.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import {
  CEFR_LEVELS,
  LANGUAGE_LABELS,
  MAX_DAILY_MINUTES,
  MAX_LEARNER_GOALS,
  MAX_LEARNER_INTERESTS,
  MIN_DAILY_MINUTES,
  dailyMinutesSchema,
  updateProfileRequestSchema,
  type CefrLevel,
  type LanguageOption,
  type LearnerProfile,
  type UpdateProfileRequest,
} from '@lt/shared';

import { GoalsEditor } from './GoalsEditor';
import { LevelBadge } from './LevelBadge';

import type { ApiError } from '../../api/client';
import { UI_LOCALES, isUiLocale, readStoredLocale, toUiLocale } from '../../i18n';
import { useApiErrorMessage, useLocale, useT } from '../../i18n/useT';
import { ROUTE_PATHS } from '../../router';

/** Свойства формы профиля. */
export interface ProfileFormProps {
  /** Профиль с сервера; при оптимистичном обновлении — уже изменённый. */
  profile: LearnerProfile;
  /** Языки для выбора: обычно `supportedLanguages` из `GET /api/config`. */
  languages: readonly LanguageOption[];
  /** Идёт сохранение: поля заблокированы, кнопка недоступна. */
  isSaving?: boolean;
  /** Последнее сохранение прошло успешно — показываем подтверждение. */
  isSaved?: boolean;
  /** Отказ сохранения; текст для пользователя собирает сама форма. */
  saveError?: ApiError | null;
  /** Отправка изменённых полей профиля. */
  onSave: (changes: UpdateProfileRequest) => void;
}

/** Черновик формы: `dailyMinutes` — строка, поле ввода может быть пустым. */
interface ProfileDraft {
  learningLanguage: string;
  interfaceLanguage: string;
  explanationLanguage: string;
  level: CefrLevel;
  goals: readonly string[];
  interests: readonly string[];
  dailyMinutes: string;
}

/** Ошибка поля: ключ перевода и подстановки к нему. */
interface FieldError {
  key: string;
  params?: Record<string, number>;
}

/** Ошибки полей формы. */
type ProfileErrors = Partial<Record<'goals' | 'interests' | 'dailyMinutes', FieldError>>;

/** Черновик по профилю с сервера. */
function toDraft(profile: LearnerProfile): ProfileDraft {
  return {
    learningLanguage: profile.learningLanguage,
    interfaceLanguage: profile.interfaceLanguage,
    explanationLanguage: profile.explanationLanguage,
    level: profile.level,
    goals: [...profile.goals],
    interests: [...profile.interests],
    dailyMinutes: String(profile.dailyMinutes),
  };
}

/** Значение селекта как уровень CEFR; `null` — значение не из списка. */
function toCefrLevel(value: string): CefrLevel | null {
  return CEFR_LEVELS.find((level) => level === value) ?? null;
}

/** Дневная норма как целое число; `NaN` — поле пустое или не число. */
function toMinutes(value: string): number {
  return Number.parseInt(value, 10);
}

/** Совпадают ли списки по составу и порядку. */
function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** Проверяет черновик схемами `@lt/shared`: сообщение готовится для каждого поля. */
function validateDraft(draft: ProfileDraft): ProfileErrors {
  const errors: ProfileErrors = {};

  if (draft.goals.length === 0) {
    errors.goals = { key: 'goals.errors.required' };
  } else if (draft.goals.length > MAX_LEARNER_GOALS) {
    errors.goals = { key: 'goals.errors.tooMany', params: { max: MAX_LEARNER_GOALS } };
  }

  if (draft.interests.length > MAX_LEARNER_INTERESTS) {
    errors.interests = { key: 'interests.errors.tooMany', params: { max: MAX_LEARNER_INTERESTS } };
  }

  if (!dailyMinutesSchema.safeParse(toMinutes(draft.dailyMinutes)).success) {
    errors.dailyMinutes = {
      key: 'dailyMinutes.error',
      params: { min: MIN_DAILY_MINUTES, max: MAX_DAILY_MINUTES },
    };
  }

  return errors;
}

/** Тело `PUT /api/profile`: только поля, отличающиеся от сохранённого профиля. */
function buildChanges(profile: LearnerProfile, draft: ProfileDraft): UpdateProfileRequest {
  const changes: UpdateProfileRequest = {};

  if (draft.learningLanguage !== profile.learningLanguage) {
    changes.learningLanguage = draft.learningLanguage;
  }

  if (draft.interfaceLanguage !== profile.interfaceLanguage) {
    changes.interfaceLanguage = draft.interfaceLanguage;
  }

  if (draft.explanationLanguage !== profile.explanationLanguage) {
    changes.explanationLanguage = draft.explanationLanguage;
  }

  if (draft.level !== profile.level) {
    changes.level = draft.level;
  }

  if (!sameList(draft.goals, profile.goals)) {
    changes.goals = [...draft.goals];
  }

  if (!sameList(draft.interests, profile.interests)) {
    changes.interests = [...draft.interests];
  }

  const minutes = toMinutes(draft.dailyMinutes);

  if (Number.isInteger(minutes) && minutes !== profile.dailyMinutes) {
    changes.dailyMinutes = minutes;
  }

  return changes;
}

/** Название языка на нём самом; для незнакомого кода — сам код. */
function languageOption(code: string, languages: readonly LanguageOption[]): LanguageOption {
  const known = languages.find((language) => language.code === code);

  if (known) {
    return known;
  }

  const preset = isUiLocale(code) ? LANGUAGE_LABELS[code] : null;

  return { code, nativeName: preset?.nativeName ?? code, englishName: preset?.englishName ?? code };
}

/**
 * Языки для селекта интерфейса: только те, на которые интерфейс переведён,
 * плюс текущее значение профиля, если оно из другого списка.
 */
function interfaceOptions(
  languages: readonly LanguageOption[],
  current: string,
): readonly LanguageOption[] {
  const translated = languages.filter((language) => isUiLocale(language.code));
  const base =
    translated.length > 0
      ? translated
      : UI_LOCALES.map((code) => ({ code, ...LANGUAGE_LABELS[code] }));

  return base.some((language) => language.code === current)
    ? base
    : [...base, languageOption(current, languages)];
}

/** Свойства поля выбора. */
interface SelectFieldProps {
  id: string;
  label: string;
  hint: ReactNode;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}

/** Поле выбора с подписью и пояснением, связанным через `aria-describedby`. */
function SelectField({ id, label, hint, value, onChange, children }: SelectFieldProps) {
  const hintId = `${id}-hint`;

  return (
    <div>
      <label htmlFor={id}>{label}</label>{' '}
      <select
        id={id}
        value={value}
        aria-describedby={hintId}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {children}
      </select>
      <p id={hintId}>{hint}</p>
    </div>
  );
}

/** Форма профиля ученика. */
export function ProfileForm({
  profile,
  languages,
  isSaving = false,
  isSaved = false,
  saveError = null,
  onSave,
}: ProfileFormProps) {
  const t = useT('profile');
  const toErrorMessage = useApiErrorMessage();
  const { locale, setLocale } = useLocale();
  const [draft, setDraft] = useState<ProfileDraft>(() => toDraft(profile));
  const [syncedProfile, setSyncedProfile] = useState(profile);
  const [submitFailed, setSubmitFailed] = useState(false);
  const minutesRef = useRef<HTMLInputElement>(null);

  // Пришёл другой профиль (сохранение прошло или откатилось) — черновик за ним.
  if (syncedProfile !== profile) {
    setSyncedProfile(profile);
    setDraft(toDraft(profile));
    setSubmitFailed(false);
  }

  /**
   * Язык интерфейса хранится и в профиле, и в localStorage браузера. Если на
   * этом устройстве выбора ещё не было, применяем язык из профиля: иначе селект
   * показывал бы одно, а интерфейс говорил бы на другом языке. Сделанный на
   * устройстве выбор важнее — его не перебиваем.
   */
  useEffect(() => {
    if (readStoredLocale() !== null) {
      return;
    }

    const stored = toUiLocale(profile.interfaceLanguage);

    if (stored && stored !== locale) {
      setLocale(stored);
    }
  }, [profile.interfaceLanguage, locale, setLocale]);

  const errors = useMemo(() => validateDraft(draft), [draft]);
  const changes = useMemo(() => buildChanges(profile, draft), [profile, draft]);
  const hasErrors = Object.keys(errors).length > 0;
  const isDirty = Object.keys(changes).length > 0;
  const minutes = toMinutes(draft.dailyMinutes);

  const updateDraft = (patch: Partial<ProfileDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
    setSubmitFailed(false);
  };

  /** Язык интерфейса переключается сразу: ждать сохранения незачем. */
  const changeInterfaceLanguage = (code: string): void => {
    updateDraft({ interfaceLanguage: code });

    const next = toUiLocale(code);

    if (next) {
      setLocale(next);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (hasErrors) {
      setSubmitFailed(true);

      if (errors.dailyMinutes) {
        minutesRef.current?.focus();
      }

      return;
    }

    const parsed = updateProfileRequestSchema.safeParse(changes);

    if (!parsed.success) {
      setSubmitFailed(true);

      return;
    }

    setSubmitFailed(false);
    onSave(parsed.data);
  };

  const minutesDescribedBy = errors.dailyMinutes
    ? 'lt-profile-minutes-hint lt-profile-minutes-error'
    : 'lt-profile-minutes-hint';

  const statusText = isSaving
    ? t('form.saving')
    : isSaved && !isDirty
      ? t('form.saved')
      : isDirty
        ? t('form.unsaved')
        : '';

  return (
    <form onSubmit={handleSubmit} noValidate>
      <section className="lt-card" aria-labelledby="lt-profile-languages-title">
        <h2 id="lt-profile-languages-title">{t('sections.languages')}</h2>

        <SelectField
          id="lt-profile-learning-language"
          label={t('languages.learning.label')}
          hint={t('languages.learning.hint')}
          value={draft.learningLanguage}
          onChange={(value) => {
            updateDraft({ learningLanguage: value });
          }}
        >
          {languageOptions(languages, draft.learningLanguage)}
        </SelectField>

        <SelectField
          id="lt-profile-interface-language"
          label={t('languages.interface.label')}
          hint={
            isUiLocale(draft.interfaceLanguage)
              ? t('languages.interface.hint')
              : t('languages.interface.untranslated')
          }
          value={draft.interfaceLanguage}
          onChange={changeInterfaceLanguage}
        >
          {interfaceOptions(languages, draft.interfaceLanguage).map((language) => (
            <option key={language.code} value={language.code}>
              {language.nativeName}
            </option>
          ))}
        </SelectField>

        <SelectField
          id="lt-profile-explanation-language"
          label={t('languages.explanation.label')}
          hint={t('languages.explanation.hint')}
          value={draft.explanationLanguage}
          onChange={(value) => {
            updateDraft({ explanationLanguage: value });
          }}
        >
          {languageOptions(languages, draft.explanationLanguage)}
        </SelectField>
      </section>

      <section className="lt-card" aria-labelledby="lt-profile-level-title">
        <h2 id="lt-profile-level-title">{t('sections.level')}</h2>

        <LevelBadge
          level={draft.level}
          levelConfidence={draft.level === profile.level ? profile.levelConfidence : null}
          placementCompletedAt={
            draft.level === profile.level ? (profile.placementCompletedAt ?? null) : null
          }
        />

        <SelectField
          id="lt-profile-level"
          label={t('level.label')}
          hint={t('level.hint')}
          value={draft.level}
          onChange={(value) => {
            const level = toCefrLevel(value);

            if (level) {
              updateDraft({ level });
            }
          }}
        >
          {CEFR_LEVELS.map((level) => (
            <option key={level} value={level}>
              {t('level.option', { level, name: t(`level.names.${level}`) })}
            </option>
          ))}
        </SelectField>

        <Link className="lt-button" to={ROUTE_PATHS.placement}>
          {t('level.startPlacement')}
        </Link>
      </section>

      <section className="lt-card" aria-labelledby="lt-profile-goals-title">
        <h2 id="lt-profile-goals-title">{t('sections.goals')}</h2>
        <GoalsEditor
          field="goals"
          values={draft.goals}
          disabled={isSaving}
          errorMessage={errors.goals ? t(errors.goals.key, errors.goals.params) : null}
          onChange={(goals) => {
            updateDraft({ goals });
          }}
        />
      </section>

      <section className="lt-card" aria-labelledby="lt-profile-interests-title">
        <h2 id="lt-profile-interests-title">{t('sections.interests')}</h2>
        <GoalsEditor
          field="interests"
          values={draft.interests}
          disabled={isSaving}
          errorMessage={errors.interests ? t(errors.interests.key, errors.interests.params) : null}
          onChange={(interests) => {
            updateDraft({ interests });
          }}
        />
      </section>

      <section className="lt-card" aria-labelledby="lt-profile-load-title">
        <h2 id="lt-profile-load-title">{t('sections.load')}</h2>

        <div>
          <label htmlFor="lt-profile-minutes">{t('dailyMinutes.label')}</label>{' '}
          <input
            id="lt-profile-minutes"
            ref={minutesRef}
            type="number"
            inputMode="numeric"
            min={MIN_DAILY_MINUTES}
            max={MAX_DAILY_MINUTES}
            step={5}
            value={draft.dailyMinutes}
            aria-describedby={minutesDescribedBy}
            aria-invalid={errors.dailyMinutes ? true : undefined}
            disabled={isSaving}
            onChange={(event) => {
              updateDraft({ dailyMinutes: event.target.value });
            }}
          />
          <p id="lt-profile-minutes-hint">
            {t('dailyMinutes.hint', { min: MIN_DAILY_MINUTES, max: MAX_DAILY_MINUTES })}
          </p>
          {!errors.dailyMinutes && <p>{t('common:units.minutes', { count: minutes })}</p>}
          {errors.dailyMinutes && (
            <p id="lt-profile-minutes-error" role="alert">
              {t(errors.dailyMinutes.key, errors.dailyMinutes.params)}
            </p>
          )}
        </div>
      </section>

      <div>
        <button type="submit" className="lt-button" disabled={isSaving || !isDirty}>
          {t('form.save')}
        </button>
        <p role="status">{statusText}</p>

        {submitFailed && hasErrors && (
          <div className="lt-banner lt-banner--error" role="alert">
            <p>{t('form.invalid')}</p>
          </div>
        )}

        {saveError !== null && saveError !== undefined && (
          <div className="lt-banner lt-banner--error" role="alert">
            <p>{t('form.saveFailed')}</p>
            <p>{toErrorMessage(saveError)}</p>
          </div>
        )}
      </div>
    </form>
  );
}

/** Список `<option>` по языкам; текущее значение добавляется, если его нет в списке. */
function languageOptions(languages: readonly LanguageOption[], current: string): ReactNode {
  const options = languages.some((language) => language.code === current)
    ? languages
    : [...languages, languageOption(current, languages)];

  return options.map((language) => (
    <option key={language.code} value={language.code}>
      {language.nativeName}
    </option>
  ));
}
