/**
 * Комната урока: голосовой диалог, исправления и задания.
 *
 * Заготовка каркаса: содержимое наполняет пакет фичи, namespace переводов — `lessonRoom`.
 */
import { useParams } from 'react-router-dom';

import { useT } from '../i18n/useT';

/** Комната текущего урока. */
export function LessonRoomPage() {
  const t = useT('lessonRoom');
  const { id = '' } = useParams<{ id: string }>();

  return (
    <section className="lt-page" aria-labelledby="lt-lesson-room-title">
      <h1 id="lt-lesson-room-title" className="lt-page__title">
        {t('title')}
      </h1>
      <p className="lt-page__lead">{t('subtitle')}</p>
      <p className="lt-facts__value">{t('lessonId', { id })}</p>
      <p className="lt-placeholder">{t('common:status.underConstruction')}</p>
    </section>
  );
}
