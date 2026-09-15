/**
 * Правила работы с профилем ученика.
 *
 * Профиль один и существует всегда: строку-заготовку создаёт миграция, поэтому
 * `getProfile()` её только читает. Пересоздание дефолта — защитный путь на случай,
 * когда базу правили в обход приложения.
 *
 * Что здесь решается, помимо записи полей:
 * - языки принимаются только из списка пресетов (`KNOWN_LANGUAGE_CODES`), иначе 400:
 *   для неизвестного языка у приложения нет ни подписей, ни голосов, ни промптов;
 * - ручная смена уровня фиксируется в истории уровня (`source: 'manual'`) вместе
 *   с обоснованием и метриками — допущение A13 требует их всегда;
 * - смена изучаемого языка обнуляет уверенность в уровне и признак пройденного
 *   определения уровня: измерения относились к прежнему языку.
 *
 * `getProfileForPrompt()` — единственный способ положить профиль в system-промпт:
 * тьютор обязан подстраиваться под уровень, цели и интересы ученика.
 */
import { randomUUID } from 'node:crypto';

import {
  CEFR_LEVELS,
  DEFAULT_CEFR_LEVEL,
  DEFAULT_DAILY_MINUTES,
  KNOWN_LANGUAGE_CODES,
  LANGUAGE_LABELS,
  type CefrLevel,
  type LanguageCode,
  type LearnerProfile,
  type LevelChangeDirection,
  type LevelChangeMetrics,
  type LevelHistoryEntry,
  type UpdateProfileRequest,
} from '@lt/shared';

import { learnerProfileToRow, nowIso, rowToLearnerProfile } from '../db/mappers.js';
import { PROFILE_ROW_ID } from '../db/rows.js';
import { badRequest } from '../lib/httpErrors.js';
import {
  findLatestLevelHistoryEntry,
  findProfileRow,
  saveProfileRow,
} from '../repositories/profileRepository.js';

/**
 * Значения профиля-заготовки. Совпадают со строкой, которую вставляет миграция
 * `001_init.sql`: пересозданный профиль не должен отличаться от изначального.
 */
const DEFAULT_PROFILE = {
  learningLanguage: 'en',
  interfaceLanguage: 'ru',
  explanationLanguage: 'ru',
  goal: 'Научиться общаться на повседневные темы',
} as const;

/**
 * Уверенность в уровне после ручной смены: 0 — «догадка» по шкале
 * `levelConfidence`. Уровень, названный самим учеником, измерениями не подтверждён.
 */
const MANUAL_LEVEL_CONFIDENCE = 0;

/** Поля запроса, которые содержат код языка. */
const LANGUAGE_FIELDS = ['learningLanguage', 'interfaceLanguage', 'explanationLanguage'] as const;

/** Языки пресетов: быстрая проверка допустимости кода. */
const SUPPORTED_LANGUAGE_CODES = new Set<string>(KNOWN_LANGUAGE_CODES);

/** Английские названия языков пресетов для строк промпта. */
const LANGUAGE_NAMES: Record<string, string | undefined> = Object.fromEntries(
  KNOWN_LANGUAGE_CODES.map((code) => [code, LANGUAGE_LABELS[code].englishName]),
);

