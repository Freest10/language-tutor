/**
 * Состояние голосового слоя: что происходит сейчас и почему голос не работает.
 *
 * Компонент — единственное место, где отказ голоса превращается в текст для
 * пользователя: сообщение, подсказку («включите серверный STT», «разрешите
 * микрофон») и предложение набрать ответ руками. Молча неработающий микрофон
 * недопустим (допущение A14).
 *
 * Общий баннер возможностей рисует `AppLayout`; здесь — только то, что относится
 * к текущему голосовому взаимодействию.
 */
import { useId } from 'react';

import type { VoiceFailure } from './useVoiceInput';

import { useT } from '../../i18n/useT';

/** Состояние голосового слоя для индикации. */
export type VoiceLayerState =
  /** Ничего не происходит. */
  | 'idle'
  /** Слушаем ученика. */
  | 'listening'
  /** Распознаём сказанное. */
  | 'processing'
  /** Тьютор говорит. */
  | 'speaking';

/** Свойства индикатора состояния голоса. */
export interface VoiceStatusProps {
  /** Что происходит прямо сейчас. */
  state: VoiceLayerState;
  /** Незаконченная расшифровка: в браузерном режиме её видно по ходу речи. */
  interimText?: string;
  /** Уровень входного сигнала 0…1 — индикатор громкости во время записи. */
  level?: number;
  /** Отказ голосового ввода: микрофон, распознавание, сервер. */
  failure?: VoiceFailure | null;
  /** Отказ озвучивания: тьютор отвечает текстом, но не голосом. */
  ttsFailure?: VoiceFailure | null;
  /** Кнопка повтора; показывается, только когда повтор имеет смысл. */
  onRetry?: () => void;
  /** Дополнительный класс контейнера. */
  className?: string;
}

/** Бейдж состояния: подсказывает взглядом, слушает ли приложение. */
const BADGE_MODIFIER: Record<VoiceLayerState, string> = {
  idle: 'lt-badge lt-badge--muted',
  listening: 'lt-badge lt-badge--ok',
  processing: 'lt-badge',
  speaking: 'lt-badge lt-badge--ok',
};

/** Отказ голоса одной карточкой: что случилось, что делать и чем заменить. */
function FailureNotice({ failure, onRetry }: { failure: VoiceFailure; onRetry?: () => void }) {
  const t = useT('voice');
  const isError = failure.channel === 'input';

  return (
    <div
      className={isError ? 'lt-banner lt-banner--error' : 'lt-banner'}
      role={isError ? 'alert' : 'status'}
    >
      <p className="lt-banner__title">{failure.message}</p>
      {failure.hint && <p>{failure.hint}</p>}
      {failure.suggestTyping && <p>{t('hints.typeInstead')}</p>}
      {failure.canRetry && onRetry && (
        <button type="button" className="lt-button" onClick={onRetry}>
          {t('common:actions.retry')}
        </button>
      )}
    </div>
  );
}

/** Состояние голоса и причины его недоступности. */
export function VoiceStatus({
  state,
  interimText = '',
  level = 0,
  failure = null,
  ttsFailure = null,
  onRetry,
  className,
}: VoiceStatusProps) {
  const t = useT('voice');
  const meterId = useId();

  return (
    <div className={className}>
      {/* Живая область: смену состояния озвучивает экранная читалка. */}
      <p className="lt-status" role="status" aria-live="polite">
        <span className={BADGE_MODIFIER[state]}>{t(`state.${state}`)}</span>
        {interimText.length > 0 && <span> {t('status.interim', { text: interimText })}</span>}
      </p>

      {state === 'listening' && (
        <p className="lt-status">
          <label htmlFor={meterId}>{t('status.level')}</label>{' '}
          <progress id={meterId} value={level} max={1} />
        </p>
      )}

      {failure && <FailureNotice failure={failure} onRetry={onRetry} />}
      {ttsFailure && <FailureNotice failure={ttsFailure} />}
    </div>
  );
}
