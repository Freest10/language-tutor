/**
 * Комната урока: голосовой и текстовый диалог, шаги плана, задания и итог.
 *
 * Здесь сходится весь урок: слева план, в центре лента реплик, внизу ввод
 * голосом и текстом, рядом — задание текущего шага. Данные и обращения
 * к серверу живут в `useLessonSession`, голосовой слой — в пакете `voice`,
 * страница только связывает их и отвечает за состояния экрана.
 *
 * Голосовой цикл: удержание кнопки прерывает говорящего тьютора и включает
 * запись, расшифровка попадает в поле ввода, ученик правит её и отправляет —
 * вместе с `source: 'voice'` и длительностью записи. Ответ тьютора озвучивается
 * автоматически, пока включён тумблер автоозвучки.
 *
 * Пока модель думает или тьютор говорит, отправка заблокирована: локальная
 * модель отвечает 5–20 секунд, и без блокировки ученик успевает наслать
 * несколько ходов подряд.
 */
import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';

import { LoadingBlock } from '../components/LoadingBlock';
import { ChatTranscript } from '../features/lessonRoom/ChatTranscript';
import { ExercisePanel } from '../features/lessonRoom/ExercisePanel';
import { LessonSummary } from '../features/lessonRoom/LessonSummary';
import { MessageComposer } from '../features/lessonRoom/MessageComposer';
import { StepSidebar } from '../features/lessonRoom/StepSidebar';
import {
  useAutoSpeak,
  useLessonSession,
  useLessonSessionErrorMessage,
} from '../features/lessonRoom/useLessonSession';
import { useLessonGenerationReadiness } from '../features/lessons/useLessons';
import { useTextToSpeech } from '../features/voice/useTextToSpeech';
import { useT } from '../i18n/useT';
import { lessonPlanPath, ROUTE_PATHS } from '../router';

