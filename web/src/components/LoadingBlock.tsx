/**
 * Заглушка на время загрузки: подпись в живой области и полосы-скелетоны.
 *
 * Блок был скопирован в шести местах (список уроков, комната урока, страница
 * плана, диалог создания урока, пересборка плана, определение уровня) — с
 * разным числом полос, разными классами и то с `aria-busy`, то без него.
 * Здесь он один: смена состояния всегда озвучивается экранной читалкой
 * (`role="status"`), а `aria-busy` сообщает, что содержимое ещё не готово.
 *
 * Компонент ничего не знает про переводы: подпись приходит свойством, потому
 * что у каждого раздела она своя («Загружаем урок», «Тьютор готовит план»).
 */
import type { ReactNode } from 'react';

/** Свойства блока загрузки. */
export interface LoadingBlockProps {
  /** Что именно загружается: текст читает экранная читалка. */
  label: string;
  /** Сколько полос-заглушек нарисовать; по умолчанию две. */
  lines?: number;
  /** Оформить карточкой — когда блок стоит на месте будущей карточки. */
  card?: boolean;
  /** Пояснения под подписью: сколько это займёт, какая модель отвечает. */
  children?: ReactNode;
  /** Дополнительный класс контейнера. */
  className?: string;
}

/** Заглушка на время загрузки данных. */
export function LoadingBlock({
  label,
  lines = 2,
  card = false,
  children,
  className,
}: LoadingBlockProps) {
  const classNames = ['lt-loading', card ? 'lt-card' : null, className ?? null].filter(
    (value): value is string => value !== null,
  );

  return (
    <div className={classNames.join(' ')} aria-busy="true">
      <p className="lt-placeholder" role="status">
        {label}
      </p>
      {children}
      {Array.from({ length: Math.max(0, lines) }, (_, index) => (
        <p key={index} className="lt-skeleton lt-loading__line" aria-hidden="true" />
      ))}
    </div>
  );
}
