/**
 * Лента урока: диалог ученика и тьютора.
 *
 * Оформлена как переписка: реплики тьютора слева, реплики ученика справа, у
 * каждой стороны свой кружок с буквой роли. Так видно разговор, а не документ,
 * и взгляд не ищет, кто что сказал. У ленты своя область прокрутки: поле ввода
 * и панель заданий должны оставаться на экране и на длинном уроке.
 *
 * Своей карточки у ленты нет: она и поле ввода — части одной панели диалога
 * (`LessonRoomPage`), потому что писать реплику в отдельной карточке рядом с
 * чатом — это не переписка, а форма рядом с протоколом.
 *
 * Лента объявлена как `role="log"` с `aria-live="polite"`: ответ тьютора,
 * исправления и состояние «тьютор думает» читаются экранной читалкой сами,
 * без перевода фокуса — ученик в это время печатает или слушает.
 *
 * У каждой реплики видно, как она получена: голосом или набором текста.
 * Реплику тьютора можно переслушать кнопкой — автоозвучка могла быть выключена
 * или прервана, а без повтора смысл голосового урока теряется. У реплики, в
 * которой голосу нечего произнести (она целиком на языке объяснений), кнопки нет.
 *
 * Реплика ученика, на которую сервер не ответил, из ленты не исчезает:
 * она остаётся с пометкой и кнопкой повтора, иначе набранный текст пропал бы.
 */
import { useEffect, useRef } from 'react';

import type { LessonMessage } from '@lt/shared';

import { FeedbackCard } from './FeedbackCard';
import type { PendingTurn } from './useLessonSession';

import { useLocale, useT } from '../../i18n/useT';
import { formatTime } from '../../lib/format';

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
  /** Есть ли в реплике что произнести; не задан — есть у любой. */
  canSpeakMessage?: (message: LessonMessage) => boolean;
  /** Тьютор сейчас говорит. */
  isSpeaking?: boolean;
  /** Озвучить реплику тьютора. */
  onSpeak?: (message: LessonMessage) => void;
  /** Прервать озвучивание. */
  onStopSpeaking?: () => void;
  /** Повторить отправку неподтверждённой реплики; не задан — повторять нечего. */
  onRetryPending?: () => void;
}

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
  const { locale } = useLocale();
  const isTutor = message.role === 'tutor';
  const roleLabel = t(`transcript.roles.${message.role}`);
  const bubbleClass = [
    'lt-chat__bubble',
    pendingState === 'sending' ? 'lt-chat__bubble--pending' : '',
    pendingState === 'failed' ? 'lt-chat__bubble--failed' : '',
  ]
    .filter((name) => name !== '')
    .join(' ');

  return (
    <li
      className={`lt-chat__row lt-chat__row--${message.role}`}
      data-role={message.role}
      data-source={message.source}
    >
      {message.role !== 'system' && (
        // Буква роли — украшение для глаза: читалке роль сообщает текст в реплике.
        <span className="lt-chat__avatar" aria-hidden="true">
          {roleLabel.slice(0, 1)}
        </span>
      )}

      <div className="lt-chat__group">
        <p className={bubbleClass}>
          <span className="lt-visually-hidden">{roleLabel}: </span>
          {message.content}
        </p>

        <p className="lt-chat__meta">
          <span className="lt-chat__time">{formatTime(message.createdAt, locale)}</span>
          <span>{t(`transcript.sources.${message.source}`)}</span>

          {pendingState === 'sending' && <span>{t('transcript.pending')}</span>}
          {pendingState === 'failed' && (
            <span className="lt-badge lt-badge--error">{t('transcript.notDelivered')}</span>
          )}

          {isTutor &&
            canSpeak &&
            (isSpeaking ? (
              <button type="button" className="lt-chat__action" onClick={onStopSpeaking}>
                {t('common:actions.stop')}
              </button>
            ) : (
              <button
                type="button"
                className="lt-chat__action"
                onClick={() => {
                  onSpeak?.(message);
                }}
              >
                {t('transcript.actions.speak')}
              </button>
            ))}

          {pendingState === 'failed' && onRetryPending && (
            <button type="button" className="lt-chat__action" onClick={onRetryPending}>
              {t('transcript.actions.retryTurn')}
            </button>
          )}
        </p>

        {message.corrections.length > 0 && (
          <div className="lt-chat__aside">
            <FeedbackCard corrections={message.corrections} title={t('transcript.corrections')} />
          </div>
        )}
      </div>
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
  canSpeakMessage,
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
    // Новая реплика не должна оставаться за нижним краем ленты: `nearest`
    // останавливается, как только край показался, и подпись под репликой
    // (время, кнопка «озвучить») оставалась бы срезанной.
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [lastId]);

  return (
    <>
      {hasOlderMessages && <p className="lt-status">{t('transcript.truncated')}</p>}

      <div
        className="lt-chat"
        role="log"
        aria-live="polite"
        aria-busy={isThinking}
        aria-label={t('transcript.logLabel')}
      >
        {isEmpty && !isThinking && <p className="lt-placeholder">{t('transcript.empty')}</p>}

        {!isEmpty && (
          <ol className="lt-chat__list">
            {messages.map((message) => (
              <TranscriptItem
                key={message.id}
                message={message}
                canSpeak={canSpeak && (canSpeakMessage?.(message) ?? true)}
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
          <p className="lt-chat__notice" role="status">
            <span className="lt-chat__dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>{' '}
            {t('transcript.thinking')}
          </p>
        )}

        <div ref={endRef} aria-hidden="true" />
      </div>
    </>
  );
}
