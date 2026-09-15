/**
 * Маршруты приложения.
 *
 * ПРАВИЛО ПАКЕТОВ: фичевый пакет наполняет СВОЮ страницу в `pages/` и не меняет
 * этот файл — список маршрутов зафиксирован здесь целиком, чтобы параллельная
 * работа не пересекалась в общем файле.
 *
 * `routes` отделены от `router`, чтобы тесты могли поднять те же маршруты
 * в памяти (`createMemoryRouter`), не трогая историю браузера.
 */
import {
  createBrowserRouter,
  isRouteErrorResponse,
  Link,
  useRouteError,
  type RouteObject,
} from 'react-router-dom';

import { useT } from './i18n/useT';
import { AppLayout } from './layout/AppLayout';
import { HomePage } from './pages/HomePage';
import { LessonPlanPage } from './pages/LessonPlanPage';
import { LessonRoomPage } from './pages/LessonRoomPage';
import { LessonsPage } from './pages/LessonsPage';
import { MaterialsPage } from './pages/MaterialsPage';
import { PlacementPage } from './pages/PlacementPage';
import { ProfilePage } from './pages/ProfilePage';
import { ProgressPage } from './pages/ProgressPage';

/** Адреса разделов; `:id` — идентификатор урока. */
export const ROUTE_PATHS = {
  home: '/',
  profile: '/profile',
  placement: '/placement',
  materials: '/materials',
  lessons: '/lessons',
  lessonPlan: '/lessons/:id/plan',
  lessonRoom: '/lessons/:id/room',
  progress: '/progress',
} as const;

/** Адрес плана конкретного урока. */
export function lessonPlanPath(lessonId: string): string {
  return `/lessons/${encodeURIComponent(lessonId)}/plan`;
}

/** Адрес комнаты конкретного урока. */
export function lessonRoomPath(lessonId: string): string {
  return `/lessons/${encodeURIComponent(lessonId)}/room`;
}

/** Страница несуществующего адреса. */
function NotFoundPage() {
  const t = useT();

  return (
    <section className="lt-page" aria-labelledby="lt-not-found-title">
      <h1 id="lt-not-found-title" className="lt-page__title">
        {t('page.notFound.title')}
      </h1>
      <p className="lt-page__lead">{t('page.notFound.description')}</p>
      <Link className="lt-button" to={ROUTE_PATHS.home}>
        {t('page.notFound.back')}
      </Link>
    </section>
  );
}

/** Экран ошибки маршрута: сюда попадают исключения страниц. */
function RouteErrorPage() {
  const t = useT();
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status === 404) {
    return <NotFoundPage />;
  }

  const description = error instanceof Error ? error.message : t('page.error.description');

  return (
    <section className="lt-page" aria-labelledby="lt-route-error-title">
      <h1 id="lt-route-error-title" className="lt-page__title">
        {t('page.error.title')}
      </h1>
      <p className="lt-page__lead">{description}</p>
      <Link className="lt-button" to={ROUTE_PATHS.home}>
        {t('page.notFound.back')}
      </Link>
    </section>
  );
}

/** Дерево маршрутов приложения. */
export const routes: RouteObject[] = [
  {
    path: ROUTE_PATHS.home,
    element: <AppLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <HomePage /> },
      { path: ROUTE_PATHS.profile, element: <ProfilePage /> },
      { path: ROUTE_PATHS.placement, element: <PlacementPage /> },
      { path: ROUTE_PATHS.materials, element: <MaterialsPage /> },
      { path: ROUTE_PATHS.lessons, element: <LessonsPage /> },
      { path: ROUTE_PATHS.lessonPlan, element: <LessonPlanPage /> },
      { path: ROUTE_PATHS.lessonRoom, element: <LessonRoomPage /> },
      { path: ROUTE_PATHS.progress, element: <ProgressPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

/** Роутер приложения поверх History API браузера. */
export const router = createBrowserRouter(routes);
