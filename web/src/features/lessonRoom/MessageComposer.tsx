/**
 * Ввод реплики ученика: поле текста и кнопка «говорить, пока держу».
 *
 * Голосовой цикл заканчивается не отправкой, а полем ввода: распознавание
 * ошибается, поэтому расшифровка попадает в поле, ученик её правит и отправляет
 * сам. Пометка `source: 'voice'` и длительность записи при этом сохраняются —
 * реплика всё равно была надиктована, и серверу это нужно знать.
 *
 * Пока тьютор думает или говорит, отправка заблокирована: локальная модель
 * отвечает 5–20 секунд, и без блокировки ученик успевает наслать несколько
 * ходов подряд. Чтобы это не превратилось в тупик, рядом есть кнопка «стоп»,
 * а удержание кнопки записи прерывает тьютора само.
 */
import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import type { LanguageCode, MessageSource } from '@lt/shared';

import { useVoiceDraft } from './useLessonSession';

import { LESSON_TURN_MAX_LENGTH } from '../../api/lessonSession';
import { SendIcon } from '../../components/icons';
import { useT } from '../../i18n/useT';
import { PushToTalkButton } from '../voice/PushToTalkButton';
import { VoiceStatus, type VoiceLayerState } from '../voice/VoiceStatus';
import { useVoiceInput, type VoiceFailure } from '../voice/useVoiceInput';

/** Как получена отправленная реплика. */
export interface MessageComposerOptions {
  source: MessageSource;
  /** Длительность записи, миллисекунды; `undefined` — текст набран руками. */
  durationMs?: number;
}

/** Свойства поля ввода реплики. */
export interface MessageComposerProps {
  /** Язык речи ученика — изучаемый язык урока. */
  language: LanguageCode;
  /** Урок, к которому относится запись: необязательное поле контракта STT. */
  lessonId?: string;
  /** Контекст для распознавателя: тема текущего шага. */
  prompt?: string;
  /** Урок не идёт: отправлять реплики нельзя. */
  disabled?: boolean;
  /** Тьютор думает над предыдущей репликой. */
  isThinking?: boolean;
  /** Тьютор сейчас говорит. */
  isSpeaking?: boolean;
  /** Озвучивать ответы тьютора сразу. */
  autoSpeak: boolean;
  /** Переключение автоозвучки. */
  onAutoSpeakChange: (value: boolean) => void;
  /** Прервать озвучивание: и кнопкой, и удержанием записи. */
  onStopSpeaking?: () => void;
  /** Отказ озвучивания: показывается рядом с состоянием голосового ввода. */
  ttsFailure?: VoiceFailure | null;
  /** Отправка реплики. */
  onSubmit: (text: string, options: MessageComposerOptions) => void;
}

/** Поле ввода реплики вместе с голосовым вводом. */
export function MessageComposer({
  language,
  lessonId,
  prompt,
  disabled = false,
  isThinking = false,
  isSpeaking = false,
  autoSpeak,
  onAutoSpeakChange,
  onStopSpeaking,
  ttsFailure = null,
  onSubmit,
}: MessageComposerProps) {
  const t = useT('lessonRoom');
  const fieldId = useId();
  const draft = useVoiceDraft();
  const [error, setError] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceLayerState>('idle');
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  // Голосовой ввод держит поле, а не кнопка: кнопка уехала внутрь рамки, и
  // показывать состояние записи (уровень сигнала, отказ микрофона) нужно под
  // полем — там, где для этого есть место.
  const voice = useVoiceInput({ language, prompt, lessonId });
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const sendBlocked = disabled || isThinking || isSpeaking;

  const submit = (): void => {
    const text = draft.text.trim();

    if (text.length === 0) {
      setError(t('composer.errors.empty'));

      return;
    }

    if (text.length > LESSON_TURN_MAX_LENGTH) {
      setError(t('composer.errors.tooLong', { max: LESSON_TURN_MAX_LENGTH }));

      return;
    }

    setError(null);
    onSubmit(text, { source: draft.source, durationMs: draft.durationMs });
    draft.clear();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (sendBlocked) {
      return;
    }

    submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Перевод строки в реплике нужен, поэтому отправляет сочетание, а не Enter.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !sendBlocked) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="lt-composer">
      <form onSubmit={handleSubmit} noValidate aria-label={t('composer.title')}>
        <div className="lt-field">
          <label className="lt-field__label lt-visually-hidden" htmlFor={fieldId}>
            {t('composer.label')}
          </label>
          {/* Поле, микрофон и отправка — одна рамка: строка чата, а не форма.
              Кнопки внутри поля, потому что относятся к этой самой реплике. */}
          <div className="lt-composer__shell">
            <textarea
              id={fieldId}
              ref={fieldRef}
              rows={2}
              value={draft.text}
              disabled={disabled}
              maxLength={LESSON_TURN_MAX_LENGTH}
              placeholder={t('composer.placeholder')}
              aria-describedby={error ? `${hintId} ${errorId}` : hintId}
              aria-invalid={error ? true : undefined}
              onChange={(event) => {
                draft.setText(event.target.value);
                setError(null);
              }}
              onKeyDown={handleKeyDown}
            />

            <PushToTalkButton
              mode="toggle"
              className="lt-composer__talk"
              compact
              voice={voice}
              language={language}
              lessonId={lessonId}
              prompt={prompt}
              busy={isThinking}
              speaking={isSpeaking}
              disabled={disabled}
              showStatus={false}
              ttsFailure={ttsFailure}
              onInterruptSpeaking={onStopSpeaking}
              onResult={(result) => {
                draft.applyVoiceResult(result);
                setError(null);
                // Курсор сразу в поле: расшифровку почти всегда нужно поправить.
                fieldRef.current?.focus();
              }}
              onStateChange={setVoiceState}
            />

            <button
              type="submit"
              className="lt-iconbutton lt-iconbutton--accent"
              disabled={sendBlocked}
              aria-label={isThinking ? t('composer.sending') : t('composer.send')}
              title={isThinking ? t('composer.sending') : t('composer.send')}
            >
              <SendIcon />
            </button>
          </div>
          <p className="lt-field__hint" id={hintId}>
            {draft.source === 'voice' ? t('composer.voiceReady') : t('composer.hint')}
          </p>
          {error && (
            <p className="lt-field__error" id={errorId} role="alert">
              {error}
            </p>
          )}

          <VoiceStatus
            state={voiceState}
            interimText={voice.interimText}
            level={voice.level}
            failure={voice.failure}
            ttsFailure={ttsFailure}
            onRetry={voice.reset}
          />
        </div>

        {isSpeaking && (
          <div className="lt-toolbar">
            <button type="button" className="lt-button" onClick={onStopSpeaking}>
              {t('composer.stopSpeaking')}
            </button>
          </div>
        )}
      </form>

      <div className="lt-composer__controls">
        <label className="lt-composer__toggle" htmlFor={`${fieldId}-auto-speak`}>
          <input
            id={`${fieldId}-auto-speak`}
            type="checkbox"
            checked={autoSpeak}
            onChange={(event) => {
              onAutoSpeakChange(event.target.checked);
            }}
          />{' '}
          {t('composer.autoSpeak.label')}
        </label>
      </div>
    </div>
  );
}
