/**
 * Кнопка «говорить, пока держу»: удержание мышью, пальцем или пробелом.
 *
 * Удержание, а не переключатель: ученик сам решает, где кончается реплика,
 * и случайно оставить микрофон включённым невозможно. Пробел работает как
 * дублёр кнопки, но только когда фокус не в поле ввода — иначе он набирал бы
 * пробелы и листал страницу.
 *
 * Компонент ничего не знает про уроки: язык речи приходит свойством
 * (изучаемый язык из профиля), расшифровка уходит в `onResult`.
 *
 * Доступность: состояние дублируется текстом в живой области (`VoiceStatus`),
 * кнопка работает с клавиатуры, отказ в доступе к микрофону объясняется словами.
 */
import { useCallback, useEffect, useId, useRef, type PointerEvent } from 'react';

import { VoiceStatus, type VoiceLayerState } from './VoiceStatus';
import {
  useVoiceInput,
  type UseVoiceInputResult,
  type VoiceFailure,
  type VoiceInputResult,
} from './useVoiceInput';

import type { LanguageCode } from '@lt/shared';

import { MicIcon } from '../../components/icons';
import { useT } from '../../i18n/useT';

/** Свойства кнопки удержания. */
export interface PushToTalkButtonProps {
  /** Язык речи ученика — изучаемый язык из профиля (BCP-47). */
  language: LanguageCode;
  /** Расшифровка законченной реплики. */
  onResult: (result: VoiceInputResult) => void;
  /** Отказ голосового ввода: тот же объект, что показан под кнопкой. */
  onFailure?: (failure: VoiceFailure) => void;
  /** Смена состояния: `idle` → `listening` → `processing`. */
  onStateChange?: (state: VoiceLayerState) => void;
  /** Контекстная подсказка распознавателю: термины текущего диалога. */
  prompt?: string;
  /** Необязательное поле контракта `POST /api/voice/stt`. */
  lessonId?: string;
  /** Страница занята (ждёт ответ тьютора): записывать нельзя. */
  busy?: boolean;
  /** Тьютор сейчас говорит: кнопка показывает это состояние. */
  speaking?: boolean;
  /** Прервать озвучивание: вызывается, когда ученик начинает говорить поверх ответа. */
  onInterruptSpeaking?: () => void;
  /** Отключить кнопку целиком. */
  disabled?: boolean;
  /** Пробел как дублёр кнопки; по умолчанию включён. */
  hotkey?: boolean;
  /** Показывать состояние и отказы под кнопкой; по умолчанию — да. */
  showStatus?: boolean;
  /** Отказ озвучивания: показывается рядом с состоянием ввода. */
  ttsFailure?: VoiceFailure | null;
  /**
   * Готовый голосовой ввод, если страница уже держит его сама.
   * В этом случае не задавайте `onResult` в его настройках: расшифровку
   * отдаёт кнопка, иначе обработчик сработает дважды.
   */
  voice?: UseVoiceInputResult;
  /** Дополнительный класс контейнера. */
  className?: string;
  /**
   * Кнопка-иконка вместо кнопки с подписью: так она помещается внутрь поля
   * ввода. Подпись при этом никуда не девается — она уходит в `aria-label`
   * и во всплывающую подсказку, иначе кнопка молчала бы для экранной читалки.
   */
  compact?: boolean;
  /**
   * Как начинается и заканчивается реплика:
   * - `hold` — говорить, пока кнопка (или пробел) удерживается;
   * - `toggle` — нажать, сказать, нажать ещё раз.
   *
   * `toggle` удобнее длинной реплике: держать кнопку полминуты неудобно, а
   * случайно отпустить её посреди фразы — обидно.
   */
  mode?: 'hold' | 'toggle';
}

/** Считается ли элемент текстовым полем: в нём пробел набирает пробел. */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName;

  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    target.isContentEditable
  );
}

/** Нажат ли пробел (без модификаторов, не автоповтор). */
function isTalkKey(event: KeyboardEvent): boolean {
  return (
    (event.code === 'Space' || event.key === ' ') &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  );
}

