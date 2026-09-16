/**
 * Форматирование дат по языку интерфейса — одно на всё приложение.
 *
 * Раньше у каждой фичи была своя копия: одинаковые тела под разными именами
 * (`formatDateTime`, `formatLessonDate`, `formatWith`) и разное поведение на
 * неразбираемом значении — где-то исходная строка, где-то `null`. Перенос
 * компонента между разделами молча менял вид даты, поэтому правило здесь одно:
 *
 * - `formatDate` — только дата;
 * - `formatDateTime` — дата и время;
 * - значение, которое не разбирается в дату, возвращается как есть (а не `null`
 *   и не «Invalid Date»): в интерфейсе лучше показать сырое значение сервера,
 *   чем пустоту.
 *
 * Хуки фич (`useMaterialFormatters`, `useLessonFormatters`,
 * `useProgressFormatters`) — тонкие обёртки над этими функциями, которые
 * подставляют текущий язык интерфейса.
 */

/** Насколько подробно пишется дата: `medium` — вид по умолчанию во всём приложении. */
export type DateStyle = 'short' | 'medium' | 'long';

/** Стиль даты по умолчанию: `15 сент. 2026 г.` */
export const DEFAULT_DATE_STYLE: DateStyle = 'medium';

/**
 * Разбирает значение в дату.
 *
 * @param value момент времени в ISO-8601.
 * @returns дату или `null`, если значение не разбирается.
 */
export function parseIsoDate(value: string): Date | null {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Только дата в формате языка интерфейса.
 *
 * @param isoDate момент времени в ISO-8601.
 * @param locale язык интерфейса.
 * @param dateStyle подробность даты; по умолчанию `medium`.
 * @returns дату или исходную строку, если она не разбирается.
 */
export function formatDate(
  isoDate: string,
  locale: string,
  dateStyle: DateStyle = DEFAULT_DATE_STYLE,
): string {
  const date = parseIsoDate(isoDate);

  return date === null ? isoDate : new Intl.DateTimeFormat(locale, { dateStyle }).format(date);
}

/**
 * Дата и время в формате языка интерфейса: там, где важен и час.
 *
 * @param isoDate момент времени в ISO-8601.
 * @param locale язык интерфейса.
 * @returns дату со временем или исходную строку, если она не разбирается.
 */
/**
 * Только время, без даты: подпись реплики в ленте урока.
 *
 * Дата там не нужна — урок идёт в один присест, и повторять её у каждой реплики
 * значило бы засорять диалог.
 *
 * @param isoDate момент времени в ISO-8601.
 * @param locale язык интерфейса.
 * @returns время или исходную строку, если она не разбирается.
 */
export function formatTime(isoDate: string, locale: string): string {
  const date = parseIsoDate(isoDate);

  return date === null
    ? isoDate
    : new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(date);
}

export function formatDateTime(isoDate: string, locale: string): string {
  const date = parseIsoDate(isoDate);

  return date === null
    ? isoDate
    : new Intl.DateTimeFormat(locale, {
        dateStyle: DEFAULT_DATE_STYLE,
        timeStyle: 'short',
      }).format(date);
}
