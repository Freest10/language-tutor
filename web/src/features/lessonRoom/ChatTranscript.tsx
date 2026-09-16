/**
 * Лента урока: реплики ученика и тьютора в порядке произнесения.
 *
 * Лента объявлена как `role="log"` с `aria-live="polite"`: ответ тьютора,
 * исправления и состояние «тьютор думает» читаются экранной читалкой сами,
 * без перевода фокуса — ученик в это время печатает или слушает.
 *
 * У каждой реплики видно, как она получена: голосом или набором текста.
 * Реплику тьютора можно переслушать кнопкой — автоозвучка могла быть выключена
 * или прервана, а без повтора смысл голосового урока теряется.
 *
 * Реплика ученика, на которую сервер не ответил, из ленты не исчезает:
 * она остаётся с пометкой и кнопкой повтора, иначе набранный текст пропал бы.
 */
import { useEffect, useRef } from 'react';

import type { LessonMessage } from '@lt/shared';

import { FeedbackCard } from './FeedbackCard';
import type { PendingTurn } from './useLessonSession';

import { useT } from '../../i18n/useT';

/** Свойства ленты реплик. */
export interface ChatTranscriptProps {
  /** Реплики от старых к новым. */
  messages: readonly LessonMessage[];
  /** Реплика ученика, которую сервер ещё не подтвердил. */
  pendingTurn?: PendingTurn | null;
  /** Тьютор думает над ответом. */
  isThinking?: boolean;
  /** Показаны последние реплики: начало диалога осталось за страницей. */
  hasOlderMessages?: boolean;
  /** Озвучивание доступно: иначе кнопка «переслушать» не показывается. */
  canSpeak?: boolean;
  /** Тьютор сейчас говорит. */
  isSpeaking?: boolean;
  /** Озвучить реплику тьютора. */
  onSpeak?: (message: LessonMessage) => void;
  /** Прервать озвучивание. */
  onStopSpeaking?: () => void;
  /** Повторить отправку неподтверждённой реплики; не задан — повторять нечего. */
  onRetryPending?: () => void;
}

/** Оформление бейджа роли: ученик, тьютор или служебная реплика. */
const ROLE_BADGE: Record<LessonMessage['role'], string> = {
  user: 'lt-badge',
  tutor: 'lt-badge lt-badge--ok',
  system: 'lt-badge lt-badge--muted',
};

/** Свойства одной реплики. */
interface TranscriptItemProps {
  message: LessonMessage;
  /** Состояние неподтверждённой реплики; `null` — реплика сохранена сервером. */
  pendingState?: PendingTurn['state'] | null;
  canSpeak?: boolean;
  isSpeaking?: boolean;
  onSpeak?: (message: LessonMessage) => void;
  onStopSpeaking?: () => void;
  onRetryPending?: () => void;
}

/** Одна реплика: кто сказал, как сказал, что сказал и что в ней исправлено. */
function TranscriptItem({
  message,
  pendingState = null,
  canSpeak = false,
  isSpeaking = false,
  onSpeak,
  onStopSpeaking,
  onRetryPending,
}: TranscriptItemProps) {
  const t = useT('lessonRoom');
  const isTutor = message.role === 'tutor';

  return (
    <li className="lt-list__item" data-role={message.role} data-source={message.source}>
      <p>
        <span className={ROLE_BADGE[message.role]}>{t(`transcript.roles.${message.role}`)}</span>{' '}
        <span className="lt-badge lt-badge--muted">
          {t(`transcript.sources.${message.source}`)}
        </span>{' '}
        {pendingState === 'sending' && (
          <span className="lt-badge lt-badge--muted">{t('transcript.pending')}</span>
        )}
        {pendingState === 'failed' && (
          <span className="lt-badge lt-badge--error">{t('transcript.notDelivered')}</span>
        )}
      </p>
      <p>{message.content}</p>

      {message.corrections.length > 0 && (
        <FeedbackCard corrections={message.corrections} title={t('transcript.corrections')} />
      )}

      {isTutor && canSpeak && (
        <p>
          {isSpeaking ? (
            <button type="button" className="lt-button" onClick={onStopSpeaking}>
              {t('common:actions.stop')}
            </button>
          ) : (
            <button
              type="button"
              className="lt-button"
              onClick={() => {
                onSpeak?.(message);
              }}
            >
              {t('transcript.actions.speak')}
            </button>
          )}
        </p>
      )}

      {pendingState === 'failed' && onRetryPending && (
        <p>
          <button type="button" className="lt-button" onClick={onRetryPending}>
            {t('transcript.actions.retryTurn')}
          </button>
        </p>
      )}
    </li>
  );
}

/** Лента реплик урока вместе с состоянием ожидания ответа тьютора. */
export function ChatTranscript({
  messages,
  pendingTurn = null,
  isThinking = false,
  hasOlderMessages = false,
  canSpeak = false,
  isSpeaking = false,
  onSpeak,
  onStopSpeaking,
  onRetryPending,
}: ChatTranscriptProps) {
  const t = useT('lessonRoom');
  const endRef = useRef<HTMLDivElement | null>(null);
  const lastId = pendingTurn?.message.id ?? messages.at(-1)?.id ?? null;
  const isEmpty = messages.length === 0 && pendingTurn === null;

  useEffect(() => {
    // Новая реплика не должна оставаться за нижним краем ленты.
    endRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [lastId]);

  return (
    <section className="lt-card" aria-labelledby="lt-lesson-transcript-title">
      <h2 id="lt-lesson-transcript-title">{t('transcript.title')}</h2>

      {hasOlderMessages && <p className="lt-status">{t('transcript.truncated')}</p>}

      <div
        role="log"
        aria-live="polite"
        aria-busy={isThinking}
        aria-label={t('transcript.logLabel')}
      >
        {isEmpty && !isThinking && <p className="lt-placeholder">{t('transcript.empty')}</p>}

        {!isEmpty && (
          <ol className="lt-list">
            {messages.map((message) => (
              <TranscriptItem
                key={message.id}
                message={message}
                canSpeak={canSpeak}
                isSpeaking={isSpeaking && message.id === lastId}
                onSpeak={onSpeak}
                onStopSpeaking={onStopSpeaking}
              />
            ))}
            {pendingTurn && (
              <TranscriptItem
                key={pendingTurn.message.id}
                message={pendingTurn.message}
                pendingState={pendingTurn.state}
                onRetryPending={onRetryPending}
              />
            )}
          </ol>
        )}

        {isThinking && (
          <p className="lt-status" role="status">
            {t('transcript.thinking')}
          </p>
        )}

        <div ref={endRef} aria-hidden="true" />
      </div>
    </section>
  );
}
