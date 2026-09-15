/**
 * Боковая навигация: разделы приложения и переключатель языка интерфейса.
 *
 * Активный пункт помечается атрибутом `aria-current="page"` — его проставляет
 * `NavLink`, так что состояние видно и в экранной читалке, а не только по цвету.
 */
import { Link, NavLink } from 'react-router-dom';

import { useLocale, useT } from '../i18n/useT';

/** Пункт навигации: адрес и ключ подписи в namespace `common`. */
interface NavItem {
  to: string;
  labelKey: string;
}

/** Разделы в порядке типичного прохождения: профиль → уровень → материалы → уроки. */
const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', labelKey: 'nav.home' },
  { to: '/profile', labelKey: 'nav.profile' },
  { to: '/placement', labelKey: 'nav.placement' },
  { to: '/materials', labelKey: 'nav.materials' },
  { to: '/lessons', labelKey: 'nav.lessons' },
  { to: '/progress', labelKey: 'nav.progress' },
];

/** Класс пункта навигации с учётом активного состояния. */
function navLinkClassName({ isActive }: { isActive: boolean }): string {
  return isActive ? 'lt-nav__link lt-nav__link--active' : 'lt-nav__link';
}

/** Боковая панель с навигацией и выбором языка интерфейса. */
export function NavBar() {
  const t = useT();
  const { locale, locales, setLocale, localeLabel } = useLocale();

  return (
    <header className="lt-sidebar">
      <Link to="/" className="lt-brand">
        <span className="lt-brand__name">{t('app.name')}</span>
        <span className="lt-brand__tagline">{t('app.tagline')}</span>
      </Link>

      <nav className="lt-nav" aria-label={t('nav.label')}>
        <ul className="lt-nav__list">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.to === '/'} className={navLinkClassName}>
                {t(item.labelKey)}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="lt-locale">
        <label className="lt-locale__label" htmlFor="lt-locale-select">
          {t('language.label')}
        </label>
        <select
          id="lt-locale-select"
          className="lt-locale__select"
          value={locale}
          onChange={(event) => {
            const next = locales.find((item) => item === event.target.value);

            if (next) {
              setLocale(next);
            }
          }}
        >
          {locales.map((item) => (
            <option key={item} value={item}>
              {localeLabel(item)}
            </option>
          ))}
        </select>
      </div>
    </header>
  );
}