/** Кнопка голосового ввода: удержанием или нажатием — по режиму. */
export function PushToTalkButton({
  language,
  onResult,
  onFailure,
  onStateChange,
  prompt,
  lessonId,
  busy = false,
  speaking = false,
  onInterruptSpeaking,
  disabled = false,
  hotkey = true,
  showStatus = true,
  ttsFailure = null,
  voice,
  className,
  compact = false,
  mode = 'hold',
}: PushToTalkButtonProps) {
  const isToggle = mode === 'toggle';
  const t = useT('voice');
  const statusId = useId();

  // Хук вызывается всегда (правило хуков); при внешнем `voice` результат не используется.
  const ownVoice = useVoiceInput({ language, prompt, lessonId, onFailure });
  const input = voice ?? ownVoice;

  const holdingRef = useRef(false);
  const startedRef = useRef<Promise<boolean> | null>(null);
  const callbacksRef = useRef({ onResult, onStateChange, onInterruptSpeaking });

  useEffect(() => {
    callbacksRef.current = { onResult, onStateChange, onInterruptSpeaking };
  }, [onInterruptSpeaking, onResult, onStateChange]);

  const state: VoiceLayerState = speaking
    ? 'speaking'
    : input.isProcessing
      ? 'processing'
      : input.isListening
        ? 'listening'
        : 'idle';

  const blocked = disabled || busy || !input.available;

  useEffect(() => {
    callbacksRef.current.onStateChange?.(state);
  }, [state]);

  const { start, stop, cancel, reset } = input;

  /** Начинает реплику: прерывает ответ тьютора и включает запись. */
  const beginHold = useCallback((): void => {
    if (holdingRef.current || blocked) {
      return;
    }

    holdingRef.current = true;
    callbacksRef.current.onInterruptSpeaking?.();
    startedRef.current = start();
  }, [blocked, start]);

  /** Заканчивает реплику и отдаёт расшифровку. */
  const endHold = useCallback(async (): Promise<void> => {
    if (!holdingRef.current) {
      return;
    }

    holdingRef.current = false;

    const started = await (startedRef.current ?? Promise.resolve(false));

    startedRef.current = null;

    if (!started) {
      return;
    }

    const result = await stop();

    if (result) {
      callbacksRef.current.onResult(result);
    }
  }, [stop]);

  /** Прерывает реплику: запись отбрасывается, на сервер ничего не уходит (A10). */
  const abortHold = useCallback((): void => {
    if (!holdingRef.current) {
      return;
    }

    holdingRef.current = false;
    startedRef.current = null;
    cancel();
  }, [cancel]);

  /** Нажатие в режиме `toggle`: первое начинает реплику, второе заканчивает. */
  const toggleRecording = useCallback((): void => {
    if (holdingRef.current) {
      void endHold();

      return;
    }

    beginHold();
  }, [beginHold, endHold]);

  useEffect(() => {
    if (!hotkey) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isTalkKey(event) || event.repeat || isTextEntryTarget(event.target)) {
        return;
      }

      // Иначе пробел пролистает страницу и «нажмёт» кнопку в фокусе.
      event.preventDefault();

      if (isToggle) {
        toggleRecording();

        return;
      }

      beginHold();
    };

    const handleKeyUp = (event: KeyboardEvent): void => {
      if (isToggle || !isTalkKey(event) || isTextEntryTarget(event.target)) {
        return;
      }

      event.preventDefault();
      void endHold();
    };

    // Уход со вкладки посреди удержания не должен оставить микрофон включённым.
    // В режиме нажатия запись продолжается: ученик включил её сознательно и
    // мог отвлечься на другое окно, не закончив фразу.
    const handleBlur = (): void => {
      if (isToggle) {
        return;
      }

      void endHold();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [beginHold, endHold, hotkey, isToggle, toggleRecording]);

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (isToggle || event.button !== 0) {
      return;
    }

    try {
      // Чтобы отпускание за пределами кнопки всё равно дошло до неё.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Указатель мог уже исчезнуть: на саму запись это не влияет.
    }

    beginHold();
  };

  const handlePointerUp = (): void => {
    if (isToggle) {
      return;
    }

    void endHold();
  };

  /** Нажатие целиком: в режиме удержания его обрабатывают события указателя. */
  const handleClick = (): void => {
    if (!isToggle) {
      return;
    }

    toggleRecording();
  };

  const label = isToggle
    ? t(state === 'listening' ? 'pushToTalk.stop' : 'pushToTalk.start')
    : t(state === 'listening' ? 'pushToTalk.release' : 'pushToTalk.hold');
  const hint = isToggle
    ? t(hotkey ? 'pushToTalk.toggleHint' : 'pushToTalk.toggleHintMouse')
    : t(hotkey ? 'pushToTalk.hint' : 'pushToTalk.hintMouse');

  return (
    <div className={className}>
      <div className="lt-toolbar">
        <button
          type="button"
          className={
            compact
              ? `lt-iconbutton${state === 'listening' ? ' lt-iconbutton--recording' : ''}`
              : 'lt-button'
          }
          {...(compact ? { 'aria-label': label, title: `${label}. ${hint}` } : {})}
          disabled={blocked}
          aria-pressed={state === 'listening'}
          aria-describedby={showStatus ? statusId : undefined}
          onClick={handleClick}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={isToggle ? undefined : abortHold}
          onContextMenu={(event) => {
            // Долгое нажатие на телефоне не должно открывать системное меню.
            event.preventDefault();
          }}
        >
          {compact ? <MicIcon /> : label}
        </button>
        {!compact && <span className="lt-status">{hint}</span>}
      </div>

      {showStatus && (
        <div id={statusId}>
          <VoiceStatus
            state={state}
            interimText={input.interimText}
            level={input.level}
            failure={input.failure}
            ttsFailure={ttsFailure}
            onRetry={reset}
          />
        </div>
      )}
    </div>
  );
}
