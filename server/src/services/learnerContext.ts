/**
 * Компактный текстовый блок «что известно об ученике» для system-промптов
 * планирования и проведения урока.
 *
 * Требование ТЗ — тьютор подстраивается под уровень и цели, — упирается в то, что
 * модель должна видеть накопленную историю: уровень, цели, интересы, слабые места,
 * слова в работе и темы последних уроков. Всё это собирается здесь в один блок.
 *
 * Два правила модуля:
 * - **жёсткий предел длины.** Контекст растёт вместе с историей занятий, а окно
 *   модели — нет, поэтому блок обрезается до `LEARNER_CONTEXT_MAX_CHARS`. Строки
 *   идут в порядке убывания важности, и результат всегда является префиксом полного
 *   блока: первая строка, которая не помещается, обрывает сборку;
 * - **пустая база — не ошибка.** На чистом профиле блок состоит из уровня, целей
 *   и интересов, а разделы без данных просто пропускаются.
 *
 * Язык блока — английский, как и у `getProfileForPrompt()`: это часть промпта,
 * а не текст для пользователя. Слова, переводы и темы уроков остаются как есть.
 *
 * Использование: `import * as learnerContext from './learnerContext.js'` и затем
 * `learnerContext.build({ language })`.
 */
import type { ErrorCategory, LanguageCode, LearnerProfile } from '@lt/shared';

import {
  countErrorsByCategory,
  countLessonsByStatus,
  getExerciseTotals,
  listRecentErrorLogEntries,
  listRecentLessonTopics,
  listRecentVocabularyItems,
} from '../repositories/progressRepository.js';

import { getProfile } from './profileService.js';

/** Предел длины блока в символах: дальше он начинает съедать окно модели. */
export const LEARNER_CONTEXT_MAX_CHARS = 1200;

/** Предел длины одной строки блока: один раздутый раздел не вытесняет остальные. */
const MAX_LINE_CHARS = 200;

/** Сколько слабых мест, ошибок, слов и тем попадает в блок. */
const MAX_WEAK_AREAS = 3;
const MAX_MISTAKES = 3;
const MAX_WORDS = 8;
const MAX_TOPICS = 3;

/** Параметры сборки контекста. */
export interface LearnerContextOptions {
  /** Язык, по которому собирается история; по умолчанию — `learningLanguage` профиля. */
  language?: LanguageCode;
  /** Предел длины блока; по умолчанию `LEARNER_CONTEXT_MAX_CHARS`. */
  maxChars?: number;
  /** Уже прочитанный профиль: избавляет от повторного обращения к базе. */
  profile?: LearnerProfile;
}

/** Обрезает строку по пределу, помечая обрыв многоточием. */
function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** Список для промпта: элементы через `; `. */
function joinItems(items: readonly string[]): string {
  return items.join('; ');
}

/** Доля в процентах. */
function percent(correct: number, total: number): string {
  return total === 0 ? 'n/a' : `${String(Math.round((correct / total) * 100))}%`;
}

/** Слабые места: категории ошибок с ненулевым счётчиком, самые частые впереди. */
function weakAreas(counts: Record<ErrorCategory, number>): string[] {
  return Object.entries(counts)
    .filter(([, total]) => total > 0)
    .sort(([, left], [, right]) => right - left)
    .slice(0, MAX_WEAK_AREAS)
    .map(([category, total]) => `${category} (${String(total)})`);
}

/**
 * Собирает блок контекста ученика.
 *
 * Разделы (в порядке приоритета): уровень, цели, интересы, объём практики,
 * частые категории ошибок, последние исправления, слова в работе, темы уроков.
 * Разделы без данных пропускаются, результат не длиннее `maxChars` символов.
 */
export function build(options: LearnerContextOptions = {}): string {
  const profile = options.profile ?? getProfile();
  const language = options.language ?? profile.learningLanguage;
  const maxChars = options.maxChars ?? LEARNER_CONTEXT_MAX_CHARS;

  const lessons = countLessonsByStatus();
  const totals = getExerciseTotals();
  const mistakes = listRecentErrorLogEntries({ language, limit: MAX_MISTAKES });
  const words = listRecentVocabularyItems({
    language,
    statuses: ['new', 'learning'],
    limit: MAX_WORDS,
  });
  const topics = listRecentLessonTopics({ language, limit: MAX_TOPICS });
  const areas = weakAreas(countErrorsByCategory({ language }));

  const lines: string[] = [
    `Learner context (${language}):`,
    `- CEFR level: ${profile.level} (confidence ${profile.levelConfidence.toFixed(2)})`,
  ];

  if (profile.goals.length > 0) {
    lines.push(`- Goals: ${joinItems(profile.goals)}`);
  }
  if (profile.interests.length > 0) {
    lines.push(`- Interests: ${joinItems(profile.interests)}`);
  }

  lines.push(
    `- Practice: ${String(lessons.completed)} lessons completed, ` +
      `${String(totals.total)} exercises, accuracy ${percent(totals.correct, totals.total)}`,
  );

  if (areas.length > 0) {
    lines.push(`- Frequent mistakes by category: ${joinItems(areas)}`);
  }
  if (mistakes.length > 0) {
    lines.push(
      `- Recent corrections: ${joinItems(
        mistakes.map((entry) => `"${entry.original}" → "${entry.corrected}" (${entry.category})`),
      )}`,
    );
  }
  if (words.length > 0) {
    lines.push(
      `- Words in progress: ${joinItems(words.map((word) => `${word.term} — ${word.translation}`))}`,
    );
  }
  if (topics.length > 0) {
    lines.push(`- Recent lesson topics: ${joinItems(topics)}`);
  }

  const block: string[] = [];
  let length = 0;

  for (const line of lines) {
    const capped = truncate(line, MAX_LINE_CHARS);
    const addition = block.length === 0 ? capped.length : capped.length + 1;

    if (length + addition > maxChars) {
      break;
    }

    block.push(capped);
    length += addition;
  }

  return block.join('\n');
}
