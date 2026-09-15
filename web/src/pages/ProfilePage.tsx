/**
 * Профиль ученика: изучаемый язык, язык объяснений, уровень и нагрузка.
 *
 * Заготовка каркаса: содержимое наполняет пакет фичи, namespace переводов — `profile`.
 */
import { useT } from '../i18n/useT';

/** Профиль ученика: изучаемый язык, язык объяснений, уровень и нагрузка. */
export function ProfilePage() {
  const t = useT('profile');

  return (
    <section className="lt-page" aria-labelledby="lt-profile-title">
      <h1 id="lt-profile-title" className="lt-page__title">
        {t('title')}
      </h1>
      <p className="lt-page__lead">{t('subtitle')}</p>
      <p className="lt-placeholder">{t('common:status.underConstruction')}</p>
    </section>
  );
}
