/**
 * Что из реплики тьютора озвучивать.
 *
 * Реплика тьютора по правилам промпта написана на изучаемом языке, но модель
 * нередко вставляет в неё перевод или пояснение на языке объяснений: «Brush your
 * teeth (чистить зубы)». Голос при этом подобран под изучаемый язык — и слова
 * на другом языке он либо читает по буквам, либо выдаёт шум: серверный синтез
 * (Kokoro) русский не знает вовсе, а браузерный английский голос кириллицу не
 * произносит. Поэтому перед озвучкой из реплики убираются слова, написанные
 * письменностью языка объяснений, а реплика, в которой на изучаемом языке нет
 * ни слова, не озвучивается совсем.
 *
 * Отличить языки можно только по письменности: словарей у клиента нет. Если оба
 * языка пишутся одной письменностью (немецкий с английскими объяснениями),
 * фильтр ничего не убирает — и это правильно: такой текст голос прочитать
 * способен, а вырезать по догадке — нельзя.
 *
 * Письменность языка узнаётся через `Intl.Locale#maximize()`: `ru` → `Cyrl`,
 * `en` → `Latn`, `ja` → `Jpan`. Слово считается написанным на языке объяснений,
 * если в нём есть буквы его письменности и нет ни одной буквы письменности
 * изучаемого языка: «Präsens» остаётся, «(чистить)» уходит вместе со скобками.
 */

/** Письменность как класс символов регулярного выражения по субтегу BCP-47. */
const SCRIPT_CLASSES: Record<string, string> = {
  Latn: '\\p{Script=Latin}',
  Cyrl: '\\p{Script=Cyrillic}',
  Grek: '\\p{Script=Greek}',
  Arab: '\\p{Script=Arabic}',
  Hebr: '\\p{Script=Hebrew}',
  Armn: '\\p{Script=Armenian}',
  Geor: '\\p{Script=Georgian}',
  Deva: '\\p{Script=Devanagari}',
  Thai: '\\p{Script=Thai}',
  Hang: '\\p{Script=Hangul}',
  Hans: '\\p{Script=Han}',
  Hant: '\\p{Script=Han}',
  // Японский и корейский пишутся несколькими письменностями сразу.
  Jpan: '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}',
  Kore: '\\p{Script=Hangul}\\p{Script=Han}',
};

/** Субтег письменности языка (`Latn`, `Cyrl`); `undefined` — узнать не удалось. */
export function scriptOfLanguage(language: string): string | undefined {
  try {
    return new Intl.Locale(language).maximize().script ?? undefined;
  } catch {
    return undefined;
  }
}

/** Регулярное выражение «есть хотя бы одна буква этой письменности». */
function scriptLetters(script: string): RegExp | undefined {
  const cls = SCRIPT_CLASSES[script];

  return cls === undefined ? undefined : new RegExp(`[${cls}]`, 'u');
}

/** Знаки конца предложения в хвосте слова. */
const SENTENCE_END = /[.!?…]+$/u;

/** Пробел перед знаком препинания, оставшийся от вырезанного слова. */
const SPACE_BEFORE_PUNCTUATION = /\s+([,.;:!?…)\]»”’])/gu;

/** Пустые скобки и кавычки, оставшиеся от вырезанного слова. */
const EMPTY_BRACKETS = /\(\s*\)|\[\s*\]|«\s*»|“\s*”|"\s*"|‘\s*’|'\s*'/gu;

/** Языки реплики: на каком она звучит и какой из неё убрать. */
export interface SpokenTextLanguages {
  /** Язык произношения — изучаемый язык. */
  spoken: string;
  /** Язык объяснений: слова на нём не озвучиваются. */
  muted: string | null | undefined;
}

/**
 * Текст реплики, который стоит отдать голосу: без слов на языке объяснений.
 *
 * @returns текст для озвучки; пустая строка — озвучивать нечего.
 */
export function spokenText(text: string, languages: SpokenTextLanguages): string {
  const trimmed = text.trim();

  if (trimmed === '' || languages.muted == null) {
    return trimmed;
  }

  const spokenScript = scriptOfLanguage(languages.spoken);
  const mutedScript = scriptOfLanguage(languages.muted);

  if (spokenScript === undefined || mutedScript === undefined || spokenScript === mutedScript) {
    return trimmed;
  }

  const spokenLetters = scriptLetters(spokenScript);
  const mutedLetters = scriptLetters(mutedScript);

  if (spokenLetters === undefined || mutedLetters === undefined) {
    return trimmed;
  }

  const kept: string[] = [];

  for (const word of trimmed.split(/\s+/u)) {
    // Слово из письменности объяснений без единой буквы изучаемого языка — вырезаем
    // целиком, вместе с прилипшими знаками: «(чистить)» уходит со скобками.
    if (!(mutedLetters.test(word) && !spokenLetters.test(word))) {
      kept.push(word);
      continue;
    }

    // Но точка в хвосте такого слова — граница предложения: без неё голос склеит
    // две фразы в одну. Знак переезжает на предыдущее слово, если оно предложение
    // ещё не закончило.
    const tail = SENTENCE_END.exec(word)?.[0];
    const last = kept.at(-1);

    if (tail !== undefined && last !== undefined && !SENTENCE_END.test(last)) {
      kept[kept.length - 1] = last + tail;
    }
  }

  if (!kept.some((word) => spokenLetters.test(word))) {
    return '';
  }

  return kept
    .join(' ')
    .replace(EMPTY_BRACKETS, '')
    .replace(SPACE_BEFORE_PUNCTUATION, '$1')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}
