/**
 * Чистка расшифровки от служебных пометок распознавателя.
 *
 * Whisper на тишине и шуме возвращает не пустую строку, а пометку в скобках —
 * `[BLANK_AUDIO]`, `[MUSIC]`, `(silence)`. Это не слова ученика: если такое
 * попадёт в поле ввода, он отправит их тьютору, а тьютор примет за реплику.
 *
 * Правило намеренно узкое: убираются только скобки, внутри которых нет строчных
 * букв (`[BLANK_AUDIO]`, `[MUSIC]`), и несколько известных пометок словами.
 * Всё остальное — текст ученика: в скобках он может сказать что угодно, и
 * вычищать оттуда слова приложение не вправе.
 */

/** Известные пометки распознавателя строчными буквами. */
const KNOWN_MARKERS = [
  'blank_audio',
  'blank audio',
  'silence',
  'no speech',
  'inaudible',
  'music',
  'noise',
  'sound',
  'applause',
  'laughter',
  'laughs',
  'тишина',
  'музыка',
  'шум',
  'неразборчиво',
];

/** Содержимое скобок: `[...]`, `(...)`, `*...*`. */
const BRACKETED = /\[[^\]\n]*\]|\([^)\n]*\)|\*[^*\n]*\*/gu;

/** Является ли содержимое скобок служебной пометкой, а не словами ученика. */
function isMarker(inner: string): boolean {
  const trimmed = inner.trim();

  if (trimmed.length === 0) {
    return false;
  }

  // Пометки распознавателя пишутся прописными: `BLANK_AUDIO`, `MUSIC`.
  if (!/\p{Ll}/u.test(trimmed) && /\p{L}/u.test(trimmed)) {
    return true;
  }

  return KNOWN_MARKERS.includes(trimmed.toLowerCase());
}

/**
 * Убирает служебные пометки и лишние пробелы.
 *
 * @param text расшифровка, как её вернул распознаватель.
 * @returns текст без пометок; пустая строка означает «речи не было».
 */
export function cleanTranscript(text: string): string {
  return text
    .replace(BRACKETED, (match) => (isMarker(match.slice(1, -1)) ? ' ' : match))
    .replace(/\s+/gu, ' ')
    .trim();
}
