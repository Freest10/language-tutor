/**
 * Выбор материалов, на которых строится урок.
 *
 * Список материалов читается своим запросом (`['lessons', 'materials', ...]`):
 * раздел материалов — соседний пакет, и делить с ним кэш нельзя, иначе его
 * фильтры начнут влиять на этот экран.
 *
 * Выбрать можно только материал со статусом `ready`. Остальные видны, но
 * недоступны, и рядом с каждым написано, почему: иначе пользователь не поймёт,
 * куда делся его скан PDF, и решит, что приложение потеряло файл.
 *
 * Рядом с материалом видно, сколько его уже отработано: без этого невозможно
 * понять, почему очередной урок берёт из учебника всё меньше нового, и
 * останется ли в нём вообще новый материал.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';

import type { Material } from '@lt/shared';

import {
  LESSON_MATERIALS_PAGE_SIZE,
  MAX_LESSON_MATERIALS,
  useLessonErrorMessage,
  useLessonMaterialStatusText,
  useLessonMaterials,
} from './useLessons';

import { useT } from '../../i18n/useT';
import { ROUTE_PATHS } from '../../router';
import { materialCoverage } from '../materials/useMaterials';

/** Свойства выбора материалов. */
export interface MaterialPickerProps {
  /** Выбранные материалы. */
  selectedIds: readonly string[];
  /**
   * Новый набор выбранных материалов.
   *
   * Вторым аргументом идут сами материалы: диалогу нужна их пройденность,
   * а список материалов читает этот компонент, а не он.
   */
  onChange: (materialIds: readonly string[], materials: readonly Material[]) => void;
  /** Блокирует выбор — например, пока модель готовит план. */
  disabled?: boolean;
  /** Сколько материалов допустимо выбрать. */
  max?: number;
}

/** Свойства строки списка материалов. */
interface MaterialOptionProps {
  material: Material;
  selected: boolean;
  /** Выбор недоступен: материал не готов, идёт генерация или набран предел. */
  disabled: boolean;
  /** Предел выбранных материалов достигнут, а этот ещё не выбран. */
  limitReached: boolean;
  max: number;
  onToggle: (materialId: string, selected: boolean) => void;
}

/** Строка списка: материал, его статус и причина недоступности. */
function MaterialOption({
  material,
  selected,
  disabled,
  limitReached,
  max,
  onToggle,
}: MaterialOptionProps) {
  const t = useT('lessons');
  const statusText = useLessonMaterialStatusText();
  const status = statusText(material);
  const coverage = materialCoverage(material);
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const tone = status.isError ? 'error' : status.isPending ? 'warn' : 'ok';
  const hints = [
    status.isSelectable ? null : status.hint,
    status.serverMessage,
    limitReached ? t('materials.limitReached', { max }) : null,
    // Нетронутый материал о пройденном молчит: пустой счётчик ничего не объясняет.
    coverage.hasCovered
      ? t('materials.coverage.progress', { count: coverage.covered, total: coverage.total })
      : null,
  ].filter((hint): hint is string => typeof hint === 'string' && hint.length > 0);

  return (
    <li
      className={selected ? 'lt-list__item lt-list__item--selected' : 'lt-list__item'}
      style={{ alignItems: 'flex-start', flexDirection: 'column' }}
    >
      <span className="lt-list__row">
        <input
          id={inputId}
          type="checkbox"
          checked={selected}
          disabled={disabled}
          aria-describedby={hints.length > 0 ? hintId : undefined}
          data-status={material.status}
          onChange={(event) => {
            onToggle(material.id, event.target.checked);
          }}
        />
        <label className="lt-list__title" htmlFor={inputId}>
          {material.title}
        </label>
        <span className={`lt-badge lt-badge--${tone}`}>{status.label}</span>
        {coverage.isFullyCovered && (
          <span className="lt-badge lt-badge--muted" data-covered="full">
            {t('materials.coverage.completed')}
          </span>
        )}
      </span>
      {hints.length > 0 && (
        <span className="lt-status" id={hintId}>
          {hints.join(' ')}
        </span>
      )}
    </li>
  );
}

/** Выбор материалов урока: только обработанные материалы доступны для выбора. */
export function MaterialPicker({
  selectedIds,
  onChange,
  disabled = false,
  max = MAX_LESSON_MATERIALS,
}: MaterialPickerProps) {
  const t = useT('lessons');
  const toErrorMessage = useLessonErrorMessage();
  const [limit, setLimit] = useState(LESSON_MATERIALS_PAGE_SIZE);
  const { materials, total, hasMore, isLoading, isError, error, refetch } = useLessonMaterials({
    limit,
  });
  const hintId = useId();
  const limitReached = selectedIds.length >= max;

  /** Сообщает новый выбор: идентификаторы и сами материалы этого выбора. */
  const apply = (ids: readonly string[]): void => {
    onChange(
      ids,
      materials.filter((material) => ids.includes(material.id)),
    );
  };

  const toggle = (materialId: string, selected: boolean): void => {
    if (selected) {
      if (selectedIds.includes(materialId) || limitReached) {
        return;
      }

      apply([...selectedIds, materialId]);

      return;
    }

    apply(selectedIds.filter((id) => id !== materialId));
  };

  return (
    <fieldset
      className="lt-field"
      style={{ border: 0, margin: '0 0 var(--lt-space-md)', padding: 0 }}
      disabled={disabled}
    >
      <legend className="lt-field__label">{t('materials.label')}</legend>
      <p className="lt-field__hint" id={hintId}>
        {t('materials.hint')}
      </p>

      {isLoading && (
        <p className="lt-placeholder" role="status">
          {t('materials.loading')}
        </p>
      )}

      {isError && (
        <div className="lt-banner lt-banner--error" role="alert">
          <p className="lt-banner__title">{t('materials.error')}</p>
          <p>{toErrorMessage(error)}</p>
          <button type="button" className="lt-button" onClick={refetch}>
            {t('common:actions.retry')}
          </button>
        </div>
      )}

      {!isLoading && !isError && materials.length === 0 && (
        <p className="lt-placeholder">
          {t('materials.empty.description')}{' '}
          <Link to={ROUTE_PATHS.materials}>{t('materials.empty.action')}</Link>
        </p>
      )}

      {materials.length > 0 && (
        <>
          <ul className="lt-list" aria-describedby={hintId}>
            {materials.map((material) => {
              const selected = selectedIds.includes(material.id);
              const selectable = material.status === 'ready';

              return (
                <MaterialOption
                  key={material.id}
                  material={material}
                  selected={selected}
                  disabled={!selectable || (limitReached && !selected)}
                  limitReached={selectable && limitReached && !selected}
                  max={max}
                  onToggle={toggle}
                />
              );
            })}
          </ul>

          <p className="lt-status">{t('materials.selected', { count: selectedIds.length, max })}</p>

          {hasMore && (
            <button
              type="button"
              className="lt-button"
              onClick={() => {
                setLimit((current) => current + LESSON_MATERIALS_PAGE_SIZE);
              }}
            >
              {t('materials.loadMore', { shown: materials.length, total })}
            </button>
          )}
        </>
      )}
    </fieldset>
  );
}
