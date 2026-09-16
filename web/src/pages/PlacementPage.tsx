/**
 * Определение исходного уровня в коротком диалоге.
 *
 * Мастер из трёх шагов: объяснение → вопросы → результат. Шаг выбирает
 * `usePlacement` по состоянию сессии, страница отвечает за состояния данных —
 * восстановление начатого теста, ошибки сервера и предупреждение о том, что
 * языковая модель не настроена.
 *
 * Про модель предупреждаем до старта, а не после первого вопроса: без неё
 * тест не задаст ни одного вопроса, и начинать его бессмысленно.
 */
import { PLACEMENT_DEFAULT_MAX_TURNS } from '@lt/shared';

import { LoadingBlock } from '../components/LoadingBlock';
import { useCapabilities } from '../context/CapabilitiesProvider';
import { PlacementChat } from '../features/placement/PlacementChat';
import { PlacementResult } from '../features/placement/PlacementResult';
import { usePlacement, usePlacementErrorMessage } from '../features/placement/usePlacement';
import { useT } from '../i18n/useT';

/** Сколько примерно минут занимает тест: время одного вопроса × число вопросов. */
const PLACEMENT_DURATION_MINUTES = 5;

/** Определение исходного уровня в коротком диалоге. */
export function PlacementPage() {
  const t = useT('placement');
  const toErrorMessage = usePlacementErrorMessage();
  const { status: capabilitiesStatus, llm } = useCapabilities();
  const placement = usePlacement();

  const { failure } = placement;
  const failureMessage = failure ? toErrorMessage(failure.error) : null;
  const isLlmReady = capabilitiesStatus !== 'ready' || llm.available;
  const llmReason = llm.reason?.trim() ?? '';

  return (
    <section className="lt-page" aria-labelledby="lt-placement-title">
      <h1 id="lt-placement-title" className="lt-page__title">
        {t('title')}
      </h1>
      <p className="lt-page__lead">{t('subtitle')}</p>

      {placement.stage === 'intro' && (
        <section className="lt-card" aria-labelledby="lt-placement-intro-title">
          <h2 id="lt-placement-intro-title">{t('intro.title')}</h2>
          <p>{t('intro.description', { count: PLACEMENT_DEFAULT_MAX_TURNS })}</p>
          <ul className="lt-list">
            <li className="lt-list__item">{t('intro.steps.questions')}</li>
            <li className="lt-list__item">{t('intro.steps.answers')}</li>
            <li className="lt-list__item">{t('intro.steps.profile')}</li>
          </ul>
          <p className="lt-status">
            {t('intro.duration', { minutes: PLACEMENT_DURATION_MINUTES })}
          </p>

          {capabilitiesStatus === 'loading' && (
            <p className="lt-status" role="status">
              {t('intro.checking')}
            </p>
          )}

          {capabilitiesStatus === 'error' && (
            <div className="lt-banner" role="status">
              <p>{t('intro.configUnavailable')}</p>
            </div>
          )}

          {!isLlmReady && (
            <div className="lt-banner lt-banner--error" role="alert">
              <p className="lt-banner__title">{t('intro.llmUnavailable.title')}</p>
              <p>{t('intro.llmUnavailable.description')}</p>
              {llmReason.length > 0 && <p>{llmReason}</p>}
            </div>
          )}

          {failureMessage !== null && (
            <div className="lt-banner lt-banner--error" role="alert">
              <p>{t('errors.startFailed')}</p>
              <p>{failureMessage}</p>
              <button
                type="button"
                className="lt-button"
                disabled={placement.isBusy}
                onClick={placement.retry}
              >
                {t('common:actions.retry')}
              </button>
            </div>
          )}

          {isLlmReady && (
            <button
              type="button"
              className="lt-button"
              disabled={placement.isBusy || capabilitiesStatus === 'loading'}
              onClick={placement.start}
            >
              {t('intro.start')}
            </button>
          )}

          {placement.isStarting && (
            <p className="lt-status" role="status">
              {t('intro.starting')}
            </p>
          )}
        </section>
      )}

      {placement.stage === 'chat' && placement.isRestoring && (
        <LoadingBlock label={t('chat.restoring')} lines={1} card />
      )}

      {placement.stage === 'chat' && !placement.isRestoring && placement.session && (
        <PlacementChat
          history={placement.history}
          currentTurn={placement.currentTurn}
          questionNumber={placement.questionNumber}
          maxTurns={placement.maxTurns}
          isAnswering={placement.isAnswering}
          isFinishing={placement.isFinishing}
          error={failure?.error ?? null}
          onRetry={failure ? placement.retry : undefined}
          onSubmit={(text, options) => {
            placement.answer(text, options);
          }}
          onFinish={placement.finish}
        />
      )}

      {placement.stage === 'chat' && !placement.isRestoring && !placement.session && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p>{t('errors.restoreFailed')}</p>
          {failureMessage !== null && <p>{failureMessage}</p>}
          <button type="button" className="lt-button" onClick={placement.retry}>
            {t('common:actions.retry')}
          </button>
          <button type="button" className="lt-button" onClick={placement.restart}>
            {t('errors.startOver')}
          </button>
        </div>
      )}

      {placement.stage === 'result' && placement.result && (
        <PlacementResult
          result={placement.result}
          appliedToProfile={placement.appliedToProfile}
          isSaving={placement.isFinishing}
          saveError={failure?.action === 'finish' ? failure.error : null}
          onSaveToProfile={placement.finish}
          onRestart={placement.restart}
        />
      )}
    </section>
  );
}
