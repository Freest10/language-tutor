/**
 * Профиль ученика: изучаемый язык, язык объяснений, уровень и нагрузка.
 *
 * Страница отвечает за состояния данных — загрузку, ошибку и сохранение, —
 * а саму форму собирает `ProfileForm`. Список языков берётся из возможностей
 * сервера; если конфигурация недоступна, подставляются языки с пресетами,
 * иначе выбирать было бы не из чего.
 */
import { useMemo } from 'react';

import { KNOWN_LANGUAGE_CODES, LANGUAGE_LABELS, type LanguageOption } from '@lt/shared';

import { useCapabilities } from '../context/CapabilitiesProvider';
import { ProfileForm } from '../features/profile/ProfileForm';
import { useProfile, useUpdateProfile } from '../features/profile/useProfile';
import { useApiErrorMessage, useT } from '../i18n/useT';

/** Языки с готовыми пресетами: запасной список, когда сервер не ответил. */
const FALLBACK_LANGUAGES: readonly LanguageOption[] = KNOWN_LANGUAGE_CODES.map((code) => ({
  code,
  ...LANGUAGE_LABELS[code],
}));

/** Заглушка на время загрузки профиля. */
function ProfileSkeleton() {
  const t = useT('profile');

  return (
    <div className="lt-card" aria-busy="true">
      <p className="lt-placeholder" role="status">
        {t('states.loading')}
      </p>
      <p className="lt-placeholder" aria-hidden="true" />
      <p className="lt-placeholder" aria-hidden="true" />
    </div>
  );
}

/** Профиль ученика: изучаемый язык, язык объяснений, уровень и нагрузка. */
export function ProfilePage() {
  const t = useT('profile');
  const toErrorMessage = useApiErrorMessage();
  const { config } = useCapabilities();
  const profileQuery = useProfile();
  const updateProfile = useUpdateProfile();

  const languages = useMemo<readonly LanguageOption[]>(() => {
    const supported = config?.supportedLanguages ?? [];

    return supported.length > 0 ? supported : FALLBACK_LANGUAGES;
  }, [config]);

  return (
    <section className="lt-page" aria-labelledby="lt-profile-title">
      <h1 id="lt-profile-title" className="lt-page__title">
        {t('title')}
      </h1>
      <p className="lt-page__lead">{t('subtitle')}</p>

      {profileQuery.isPending && <ProfileSkeleton />}

      {profileQuery.isError && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p>{t('states.loadFailed')}</p>
          <p>{toErrorMessage(profileQuery.error)}</p>
          <button
            type="button"
            className="lt-button"
            onClick={() => {
              void profileQuery.refetch();
            }}
          >
            {t('common:actions.retry')}
          </button>
        </div>
      )}

      {profileQuery.data && (
        <ProfileForm
          profile={profileQuery.data}
          languages={languages}
          isSaving={updateProfile.isPending}
          isSaved={updateProfile.isSuccess}
          saveError={updateProfile.isError ? toErrorMessage(updateProfile.error) : null}
          onSave={(changes) => {
            updateProfile.mutate(changes);
          }}
        />
      )}
    </section>
  );
}
