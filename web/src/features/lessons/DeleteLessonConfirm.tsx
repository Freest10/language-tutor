/**
 * Подтверждение удаления урока: свой блок вместо системного `window.confirm`.
 *
 * Системный диалог блокирует поток, не переводится и не читается экранной
 * читалкой как часть страницы, поэтому подтверждение встроено в разметку — тем
 * же приёмом, что и у материалов: `role="group"`, фокус на кнопке подтверждения
 * и отмена по Escape.
 *
 * Блок общий для списка уроков и страницы плана намеренно: удаление в обоих
 * местах уносит одно и то же, и расхождение формулировок означало бы, что
 * пользователь узнаёт о последствиях по-разному в зависимости от того, откуда
 * нажал.
 *
 * Последствия перечислены полностью и обычным текстом, а не мелким шрифтом:
 * вместе с уроком уходит его история (лента реплик, задания и попытки), словарь
 * и журнал ошибок остаются, а материал урока снова становится непройденным и
 * вернётся в новые уроки — последнее для пользователя самое неожиданное.
 */
import { useEffect, useRef } from 'react';

import type { Lesson } from '@lt/shared';

import { useT } from '../../i18n/useT';

/** Свойства подтверждения удаления урока. */
export interface DeleteLessonConfirmProps {
  /** Урок, который удаляют: название — в вопросе, статус — в перечне последствий. */
  lesson: Pick<Lesson, 'title' | 'status'>;
  /** Запрос уже отправлен: кнопки заблокированы, показано ожидание. */
  isDeleting: boolean;
  /** Пользователь подтвердил удаление. */
  onConfirm: () => void;
  /** Пользователь отказался от удаления. */
  onCancel: () => void;
}

/** Подтверждение удаления урока с перечнем последствий. */
export function DeleteLessonConfirm({
  lesson,
  isDeleting,
  onConfirm,
  onCancel,
}: DeleteLessonConfirmProps) {
  const t = useT('lessons');
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
      <p className="lt-banner__title">{t('delete.question', { title: lesson.title })}</p>
      <p>{t('delete.removed')}</p>
      <p>{t('delete.material')}</p>
      {/* Статистика прогресса считается по попыткам: у завершённого урока их заметно. */}
      {lesson.status === 'completed' && <p>{t('delete.stats')}</p>}
      <p>{t('delete.kept')}</p>
      <p>{t('delete.irreversible')}</p>
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