/** Профиль-заготовка: используется, только если строки профиля в базе нет. */
function defaultProfile(): LearnerProfile {
  const now = nowIso();

  return {
    id: PROFILE_ROW_ID,
    learningLanguage: DEFAULT_PROFILE.learningLanguage,
    interfaceLanguage: DEFAULT_PROFILE.interfaceLanguage,
    explanationLanguage: DEFAULT_PROFILE.explanationLanguage,
    level: DEFAULT_CEFR_LEVEL,
    levelConfidence: 0,
    goals: [DEFAULT_PROFILE.goal],
    interests: [],
    dailyMinutes: DEFAULT_DAILY_MINUTES,
    placementCompletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Проверяет, что все переданные языки есть в списке пресетов. */
function assertSupportedLanguages(input: UpdateProfileRequest): void {
  for (const field of LANGUAGE_FIELDS) {
    const value = input[field];

    if (value !== undefined && !SUPPORTED_LANGUAGE_CODES.has(value)) {
      // Кода `unsupported_language` в `API_ERROR_CODES` нет, поэтому машиночитаемый
      // признак уходит в `details`, а код ошибки остаётся из контракта.
      throw badRequest(`Язык «${value}» не поддерживается`, {
        details: {
          reason: 'unsupported_language',
          field,
          value,
          supported: [...KNOWN_LANGUAGE_CODES],
        },
      });
    }
  }
}

/** Направление изменения уровня по шкале CEFR. */
function levelDirection(fromLevel: CefrLevel, toLevel: CefrLevel): LevelChangeDirection {
  return CEFR_LEVELS.indexOf(toLevel) > CEFR_LEVELS.indexOf(fromLevel) ? 'up' : 'down';
}

/**
 * Метрики ручного изменения уровня. Измерений за ним не стоит, поэтому все счётчики
 * нулевые: `exercisesEvaluated: 0` однозначно говорит, что `accuracy` не вычислялась.
 */
function manualLevelMetrics(): LevelChangeMetrics {
  return {
    accuracy: 0,
    lessonsConsidered: 0,
    lessonsSinceLastChange: 0,
    exercisesEvaluated: 0,
    windowFrom: null,
    windowTo: null,
  };
}

/**
 * Запись истории для ручной смены уровня. Первая запись в истории считается
 * первичной установкой (`direction: 'initial'`, `fromLevel: null`): до неё уровень
 * профиля — значение заготовки, а не результат измерения.
 */
function buildManualLevelChange(
  fromLevel: CefrLevel,
  toLevel: CefrLevel,
  changedAt: string,
): LevelHistoryEntry {
  const isInitial = findLatestLevelHistoryEntry() === undefined;

  return {
    id: randomUUID(),
    fromLevel: isInitial ? null : fromLevel,
    toLevel,
    direction: isInitial ? 'initial' : levelDirection(fromLevel, toLevel),
    source: 'manual',
    confidence: MANUAL_LEVEL_CONFIDENCE,
    reason: isInitial
      ? `Уровень ${toLevel} задан вручную в профиле`
      : `Уровень изменён вручную в профиле: ${fromLevel} → ${toLevel}`,
    metrics: manualLevelMetrics(),
    changedAt,
    createdAt: changedAt,
  };
}

/** Профиль ученика. Если строки профиля нет, она создаётся заново из дефолтов. */
export function getProfile(): LearnerProfile {
  const row = findProfileRow();

  if (row !== undefined) {
    return rowToLearnerProfile(row);
  }

  const profile = defaultProfile();

  saveProfileRow(learnerProfileToRow(profile, { onboardingCompleted: false }));

  return profile;
}

/**
 * Частичное обновление профиля.
 *
 * Побочные эффекты:
 * - смена `level` добавляет запись в историю уровня (`source: 'manual'`) и обнуляет
 *   `levelConfidence`: новый уровень назван учеником, а не измерен;
 * - смена `learningLanguage` обнуляет `levelConfidence` и `placementCompletedAt` —
 *   для нового языка нужно новое определение уровня. Сам `level` при этом
 *   сохраняется: сбрасывать его до A1 без измерения было бы такой же догадкой.
 *
 * Успешный вызов означает, что профиль подтверждён пользователем, поэтому
 * `onboarding_completed` переводится в 1 (в контракт эта колонка не отдаётся).
 */
export function updateProfile(input: UpdateProfileRequest): LearnerProfile {
  assertSupportedLanguages(input);

  const current = getProfile();
  const changedAt = nowIso();
  const learningLanguageChanged =
    input.learningLanguage !== undefined && input.learningLanguage !== current.learningLanguage;
  const levelChanged = input.level !== undefined && input.level !== current.level;

  const next: LearnerProfile = {
    ...current,
    learningLanguage: input.learningLanguage ?? current.learningLanguage,
    interfaceLanguage: input.interfaceLanguage ?? current.interfaceLanguage,
    explanationLanguage: input.explanationLanguage ?? current.explanationLanguage,
    level: input.level ?? current.level,
    levelConfidence:
      learningLanguageChanged || levelChanged ? MANUAL_LEVEL_CONFIDENCE : current.levelConfidence,
    goals: input.goals ?? current.goals,
    interests: input.interests ?? current.interests,
    dailyMinutes: input.dailyMinutes ?? current.dailyMinutes,
    placementCompletedAt: learningLanguageChanged ? null : current.placementCompletedAt,
    updatedAt: changedAt,
  };

  const levelChange = levelChanged
    ? buildManualLevelChange(current.level, next.level, changedAt)
    : undefined;

  saveProfileRow(learnerProfileToRow(next, { onboardingCompleted: true }), { levelChange });

  return next;
}

/** Название языка для промпта: `German (de)`, для кода вне пресетов — сам код. */
function languageForPrompt(code: LanguageCode): string {
  const name = LANGUAGE_NAMES[code];

  return name === undefined ? code : `${name} (${code})`;
}

/** Список для промпта: элементы через `; `, пустой — явная пометка. */
function listForPrompt(items: readonly string[]): string {
  return items.length === 0 ? 'not specified' : items.join('; ');
}

/**
 * Компактное текстовое представление профиля для system-промптов (определение уровня,
 * планирование и проведение урока). Формат — строки `- Ключ: значение`, стабильный
 * порядок полей; цели и интересы остаются в том виде, в каком их написал ученик.
 *
 * Пример:
 * ```text
 * Learner profile:
 * - Learning language: German (de)
 * - Explanation language: Russian (ru)
 * - Interface language: Russian (ru)
 * - CEFR level: A2 (confidence 0.60, placement completed)
 * - Daily study time: 20 min
 * - Goals: заказать кофе; пройти собеседование
 * - Interests: путешествия
 * ```
 */
export function getProfileForPrompt(profile: LearnerProfile = getProfile()): string {
  const placement = profile.placementCompletedAt == null ? 'not completed' : 'completed';

  return [
    'Learner profile:',
    `- Learning language: ${languageForPrompt(profile.learningLanguage)}`,
    `- Explanation language: ${languageForPrompt(profile.explanationLanguage)}`,
    `- Interface language: ${languageForPrompt(profile.interfaceLanguage)}`,
    `- CEFR level: ${profile.level} (confidence ${profile.levelConfidence.toFixed(2)}, placement ${placement})`,
    `- Daily study time: ${String(profile.dailyMinutes)} min`,
    `- Goals: ${listForPrompt(profile.goals)}`,
    `- Interests: ${listForPrompt(profile.interests)}`,
  ].join('\n');
}
