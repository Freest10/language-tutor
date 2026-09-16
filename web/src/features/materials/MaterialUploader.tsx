/**
 * Добавление материала: файл (перетаскиванием или выбором) либо вставленный текст.
 *
 * Формат и размер проверяются до отправки — по пределу из `GET /api/config`,
 * а не по зашитой константе: сервер может быть настроен строже.
 *
 * Прогресс показан индикатором без доли выполнения: клиент отправляет файл
 * через `fetch`, а он не сообщает о ходе загрузки тела запроса.
 *
 * Ответ сервера приходит раньше, чем материал готов: скан распознаётся в фоне
 * минутами. Поэтому после отправки форма говорит не «готово», а «принято и
 * обрабатывается» и отправляет за прогрессом в список — ждать здесь не нужно.
 */
import { useCallback, useId, useRef, useState, type DragEvent, type FormEvent } from 'react';

import { type Material } from '@lt/shared';

import {
  isMaterialProcessing,
  useCreateTextMaterial,
  useMaterialFormatters,
  useMaterialLimits,
  useUploadMaterial,
} from './useMaterials';

import { isApiError } from '../../api/client';
import { MATERIAL_FILE_ACCEPT, materialFileRejection } from '../../api/materials';
import { useApiErrorMessage, useT } from '../../i18n/useT';

/** Свойства формы добавления материала. */
export interface MaterialUploaderProps {
  /** Вызывается после успешного добавления материала. */
  onAdded?: (material: Material) => void;
}

/** Способ добавления материала. */
type UploaderMode = 'file' | 'text';

/** Сообщение проверки на клиенте: ключ перевода и подстановки к нему. */
interface ValidationMessage {
  key: string;
  params?: Record<string, string | number>;
}

/** Сообщения об отказе клиентской проверки файла. */
const FILE_REJECTION_KEYS = {
  unsupported_format: 'uploader.validation.unsupportedFormat',
  too_large: 'uploader.validation.tooLarge',
  empty: 'uploader.validation.empty',
} as const;

