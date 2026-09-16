/**
 * Общий доступ к уроку по идентификатору.
 *
 * Планирование урока и его проведение живут в разных сервисах, но урок ищут
 * одинаково, и ответ на «урока нет» должен быть один и тот же: 404 с пометкой
 * `lesson_not_found`, по которой клиент отличает удалённый урок от отказа.
 */
import type { Id, Lesson } from '@lt/shared';

import { notFound } from '../lib/httpErrors.js';
import { findLessonById } from '../repositories/lessonRepository.js';

/** Урок по идентификатору; 404, если его нет. */
export function requireLesson(id: Id): Lesson {
  const lesson = findLessonById(id);

  if (lesson === undefined) {
    throw notFound('Урок не найден', { details: { reason: 'lesson_not_found', lessonId: id } });
  }

  return lesson;
}
