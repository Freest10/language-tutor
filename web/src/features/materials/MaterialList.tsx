/**
 * Список материалов: что загружено, в каком состоянии обработки и что с этим делать.
 *
 * Подтверждение удаления встроено в строку списка, а не вызывает `window.confirm`:
 * системный диалог блокирует поток, не переводится и не читается экранной читалкой
 * как часть страницы.
 */
import { useEffect, useId, useRef, useState } from 'react';

import { isMaterialErrorStatus, type Material, type MaterialStatus } from '@lt/shared';

import { useDeleteMaterial, useMaterialFormatters, useMaterialStatusText } from './useMaterials';

import type { ApiError } from '../../api/client';
import { useApiErrorMessage, useT } from '../../i18n/useT';

/** Свойства списка материалов. */
export interface MaterialListProps {
  /** Материалы текущей страницы списка. */
  materials: Material[];
  /** Сколько материалов всего на сервере. */
  total: number;
  isLoading: boolean;
  isError: boolean;
  /** Отказ запроса; текст для пользователя собирает сам список. */
  error: ApiError | null;
  /** Есть ли материалы за пределами показанной страницы. */
  hasMore: boolean;
  /** Показать следующую страницу списка. */
  onLoadMore: () => void;
  /** Перечитать список: и кнопка «Обновить», и повтор после ошибки. */
  onRetry: () => void;
  /** Материал, открытый в панели просмотра. */
  selectedId: string | null;
  /** Открыть материал в панели просмотра. */
  onSelect: (materialId: string) => void;
  /** Материал удалён: страница закрывает панель просмотра. */
  onDeleted?: (materialId: string) => void;
}

/** Оформление бейджа статуса: по семантике статуса, цвета — из токенов темы. */
function statusStyle(status: MaterialStatus): { backgroundColor: string; borderColor: string } {
  if (isMaterialErrorStatus(status)) {
    return {
      backgroundColor: 'var(--lt-color-error-bg)',
      borderColor: 'var(--lt-color-error-border)',
    };
  }

  if (status === 'ready') {
    return {
      backgroundColor: 'var(--lt-color-surface)',
      borderColor: 'var(--lt-color-accent)',
    };
  }

  return {
    backgroundColor: 'var(--lt-color-warning-bg)',
    borderColor: 'var(--lt-color-warning-border)',
  };
}

/** Свойства подтверждения удаления. */
interface DeleteConfirmProps {
  material: Material;
  isDeleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Подтверждение удаления материала: свой блок вместо системного диалога. */
function DeleteConfirm({ material, isDeleting, onConfirm, onCancel }: DeleteConfirmProps) {
  const t = useT('materials');
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Фокус переезжает на подтверждение: с клавиатуры не нужно искать кнопку заново.
    confirmRef.current?.focus();
  }, []);

  return (
    <div
      className="lt-banner lt-banner--error"
      role="group"
      aria-label={t('delete.title')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <p className="lt-banner__title">{t('delete.question', { title: material.title })}</p>
      <p>{t('delete.warning')}</p>
      <button
        ref={confirmRef}
        type="button"
        className="lt-button"
        disabled={isDeleting}
        onClick={onConfirm}
      >
        {t('delete.confirm')}
      </button>{' '}
      <button type="button" className="lt-button" disabled={isDeleting} onClick={onCancel}>
        {t('common:actions.cancel')}
      </button>
      {isDeleting && <p role="status">{t('delete.pending')}</p>}
    </div>
  );
}

/** Свойства строки списка. */
interface MaterialRowProps {
  material: Material;
  selected: boolean;
  confirming: boolean;
  isDeleting: boolean;
  onSelect: (materialId: string) => void;
  onRequestDelete: (materialId: string) => void;
  onConfirmDelete: (materialId: string) => void;
  onCancelDelete: () => void;
}

