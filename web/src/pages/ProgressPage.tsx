/**
 * Прогресс: сводка, словарь, журнал ошибок и история уровня.
 *
 * Страница показывает, как система подстроилась под ученика: текущий уровень
 * вместе с обоснованием последнего изменения, собранная лексика, разобранные
 * ошибки и лента изменений уровня.
 *
 * Запрос сводки живёт здесь, потому что её состояние (загрузка, ошибка, пустой
 * прогресс) относится к экрану целиком; остальные три блока держат свои фильтры
 * и запросы сами — фильтры одного блока не должны перерисовывать соседние.
 */
import { ErrorJournal } from '../features/progress/ErrorJournal';
import { LevelTimeline } from '../features/progress/LevelTimeline';
import { ProgressSummary } from '../features/progress/ProgressSummary';
import { useProgressSummary } from '../features/progress/useProgress';
import { VocabularyTable } from '../features/progress/VocabularyTable';
import { useT } from '../i18n/useT';

/** Прогресс: словарь, ошибки и история уровня. */
export function ProgressPage() {
  const t = useT('progress');
  const { summary, isLoading, isError, error, refetch } = useProgressSummary();

  return (
    <section className="lt-page" aria-labelledby="lt-progress-title">
      <h1 id="lt-progress-title" className="lt-page__title">
        {t('title')}
      </h1>
      <p className="lt-page__lead">{t('subtitle')}</p>

      <ProgressSummary
        summary={summary}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={refetch}
      />

      <VocabularyTable />

      <ErrorJournal />

      <LevelTimeline />
    </section>
  );
}