/** Форма добавления материала: файл или вставленный текст. */
export function MaterialUploader({ onAdded }: MaterialUploaderProps) {
  const t = useT('materials');
  const toApiErrorMessage = useApiErrorMessage();
  const limits = useMaterialLimits();
  const { formatSize } = useMaterialFormatters();
  const upload = useUploadMaterial();
  const createText = useCreateTextMaterial();

  const fieldId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<UploaderMode>('file');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [validation, setValidation] = useState<ValidationMessage | null>(null);
  const [added, setAdded] = useState<Material | null>(null);
  const [dragging, setDragging] = useState(false);

  const maxSize = formatSize(limits.maxUploadBytes);
  const isBusy = upload.isPending || createText.isPending;
  const failure: unknown = upload.error ?? createText.error;

  const { reset: resetUpload } = upload;
  const { reset: resetText } = createText;

  /** Сбрасывает результат предыдущей попытки, когда пользователь правит форму. */
  const clearOutcome = useCallback((): void => {
    setValidation(null);
    setAdded(null);
    resetUpload();
    resetText();
  }, [resetText, resetUpload]);

  /** Принимает файл из поля выбора или перетаскивания, проверив его. */
  const acceptFile = useCallback(
    (next: File | null): void => {
      clearOutcome();

      if (!next) {
        setFile(null);

        return;
      }

      const rejection = materialFileRejection(next, limits.maxUploadBytes);

      if (rejection) {
        setFile(null);
        setValidation({ key: FILE_REJECTION_KEYS[rejection], params: { size: maxSize } });

        return;
      }

      setFile(next);
    },
    [clearOutcome, limits.maxUploadBytes, maxSize],
  );

  /** Общая часть успешного добавления: очистка формы и уведомление страницы. */
  const handleAdded = useCallback(
    (material: Material): void => {
      setAdded(material);
      setTitle('');

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      onAdded?.(material);
    },
    [onAdded],
  );

  const submitFile = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (!file) {
      setValidation({ key: 'uploader.validation.noFile' });

      return;
    }

    upload.mutate(
      { file, title: title.trim() || undefined },
      {
        onSuccess: (material) => {
          setFile(null);
          handleAdded(material);
        },
      },
    );
  };

  const submitText = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const trimmed = text.trim();

    if (trimmed.length === 0) {
      setValidation({ key: 'uploader.validation.noText' });

      return;
    }

    if (trimmed.length > limits.maxTextLength) {
      setValidation({
        key: 'uploader.validation.textTooLong',
        params: { max: limits.maxTextLength },
      });

      return;
    }

    createText.mutate(
      { text: trimmed, title: title.trim() || undefined },
      {
        onSuccess: (material) => {
          setText('');
          handleAdded(material);
        },
      },
    );
  };

  /** Отказ сервера: у 413, 415 и 400 есть свои формулировки. */
  const describeFailure = (error: unknown): string => {
    if (isApiError(error)) {
      if (error.status === 413 || error.code === 'payload_too_large') {
        return t('errors.tooLarge', { size: maxSize });
      }

      if (error.status === 415 || error.code === 'unsupported_media_type') {
        return t('errors.unsupportedFormat');
      }

      if (error.status === 400 || error.isValidationError) {
        return t('errors.rejected');
      }
    }

    return toApiErrorMessage(error);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    acceptFile(event.dataTransfer.files[0] ?? null);
  };

  const titleField = (
    <p>
      <label htmlFor={`${fieldId}-title`}>{t('uploader.titleField.label')}</label>{' '}
      <input
        id={`${fieldId}-title`}
        type="text"
        value={title}
        maxLength={200}
        disabled={isBusy}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
      />
      <span className="lt-page__lead"> {t('uploader.titleField.hint')}</span>
    </p>
  );

  return (
    <section className="lt-card" aria-labelledby={`${fieldId}-uploader`}>
      <h2 id={`${fieldId}-uploader`}>{t('uploader.title')}</h2>

      <fieldset>
        <legend>{t('uploader.mode.legend')}</legend>
        {(['file', 'text'] as const).map((value) => (
          <label key={value} htmlFor={`${fieldId}-mode-${value}`}>
            <input
              id={`${fieldId}-mode-${value}`}
              type="radio"
              name={`${fieldId}-mode`}
              value={value}
              checked={mode === value}
              disabled={isBusy}
              onChange={() => {
                setMode(value);
                clearOutcome();
              }}
            />{' '}
            {t(`uploader.mode.${value}`)}
          </label>
        ))}
      </fieldset>

      {mode === 'file' ? (
        <form onSubmit={submitFile} noValidate>
          <div
            className={dragging ? 'lt-dropzone lt-dropzone--active' : 'lt-dropzone'}
            role="group"
            aria-label={t('uploader.file.dropzoneLabel')}
            aria-describedby={`${fieldId}-formats`}
            style={{
              padding: 'var(--lt-space-md)',
              border: '1px dashed var(--lt-color-border)',
              borderRadius: 'var(--lt-radius)',
              backgroundColor: dragging ? 'var(--lt-color-surface)' : 'transparent',
            }}
            onDragOver={handleDragOver}
            onDragEnter={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <p>{t('uploader.file.dropHint')}</p>
            <p>
              <label htmlFor={`${fieldId}-file`}>{t('uploader.file.inputLabel')}</label>{' '}
              <input
                id={`${fieldId}-file`}
                ref={fileInputRef}
                type="file"
                accept={MATERIAL_FILE_ACCEPT}
                disabled={isBusy}
                onChange={(event) => {
                  acceptFile(event.target.files?.[0] ?? null);
                }}
              />
            </p>
            <p id={`${fieldId}-formats`} className="lt-page__lead">
              {t('uploader.file.formats', { size: maxSize })}
            </p>
            {file && (
              <p role="status">
                {t('uploader.file.selected', { name: file.name, size: formatSize(file.size) })}
              </p>
            )}
          </div>

          {titleField}

          <button type="submit" className="lt-button" disabled={isBusy}>
            {t('uploader.file.submit')}
          </button>
        </form>
      ) : (
        <form onSubmit={submitText} noValidate>
          <p>
            <label htmlFor={`${fieldId}-text`}>{t('uploader.text.label')}</label>
          </p>
          <textarea
            id={`${fieldId}-text`}
            value={text}
            rows={8}
            disabled={isBusy}
            aria-describedby={`${fieldId}-text-counter`}
            style={{ width: '100%', font: 'inherit' }}
            onChange={(event) => {
              clearOutcome();
              setText(event.target.value);
            }}
          />
          <p id={`${fieldId}-text-counter`} className="lt-page__lead">
            {t('uploader.text.counter', { used: text.trim().length, max: limits.maxTextLength })}
          </p>

          {titleField}

          <button type="submit" className="lt-button" disabled={isBusy}>
            {t('uploader.text.submit')}
          </button>
        </form>
      )}

      {validation && (
        <p className="lt-banner lt-banner--error" role="alert">
          {t(validation.key, { ...validation.params })}
        </p>
      )}

      {isBusy && (
        <p role="status">
          {upload.isPending
            ? t('uploader.file.progress', { name: file?.name ?? '' })
            : t('uploader.text.progress')}{' '}
          <progress aria-label={t('uploader.progressLabel')} />
        </p>
      )}

      {failure !== null && failure !== undefined && (
        <p className="lt-banner lt-banner--error" role="alert">
          {describeFailure(failure)}
        </p>
      )}

      {added && (
        <p role="status">
          {isMaterialProcessing(added)
            ? t('uploader.accepted', { title: added.title })
            : t('uploader.success', { title: added.title })}
        </p>
      )}
    </section>
  );
}
