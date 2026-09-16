/**
 * Распознавание повторов в репликах тьютора.
 *
 * Проверяется то, ради чего оно написано: одна и та же просьба, сказанная
 * чуть иначе, считается повтором, а продолжение разговора — нет. Ошибка в
 * любую сторону дорога: пропущенный повтор оставляет урок топтаться на месте,
 * а ложный — гоняет модель второй раз на каждой реплике.
 */
import { describe, expect, it } from 'vitest';

import {
  isRepeatedUtterance,
  REPEAT_MIN_WORDS,
  utteranceWords,
  wordSimilarity,
} from '../src/lib/repetition.js';

describe('utteranceWords', () => {
  it('режет по не-буквам и не зависит от регистра', () => {
    expect(utteranceWords('Was kaufst du, bitte?')).toEqual(['was', 'kaufst', 'du', 'bitte']);
  });

  it('понимает кириллицу, а не только латиницу', () => {
    expect(utteranceWords('Расскажи — что ты делал вчера?')).toEqual([
      'расскажи',
      'что',
      'ты',
      'делал',
      'вчера',
    ]);
  });
});

describe('wordSimilarity', () => {
  it('у одинаковых реплик — единица, у непохожих — ноль', () => {
    expect(wordSimilarity('was kaufst du oft', 'Was kaufst du oft?')).toBe(1);
    expect(wordSimilarity('пойдём в кино', 'сегодня жарко')).toBe(0);
  });

  it('не зависит от порядка слов и знаков препинания', () => {
    expect(wordSimilarity('ты вчера что делал', 'Что ты делал вчера?!')).toBe(1);
  });
});

describe('isRepeatedUtterance', () => {
  it('ловит тот же вопрос, сказанный другими словами', () => {
    // Ученик уже ответил на это: повторить вопрос — значит топтаться на месте.
    expect(
      isRepeatedUtterance('Und was trinkst du zum Frühstück?', [
        'Gut! Was trinkst du zum Frühstück?',
      ]),
    ).toBe(true);
  });

  it('пропускает продолжение разговора', () => {
    expect(
      isRepeatedUtterance('Und was isst du zum Abendessen?', [
        'Gut! Was trinkst du zum Frühstück?',
      ]),
    ).toBe(false);
  });

  it('не считает повтором короткие связки', () => {
    // «Отлично!» и «А ещё?» звучат на уроке постоянно: запрещать их нельзя.
    expect(utteranceWords('Отлично!').length).toBeLessThan(REPEAT_MIN_WORDS);
    expect(isRepeatedUtterance('Отлично!', ['Отлично!'])).toBe(false);
  });

  it('сравнивает со всеми недавними репликами, а не только с последней', () => {
    expect(
      isRepeatedUtterance('Was kaufst du oft im Supermarkt?', [
        'Was kaufst du oft im Supermarkt?',
        'Gut gemacht!',
      ]),
    ).toBe(true);
  });

  it('на пустой истории повтора не находит', () => {
    expect(isRepeatedUtterance('Was kaufst du oft im Supermarkt?', [])).toBe(false);
  });
});
