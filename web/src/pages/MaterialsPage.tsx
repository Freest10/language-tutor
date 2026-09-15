/**
 * Материалы, на которых строятся уроки: добавление, список и просмотр текста.
 *
 * Страница держит только выбор материала и размер показанной страницы списка;
 * данные и мутации живут в `features/materials/useMaterials`, чтобы выбор
 * материалов для урока переиспользовал те же запросы.
 */
import { useState } from 'react';

import { MaterialList } from '../features/materials/MaterialList';
import { MaterialPreview } from '../features/materials/MaterialPreview';
import { MaterialUploader } from '../features/materials/MaterialUploader';
import { MATERIALS_PAGE_SIZE, useMaterials } from '../features/materials/useMaterials';
import { useT } from '../i18n/useT';

/** Материалы, на которых строятся уроки. */
export function MaterialsPage() {
  const t = useT('materials');
  const [limit, setLimit] = useState(MATERIALS_PAGE_SIZE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { materials, total, hasMore, isLoading, isError, error, refetch } = useMaterials({ limit });

  return (
    <section className="lt-page" aria-labelledby="lt-materials-title">
      <h1 id="lt-materials-title" className="lt-page__title">
        {t('title')}
      </h1>
      <p className="lt-page__lead">{t('subtitle')}</p>

      <MaterialUploader
        onAdded={(material) => {
          setSelectedId(material.id);
        }}
      />

      <MaterialList
        materials={materials}
        total={total}
        isLoading={isLoading}
        isError={isError}
        error={error}
        hasMore={hasMore}
        onLoadMore={() => {
          setLimit((current) => current + MATERIALS_PAGE_SIZE);
        }}
        onRetry={refetch}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onDeleted={(materialId) => {
          setSelectedId((current) => (current === materialId ? null : current));
        }}
      />

      <MaterialPreview
        materialId={selectedId}
        onClose={() => {
          setSelectedId(null);
        }}
      />
    </section>
  );
}
