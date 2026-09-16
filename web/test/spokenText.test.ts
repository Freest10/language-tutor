/**
 * Что из реплики тьютора уходит в озвучку.
 *
 * Голос подобран под изучаемый язык, и слова на языке объяснений он произнести
 * не может: серверный Kokoro русского не знает, браузерный английский голос
 * кириллицу читает по буквам. Проверяется, что такие слова из озвучки уходят,
 * а реплика на одной письменности с объяснениями остаётся нетронутой.
 */
import { describe, expect, it } from 'vitest';

import { scriptOfLanguage, spokenText } from '../src/features/voice/spokenText';

const EN_RU = { spoken: 'en', muted: 'ru' };

describe('scriptOfLanguage', () => {
  it('узнаёт письменность по коду языка', () => {
    expect(scriptOfLanguage('en')).toBe('Latn');
    expect(scriptOfLanguage('ru')).toBe('Cyrl');
    expect(scriptOfLanguage('pt-BR')).toBe('Latn');
    expect(scriptOfLanguage('ja')).toBe('Jpan');
  });

  it('на непонятном коде не падает', () => {
    expect(scriptOfLanguage('')).toBeUndefined();
  });
});

describe('spokenText', () => {
  it('убирает из реплики слова на языке объяснений', () => {
    expect(spokenText('Brush your teeth (чистить зубы) every day.', EN_RU)).toBe(
      'Brush your teeth every day.',
    );
  });

  it('оставляет знаки препинания на месте, когда слово перед ними вырезано', () => {
    expect(spokenText('Say «good morning» — доброе утро, and smile!', EN_RU)).toBe(
      'Say «good morning» — and smile!',
    );
  });

  it('не озвучивает реплику, в которой нет ни слова на изучаемом языке', () => {
    expect(spokenText('Молодец! Продолжаем урок.', EN_RU)).toBe('');
    expect(spokenText('   ', EN_RU)).toBe('');
  });

  it('оставляет реплику как есть, если языки пишутся одной письменностью', () => {
    // Немецкий с английскими объяснениями: отличить их по буквам нельзя, а
    // вырезать по догадке — хуже, чем произнести.
    expect(spokenText('Das ist gut (that is good).', { spoken: 'de', muted: 'en' })).toBe(
      'Das ist gut (that is good).',
    );
  });

  it('оставляет реплику как есть без языка объяснений', () => {
    expect(spokenText('Hello, друг!', { spoken: 'en', muted: null })).toBe('Hello, друг!');
  });

  it('работает и в обратную сторону: изучаемый русский, объяснения по-английски', () => {
    expect(spokenText('Я чищу зубы (I brush my teeth).', { spoken: 'ru', muted: 'en' })).toBe(
      'Я чищу зубы.',
    );
  });

  it('сохраняет границу предложения, когда вырезано его последнее слово', () => {
    // Без точки голос склеил бы «зубы Потом» в одну фразу; но и двух точек подряд
    // быть не должно.
    expect(
      spokenText('Я чищу зубы (I brush my teeth). Потом завтракаю.', { spoken: 'ru', muted: 'en' }),
    ).toBe('Я чищу зубы. Потом завтракаю.');
    expect(spokenText('Hello. Привет.', EN_RU)).toBe('Hello.');
  });

  it('оставляет числа и слова с буквами изучаемого языка', () => {
    expect(spokenText('I wake up at 11 a.m. — в 11 утра.', EN_RU)).toBe(
      'I wake up at 11 a.m. — 11.',
    );
  });
});
