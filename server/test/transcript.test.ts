/**
 * Чистка расшифровки от служебных пометок распознавателя.
 *
 * Граница здесь важнее самой чистки: пометку убрать надо, а слова ученика в
 * скобках — нельзя, он мог сказать их вслух.
 */
import { describe, expect, it } from 'vitest';

import { cleanTranscript } from '../src/lib/transcript.js';

describe('cleanTranscript', () => {
  it('убирает пометку тишины и лишние пробелы', () => {
    expect(cleanTranscript('[BLANK_AUDIO] Hi, what do you think?')).toBe('Hi, what do you think?');
  });

  it('убирает пометки в любом месте реплики', () => {
    expect(cleanTranscript('Hello [MUSIC] world (SILENCE)')).toBe('Hello world');
  });

  it('оставляет пустую строку, если кроме пометки ничего не было', () => {
    // Пустая расшифровка — нормальный исход: клиент скажет «речь не распознана».
    expect(cleanTranscript(' [BLANK_AUDIO] ')).toBe('');
  });

  it('понимает пометки словами, а не только прописными', () => {
    expect(cleanTranscript('(silence) Guten Morgen')).toBe('Guten Morgen');
    expect(cleanTranscript('Приветик (тишина)')).toBe('Приветик');
  });

  it('не трогает слова ученика в скобках', () => {
    // Скобки в речи — обычное дело, и вычищать оттуда слова приложение не вправе.
    expect(cleanTranscript('Я купил хлеб (и молоко) вчера')).toBe('Я купил хлеб (и молоко) вчера');
  });

  it('не принимает за пометку аббревиатуру в скобках рядом со словами', () => {
    expect(cleanTranscript('Я работаю в (ООО Ромашка) давно')).toBe(
      'Я работаю в (ООО Ромашка) давно',
    );
  });

  it('не трогает цифры и знаки в скобках', () => {
    expect(cleanTranscript('Позвони в (495) 123-45-67')).toBe('Позвони в (495) 123-45-67');
  });
});
