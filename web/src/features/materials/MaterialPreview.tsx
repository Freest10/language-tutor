/**
 * Панель просмотра материала: извлечённый текст фрагментами и пояснение к статусу.
 *
 * Текст догружается страницами фрагментов, а не целиком: материал может быть
 * книгой на сотни страниц, и держать её в памяти ради предпросмотра незачем.
 *
 * Для статусов `error_*` текста нет — вместо него показывается, что именно
 * не получилось и что с этим делать; подробности приходят от сервера в
 * `statusMessage`, потому что причина зависит от его настроек и платформы.
 *
 * Пока материал обрабатывается, панель обновляется сама (опрос живёт в
 * `useMaterialPreview`) и показывает прогресс сервера, а не пустой текст.
 */
import { useId } from 'react';

import { useMaterialPreview, useMaterialStatusText } from './useMaterials';

import { useApiErrorMessage, useT } from '../../i18n/useT';

/** Свойства панели просмотра материала. */
export interface MaterialPreviewProps {
  /** Материал, выбранный в списке; `null` — панель пуста. */
  materialId: string | null;
  /** Закрыть панель. */
  onClose?: () => void;
}

/** Панель с извлечённым текстом материала. */
export function MaterialPreview({ materialId, onClose }: MaterialPreviewProps) {
  const t = useT('materials');
  const toApiErrorMessage = useApiErrorMessage();
  const statusText = useMaterialStatusText();
  const preview = useMaterialPreview(materialId);
  const headingId = useId();
  const { material, chunks, total, hasMore, isLoading, isLoadingMore, isError, error } = preview;
  const status = material ? statusText(material) : null;

  return (
    <section className="lt-card" aria-labelledby={headingId} aria-busy={isLoading || isLoadingMore}>
      <h2 id={headingId}>{t('preview.title')}</h2>

      {materialId === null && <p className="lt-placeholder">{t('preview.nothingSelected')}</p>}

      {materialId !== null && isLoading && (
        <p className="lt-placeholder" role="status">
          {t('preview.loading')}
        </p>
      )}

      {materialId !== null && isError && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p className="lt-banner__title">{t('preview.error')}</p>
          <p>{toApiErrorMessage(error)}</p>
          <button type="button" className="lt-button" onClick={preview.refetch}>
            {t('common:actions.retry')}
          </button>
        </div>
      )}

      {material && status && (
        <>
          <h3 style={{ marginBottom: 0 }}>{material.title}</h3>

          {status.isError ? (
            <div className="lt-banner lt-banner--error" role="alert">
              <p className="lt-banner__title">{status.label}</p>
              <p>{status.hint}</p>
              {status.serverMessage && <p>{status.serverMessage}</p>}
            </div>
          ) : (
            <div role="status">
              <p className="lt-page__lead">
                {status.label}
                {status.isSelectable ? '' : `. ${status.hint}`}
              </p>
              {!status.isSelectable && status.serverMessage && (
                <p className="lt-page__lead">{status.serverMessage}</p>
              )}
              {status.isPending && <progress aria-label={t('status.progressLabel')} />}
            </div>
          )}

          <dl className="lt-facts">
            <dt>{t('preview.fields.language')}</dt>
            <dd>{material.language}</dd>

            <dt>{t('preview.fields.level')}</dt>
            <dd>{material.level ?? t('preview.fields.levelUnknown')}</dd>

            <dt>{t('preview.fields.chars')}</dt>
            <dd>{t('units.characters', { count: material.charCount })}</dd>

            {typeof material.pageCount === 'number' && (
              <>
                <dt>{t('preview.fields.pages')}</dt>
                <dd>{t('units.pages', { count: material.pageCount })}</dd>
              </>
            )}

            {material.topics.length > 0 && (
              <>
                <dt>{t('preview.fields.topics')}</dt>
                <dd>{material.topics.join(', ')}</dd>
              </>
            )}
          </dl>

          {material.summary && <p>{material.summary}</p>}

          {!status.isError && (
            <>
              {chunks.length === 0 && !isLoading && !status.isPending && (
                <p className="lt-placeholder">{t('preview.noText')}</p>
              )}

              {chunks.map((chunk) => (
                <article key={chunk.id}>
                  <h4 style={{ marginBottom: 0, color: 'var(--lt-color-muted)' }}>
                    {chunk.heading ??
                      (typeof chunk.page === 'number'
                        ? t('preview.chunkOnPage', { order: chunk.order + 1, page: chunk.page })
                        : t('preview.chunk', { order: chunk.order + 1 }))}
                  </h4>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{chunk.content}</p>
                </article>
              ))}

              {chunks.length > 0 && (
                <p className="lt-page__lead" role="status">
                  {t('preview.shown', { shown: chunks.length, total })}
                </p>
              )}

              {hasMore && (
                <button
                  type="button"
                  className="lt-button"
                  disabled={isLoadingMore}
                  onClick={preview.loadMore}
                >
                  {isLoadingMore ? t('preview.loadingMore') : t('preview.loadMore')}
                </button>
              )}
            </>
          )}
        </>
      )}

      {materialId !== null && onClose && (
        <p>
          <button type="button" className="lt-button" onClick={onClose}>
            {t('preview.close')}
          </button>
        </p>
      )}
    </section>
  );
}
