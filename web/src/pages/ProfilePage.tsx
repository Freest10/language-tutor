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

import { LoadingBlock } from '../components/LoadingBlock';
import { useCapabilities } from '../context/CapabilitiesProvider';
import { ProfileForm } from '../features/profile/ProfileForm';
import { useProfile, useUpdateProfile } from '../features/profile/useProfile';
import { useApiErrorMessage, useT } from '../i18n/useT';

/** Языки с готовыми пресетами: запасной список, когда сервер не ответил. */
const FALLBACK_LANGUAGES: readonly LanguageOption[] = KNOWN_LANGUAGE_CODES.map((code) => ({
  code,
  ...LANGUAGE_LABELS[code],
}));

/** Профиль ученика: изучаемый язык, язык объяснений, уровень и нагрузка. */
export function ProfilePage() {
  const t = useT('profile');
  const toErrorMessage = useApiErrorMessage();
  const { config } = useCapabilities();
  const { profile, isLoading, isError, error, refetch } = useProfile();
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

      {isLoading && <LoadingBlock label={t('states.loading')} card />}

      {isError && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p>{t('states.loadFailed')}</p>
          <p>{toErrorMessage(error)}</p>
          <button type="button" className="lt-button" onClick={refetch}>
            {t('common:actions.retry')}
          </button>
        </div>
      )}

      {profile && (
        <ProfileForm
          profile={profile}
          languages={languages}
          isSaving={updateProfile.isPending}
          isSaved={updateProfile.isSuccess}
          saveError={updateProfile.error}
          onSave={(changes) => {
            updateProfile.mutate(changes);
          }}
        />
      )}
    </section>
  );
}