/** Комната текущего урока. */
export function LessonRoomPage() {
  const t = useT('lessonRoom');
  const { id = '' } = useParams<{ id: string }>();
  const session = useLessonSession(id);
  const toErrorMessage = useLessonSessionErrorMessage();
  const readiness = useLessonGenerationReadiness();
  const [autoSpeak, setAutoSpeak] = useAutoSpeak();

  const { lesson, currentStep, failure } = session;
  const language = lesson?.learningLanguage ?? 'en';
  const tts = useTextToSpeech({ language, level: lesson?.level ?? null });

  const spokenRef = useRef<string | null>(null);
  const restoredRef = useRef(false);

  useEffect(() => {
    if (session.isRestoring) {
      return;
    }

    const message = session.lastTutorMessage;

    if (!restoredRef.current) {
      // Восстановленную ленту не переозвучиваем: голос дают только новые ответы.
      restoredRef.current = true;
      spokenRef.current = message?.id ?? null;

      return;
    }

    if (!message || spokenRef.current === message.id) {
      return;
    }

    spokenRef.current = message.id;

    if (autoSpeak && tts.available) {
      void tts.speak({ text: message.content, language: message.language ?? language });
    }
  }, [autoSpeak, language, session.isRestoring, session.lastTutorMessage, tts]);

  const isRunning = lesson?.status === 'in_progress';
  const isDraft = lesson?.status === 'draft';
  const summary = session.completion?.summary ?? lesson?.summary ?? null;
  const failureMessage = failure ? toErrorMessage(failure.error) : null;
  // Отказ проверки ответа показывается в самой панели задания, а не общим баннером.
  const bannerFailure = failure && failure.action !== 'attempt' ? failure : null;
  const stepPrompt = currentStep
    ? [currentStep.title, ...currentStep.targetItems].join(', ')
    : undefined;

  return (
    <section className="lt-page" aria-labelledby="lt-lesson-room-title">
      <h1 id="lt-lesson-room-title" className="lt-page__title">
        {lesson?.title ?? t('title')}
      </h1>
      <p className="lt-page__lead">{t('subtitle')}</p>

      <div className="lt-toolbar">
        <Link className="lt-button" to={lessonPlanPath(id)}>
          {t('actions.openPlan')}
        </Link>
        <Link className="lt-button" to={ROUTE_PATHS.lessons}>
          {t('actions.backToList')}
        </Link>
        {isRunning && (
          <button
            type="button"
            className="lt-button"
            disabled={session.isThinking}
            onClick={session.complete}
          >
            {session.isCompleting ? t('actions.completing') : t('actions.complete')}
          </button>
        )}
      </div>

      {session.isRestoring && <LoadingBlock label={t('loading')} card />}

      {session.isError && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p className="lt-banner__title">{t('errors.loadFailed')}</p>
          <p>{toErrorMessage(session.loadError)}</p>
          <button type="button" className="lt-button" onClick={session.refresh}>
            {t('common:actions.retry')}
          </button>
        </div>
      )}

      {!session.isRestoring && !session.isError && !lesson && (
        <p className="lt-placeholder">{t('errors.notFound')}</p>
      )}

      {bannerFailure && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p className="lt-banner__title">{t(`errors.actions.${bannerFailure.action}`)}</p>
          <p>{failureMessage}</p>
          <p>{t('errors.progressKept')}</p>
          <button
            type="button"
            className="lt-button"
            disabled={session.isThinking}
            onClick={session.retry}
          >
            {t('common:actions.retry')}
          </button>
        </div>
      )}

      {isDraft && (
        <section className="lt-card" aria-labelledby="lt-lesson-start-title">
          <h2 id="lt-lesson-start-title">{t('intro.title')}</h2>
          <p>{t('intro.description')}</p>

          {!readiness.isChecking && !readiness.isUnknown && !readiness.isAvailable && (
            <div className="lt-banner lt-banner--error" role="alert">
              <p className="lt-banner__title">{t('intro.llmUnavailable')}</p>
              {readiness.reason && <p>{readiness.reason}</p>}
            </div>
          )}

          <button
            type="button"
            className="lt-button"
            disabled={session.isStarting}
            onClick={session.start}
          >
            {session.isStarting ? t('intro.starting') : t('intro.start')}
          </button>
        </section>
      )}

      {lesson && !isDraft && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 16rem) minmax(0, 1fr)',
            gap: 'var(--lt-space-md)',
            alignItems: 'start',
          }}
        >
          <StepSidebar
            plan={session.plan}
            currentStepId={lesson.currentStepId ?? null}
            isAdvancing={session.isAdvancing}
            disabled={!isRunning || session.isThinking}
            onAdvance={session.advanceStep}
          />

          <div style={{ display: 'grid', gap: 'var(--lt-space-md)' }}>
            <ChatTranscript
              messages={session.messages}
              pendingTurn={session.pendingTurn}
              isThinking={session.isThinking}
              hasOlderMessages={session.hasOlderMessages}
              canSpeak={tts.available}
              isSpeaking={tts.isSpeaking}
              onSpeak={(message) => {
                void tts.speak({
                  text: message.content,
                  language: message.language ?? language,
                });
              }}
              onStopSpeaking={tts.stop}
              onRetryPending={failure?.action === 'turn' ? session.retry : undefined}
            />

            {isRunning && (
              <MessageComposer
                language={language}
                lessonId={id}
                prompt={stepPrompt}
                isThinking={session.isThinking}
                isSpeaking={tts.isSpeaking}
                autoSpeak={autoSpeak}
                ttsFailure={tts.failure}
                onAutoSpeakChange={setAutoSpeak}
                onStopSpeaking={tts.stop}
                onSubmit={(text, options) => {
                  session.sendTurn(text, options);
                }}
              />
            )}

            {isRunning && (
              <ExercisePanel
                key={session.activeExercise?.id ?? 'none'}
                exercise={session.activeExercise}
                feedback={session.feedback}
                language={language}
                lessonId={id}
                isSubmitting={session.isAnswering}
                isSpeaking={tts.isSpeaking}
                disabled={session.isThinking}
                error={failure?.action === 'attempt' ? failure.error : null}
                onRetry={failure?.action === 'attempt' ? session.retry : undefined}
                onStopSpeaking={tts.stop}
                ttsFailure={tts.failure}
                onSubmit={(answer, options) => {
                  if (session.activeExercise) {
                    session.answerExercise(session.activeExercise.id, answer, options);
                  }
                }}
                onNext={session.goToNextExercise}
              />
            )}

            {summary && (
              <LessonSummary
                summary={summary}
                levelChange={session.completion?.levelChange ?? null}
                vocabularyAdded={session.completion?.vocabularyAdded ?? []}
                errorsLogged={session.completion?.errorsLogged ?? []}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