/** Строка списка: название, свойства файла, статус обработки и действия. */
function MaterialRow({
  material,
  selected,
  confirming,
  isDeleting,
  onSelect,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: MaterialRowProps) {
  const t = useT('materials');
  const { formatSize, formatDateTime } = useMaterialFormatters();
  const statusText = useMaterialStatusText();
  const status = statusText(material);
  const titleId = useId();

  return (
    <li className="lt-card" style={{ marginBottom: 'var(--lt-space-md)' }}>
      <h3 id={titleId} style={{ margin: 0 }}>
        {material.title}
      </h3>
      <p>
        <span
          data-status={material.status}
          style={{
            display: 'inline-block',
            padding: 'var(--lt-space-xs) var(--lt-space-sm)',
            border: '1px solid',
            borderRadius: 'var(--lt-radius)',
            ...statusStyle(material.status),
          }}
        >
          {status.label}
        </span>
      </p>
      {material.status !== 'ready' && (
        <p className="lt-page__lead" role={status.isError ? 'alert' : 'status'}>
          {status.hint}
        </p>
      )}
      {status.serverMessage && <p className="lt-page__lead">{status.serverMessage}</p>}
      <dl className="lt-facts">
        <dt>{t('list.fields.sourceType')}</dt>
        <dd>{t(`sourceType.${material.sourceType}`)}</dd>

        <dt>{t('list.fields.size')}</dt>
        <dd>
          {typeof material.sizeBytes === 'number'
            ? formatSize(material.sizeBytes)
            : t('units.characters', { count: material.charCount })}
        </dd>

        <dt>{t('list.fields.createdAt')}</dt>
        <dd>{formatDateTime(material.createdAt)}</dd>

        <dt>{t('list.fields.chunks')}</dt>
        <dd>{t('units.chunks', { count: material.chunkCount })}</dd>
      </dl>
      <button
        type="button"
        className="lt-button"
        aria-pressed={selected}
        aria-describedby={titleId}
        onClick={() => {
          onSelect(material.id);
        }}
      >
        {t('list.actions.preview')}
      </button>{' '}
      <button
        type="button"
        className="lt-button"
        aria-describedby={titleId}
        disabled={confirming}
        onClick={() => {
          onRequestDelete(material.id);
        }}
      >
        {t('common:actions.delete')}
      </button>
      {confirming && (
        <DeleteConfirm
          material={material}
          isDeleting={isDeleting}
          onConfirm={() => {
            onConfirmDelete(material.id);
          }}
          onCancel={onCancelDelete}
        />
      )}
    </li>
  );
}

/** Список материалов с удалением и переходом в панель просмотра. */
export function MaterialList({
  materials,
  total,
  isLoading,
  isError,
  error,
  hasMore,
  onLoadMore,
  onRetry,
  selectedId,
  onSelect,
  onDeleted,
}: MaterialListProps) {
  const t = useT('materials');
  const toApiErrorMessage = useApiErrorMessage();
  const remove = useDeleteMaterial();
  const headingId = useId();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const confirmDelete = (materialId: string): void => {
    remove.mutate(materialId, {
      onSuccess: () => {
        setConfirmingId(null);
        onDeleted?.(materialId);
      },
    });
  };

  return (
    <section className="lt-card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t('list.title')}</h2>

      <button type="button" className="lt-button" disabled={isLoading} onClick={onRetry}>
        {t('common:actions.refresh')}
      </button>

      {isLoading && (
        <p className="lt-placeholder" role="status">
          {t('common:status.loading')}
        </p>
      )}

      {isError && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p className="lt-banner__title">{t('list.error')}</p>
          <p>{toApiErrorMessage(error)}</p>
          <button type="button" className="lt-button" onClick={onRetry}>
            {t('common:actions.retry')}
          </button>
        </div>
      )}

      {!isLoading && !isError && materials.length === 0 && (
        <p className="lt-placeholder">{t('list.empty')}</p>
      )}

      {materials.length > 0 && (
        <>
          <p className="lt-page__lead">{t('list.summary', { shown: materials.length, total })}</p>
          <ul aria-labelledby={headingId} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {materials.map((material) => (
              <MaterialRow
                key={material.id}
                material={material}
                selected={material.id === selectedId}
                confirming={material.id === confirmingId}
                isDeleting={remove.isPending && remove.variables === material.id}
                onSelect={onSelect}
                onRequestDelete={setConfirmingId}
                onConfirmDelete={confirmDelete}
                onCancelDelete={() => {
                  setConfirmingId(null);
                }}
              />
            ))}
          </ul>

          {hasMore && (
            <button type="button" className="lt-button" onClick={onLoadMore}>
              {t('list.actions.loadMore')}
            </button>
          )}
        </>
      )}

      {remove.error && (
        <p className="lt-banner lt-banner--error" role="alert">
          {t('errors.deleteFailed')} {toApiErrorMessage(remove.error)}
        </p>
      )}
    </section>
  );
}
