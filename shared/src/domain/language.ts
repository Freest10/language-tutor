/** Языки интерфейса/изучения/объяснений и уровни CEFR. */
import { z } from 'zod';

/**
 * Языки, для которых в приложении есть готовые пресеты (подписи, промпты, голоса).
 * Список намеренно небольшой: приложение не привязано ни к одному конкретному языку.
 */
export const KNOWN_LANGUAGE_CODES = ['en', 'ru', 'de', 'es', 'fr'] as const;

/** Код языка из списка пресетов. */
export type KnownLanguageCode = (typeof KNOWN_LANGUAGE_CODES)[number];

/**
 * Код языка в нотации BCP-47: `en`, `ru`, `pt-BR`.
 * Union открытый — значение вне `KNOWN_LANGUAGE_CODES` допустимо
 * (подсказки IDE сохраняются, но ограничения нет).
 */
export type LanguageCode = KnownLanguageCode | (string & {});

/** Язык по умолчанию: используется, только когда профиль ещё не заполнен. */
export const DEFAULT_LANGUAGE_CODE: KnownLanguageCode = 'en';

/** Допустимая форма кода языка: основной субтег и произвольные уточнения. */
export const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Код языка BCP-47. */
export const languageCodeSchema: z.ZodType<LanguageCode, string> = z
  .string()
  .trim()
  .min(2)
  .max(16)
  .regex(LANGUAGE_CODE_PATTERN, 'Ожидается код языка BCP-47, например "en" или "pt-BR"');

/** Названия языков из пресетов: на самом языке и по-английски. */
export const LANGUAGE_LABELS: Record<
  KnownLanguageCode,
  { nativeName: string; englishName: string }
> = {
  en: { nativeName: 'English', englishName: 'English' },
  ru: { nativeName: 'Русский', englishName: 'Russian' },
  de: { nativeName: 'Deutsch', englishName: 'German' },
  es: { nativeName: 'Español', englishName: 'Spanish' },
  fr: { nativeName: 'Français', englishName: 'French' },
};

/** Язык в списке поддерживаемых (отдаётся в `GET /api/config`). */
export const languageOptionSchema = z.object({
  code: languageCodeSchema,
  nativeName: z.string().trim().min(1).max(60),
  englishName: z.string().trim().min(1).max(60),
});

/** Язык в списке поддерживаемых. */
export type LanguageOption = z.infer<typeof languageOptionSchema>;

/** Уровни CEFR в порядке возрастания. */
export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;

/** Уровень владения языком по шкале CEFR. */
export type CefrLevel = (typeof CEFR_LEVELS)[number];

/** Уровень владения языком по шкале CEFR. */
export const cefrLevelSchema = z.enum(CEFR_LEVELS);

/** Уровень, с которого начинается профиль до прохождения определения уровня. */
export const DEFAULT_CEFR_LEVEL: CefrLevel = 'A1';

/** Уверенность в оценке уровня: 0 — догадка, 1 — подтверждено измерениями. */
export const levelConfidenceSchema = z.number().min(0).max(1);
