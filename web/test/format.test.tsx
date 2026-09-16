/**
 * Форматирование дат: одно правило на всё приложение.
 *
 * До объединения у каждой фичи была своя копия форматирования: `formatDate`
 * означал то дату, то дату со временем, а неразбираемое значение превращалось
 * то в исходную строку, то в `null`. Перенос компонента между разделами молча
 * менял вид даты, поэтому тест сверяет три фичевых хука между собой, а не
 * только отдельные функции.
 */
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useLessonFormatters } from '../src/features/lessons/useLessons';
import { useMaterialFormatters } from '../src/features/materials/useMaterials';
import { useProgressFormatters } from '../src/features/progress/useProgress';
import { i18n } from '../src/i18n';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { formatDate, formatDateTime, parseIsoDate } from '../src/lib/format';

/** Момент времени, у которого дата и время различимы в любом языке. */
const MOMENT = '2026-09-15T18:45:00.000Z';

/** Значение, которое датой не является: сервер прислал что-то своё. */
const BROKEN = 'не дата';

/** Оборачивает хук в провайдер языка интерфейса. */
function wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}

beforeEach(async () => {
  await i18n.changeLanguage('ru');
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('форматирование даты', () => {
  it('различает дату и дату со временем', () => {
    const date = formatDate(MOMENT, 'ru');
    const dateTime = formatDateTime(MOMENT, 'ru');

    expect(dateTime).not.toBe(date);
    expect(dateTime.startsWith(date)).toBe(true);
    // Часы есть только у `formatDateTime`.
    expect(/\d{1,2}:\d{2}/.test(date)).toBe(false);
    expect(/\d{1,2}:\d{2}/.test(dateTime)).toBe(true);
  });

  it('учитывает язык интерфейса', () => {
    expect(formatDate(MOMENT, 'ru')).not.toBe(formatDate(MOMENT, 'en'));
  });

  it('неразбираемое значение возвращает как есть — и то, и другое', () => {
    // `null` здесь означал бы пустоту в интерфейсе вместо значения сервера.
    expect(formatDate(BROKEN, 'ru')).toBe(BROKEN);
    expect(formatDateTime(BROKEN, 'ru')).toBe(BROKEN);
    expect(parseIsoDate(BROKEN)).toBeNull();
    expect(parseIsoDate(MOMENT)).toBeInstanceOf(Date);
  });

  it('подробность даты выбирается явно', () => {
    expect(formatDate(MOMENT, 'ru', 'long')).not.toBe(formatDate(MOMENT, 'ru', 'short'));
  });
});

describe('форматирование дат в фичах', () => {
  it('материалы, уроки и прогресс форматируют дату одинаково', () => {
    const materials = renderHook(() => useMaterialFormatters(), { wrapper }).result.current;
    const lessons = renderHook(() => useLessonFormatters(), { wrapper }).result.current;
    const progress = renderHook(() => useProgressFormatters(), { wrapper }).result.current;

    // Раньше `formatDate` в двух фичах из трёх означал дату со временем.
    expect(materials.formatDate(MOMENT)).toBe(progress.formatDate(MOMENT));
    expect(lessons.formatDate(MOMENT)).toBe(progress.formatDate(MOMENT));

    expect(materials.formatDateTime(MOMENT)).toBe(progress.formatDateTime(MOMENT));
    expect(lessons.formatDateTime(MOMENT)).toBe(progress.formatDateTime(MOMENT));

    expect(progress.formatDate(MOMENT)).not.toBe(progress.formatDateTime(MOMENT));
  });

  it('неразбираемую дату все фичи показывают одинаково', () => {
    const materials = renderHook(() => useMaterialFormatters(), { wrapper }).result.current;
    const lessons = renderHook(() => useLessonFormatters(), { wrapper }).result.current;
    const progress = renderHook(() => useProgressFormatters(), { wrapper }).result.current;

    expect(materials.formatDate(BROKEN)).toBe(BROKEN);
    expect(lessons.formatDate(BROKEN)).toBe(BROKEN);
    expect(progress.formatDate(BROKEN)).toBe(BROKEN);
  });
});
