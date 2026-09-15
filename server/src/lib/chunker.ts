/**
 * Разбиение текста материала на фрагменты (`material_chunks`).
 *
 * Фрагмент — единица, которой оперируют планировщик урока и тьютор: он должен
 * помещаться в промпт целиком и при этом быть осмысленным куском текста. Поэтому
 * граница фрагмента всегда проходит по границе абзаца, строки или предложения,
 * а «рубить» текст посреди слова приходится только на аномально длинных кусках
 * без знаков препинания.
 *
 * Соседние фрагменты перекрываются: начало фрагмента повторяет хвост предыдущего
 * (`overlapChars`), чтобы фраза, разорванная границей, целиком попадала хотя бы
 * в один фрагмент.
 *
 * Токены нигде не считаются точно: токенизатора модели на сервере нет, поэтому
 * используется грубая оценка «символы / 4» (см. `estimateTokens`).
 */

/** Размер, начиная с которого фрагмент считается достаточным и закрывается. */
export const DEFAULT_CHUNK_TARGET_CHARS = 800;

/** Жёсткий предел длины собственного текста фрагмента (без перекрытия). */
export const DEFAULT_CHUNK_MAX_CHARS = 1200;

/** Сколько символов хвоста предыдущего фрагмента повторяется в начале следующего. */
export const DEFAULT_CHUNK_OVERLAP_CHARS = 100;

/** Сколько символов текста приходится на один токен в грубой оценке. */
export const CHARS_PER_TOKEN = 4;

/** Параметры разбиения; любой из них можно не задавать. */
export interface ChunkOptions {
  /** Целевой размер фрагмента: набрав его, фрагмент закрывается на ближайшей границе. */
  targetChars?: number;
  /** Верхняя граница собственного текста фрагмента. */
  maxChars?: number;
  /** Длина перекрытия с предыдущим фрагментом. */
  overlapChars?: number;
}

/** Исходный кусок текста: страница PDF или весь текстовый файл целиком. */
export interface TextSource {
  text: string;
  /** Номер страницы PDF (с единицы); `null` — источник без страниц. */
  page?: number | null;
}

/** Готовый фрагмент: то, что сохраняется в `material_chunks`. */
export interface TextChunk {
  content: string;
  charCount: number;
  /** Страница, с которой начинается собственный текст фрагмента. */
  page: number | null;
  /** Ближайший предшествующий заголовок Markdown, если он был. */
  heading: string | null;
}

/** Минимальная единица, которую разбиение не рвёт: абзац, строка или предложение. */
interface TextUnit {
  text: string;
  /** Чем единица присоединяется к предыдущей внутри одного фрагмента. */
  separator: string;
  page: number | null;
  heading: string | null;
}

/** Заголовок Markdown: `## Название`. */
const MARKDOWN_HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Граница предложения: точка, вопросительный или восклицательный знак и пробел. */
const SENTENCE_BOUNDARY_PATTERN = /(?<=[.!?…»"'])\s+/;

/** Грубая оценка числа токенов: точного токенизатора модели на сервере нет. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Разбивает текст одного источника (текстовый файл, вставленный текст). */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  return chunkSources([{ text, page: null }], options);
}

/**
 * Разбивает текст материала на фрагменты.
 *
 * Источники обрабатываются подряд, как единый текст: перекрытие переносится
 * и через границу страниц PDF, потому что предложение может её пересекать.
 */
export function chunkSources(
  sources: readonly TextSource[],
  options: ChunkOptions = {},
): TextChunk[] {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_CHUNK_MAX_CHARS);
  const targetChars = Math.min(
    Math.max(1, options.targetChars ?? DEFAULT_CHUNK_TARGET_CHARS),
    maxChars,
  );
  const overlapChars = Math.max(
    0,
    Math.min(options.overlapChars ?? DEFAULT_CHUNK_OVERLAP_CHARS, maxChars),
  );
  const units = toUnits(sources, maxChars);

  return withOverlap(pack(units, targetChars, maxChars), overlapChars);
}

/** Собирает единицы разбиения по всем источникам, попутно отслеживая заголовки. */
function toUnits(sources: readonly TextSource[], maxChars: number): TextUnit[] {
  const units: TextUnit[] = [];
  let heading: string | null = null;

  for (const source of sources) {
    const page = source.page ?? null;
    const paragraphs = source.text.split(/\n{2,}/);

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim();

      if (trimmed.length === 0) {
        continue;
      }

      heading = headingOf(trimmed) ?? heading;

      const pieces = splitParagraph(trimmed, maxChars);
      let first = true;

      for (const piece of pieces) {
        units.push({
          text: piece.text,
          separator: first ? '\n\n' : piece.separator,
          page,
          heading,
        });
        first = false;
      }
    }
  }

  return units;
}

/** Заголовок Markdown в начале абзаца, если он там есть. */
function headingOf(paragraph: string): string | null {
  const firstLine = paragraph.split('\n', 1)[0] ?? '';
  const match = MARKDOWN_HEADING_PATTERN.exec(firstLine);

  return match?.[2]?.trim() ?? null;
}

/** Абзац целиком либо его части: строки, предложения, на крайний случай — куски по словам. */
function splitParagraph(
  paragraph: string,
  maxChars: number,
): { text: string; separator: string }[] {
  if (paragraph.length <= maxChars) {
    return [{ text: paragraph, separator: '\n\n' }];
  }

  const pieces: { text: string; separator: string }[] = [];

  for (const line of splitKeepingNonEmpty(paragraph, /\n/)) {
    if (line.length <= maxChars) {
      pieces.push({ text: line, separator: '\n' });
      continue;
    }

    for (const sentence of splitKeepingNonEmpty(line, SENTENCE_BOUNDARY_PATTERN)) {
      if (sentence.length <= maxChars) {
        pieces.push({ text: sentence, separator: ' ' });
        continue;
      }

      for (const part of splitByWords(sentence, maxChars)) {
        pieces.push({ text: part, separator: ' ' });
      }
    }
  }

  return pieces;
}

/** Делит строку разделителем, отбрасывая пустые куски. */
function splitKeepingNonEmpty(text: string, separator: RegExp): string[] {
  return text
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Режет аномально длинный кусок без знаков препинания по границам слов. */
function splitByWords(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = text;

  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const boundary = window.lastIndexOf(' ');
    const cut = boundary > maxChars / 2 ? boundary : maxChars;

    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest.length > 0) {
    parts.push(rest);
  }

  return parts;
}

/** Набирает фрагменты: закрывает текущий, когда он достиг цели или следующая единица не влезает. */
function pack(units: readonly TextUnit[], targetChars: number, maxChars: number): TextChunk[] {
  const chunks: TextChunk[] = [];
  let buffer = '';
  let page: number | null = null;
  let heading: string | null = null;

  const flush = (): void => {
    if (buffer.length === 0) {
      return;
    }

    chunks.push({ content: buffer, charCount: buffer.length, page, heading });
    buffer = '';
  };

  for (const unit of units) {
    if (buffer.length === 0) {
      buffer = unit.text;
      page = unit.page;
      heading = unit.heading;
      continue;
    }

    const candidate = `${buffer}${unit.separator}${unit.text}`;

    if (buffer.length >= targetChars || candidate.length > maxChars) {
      flush();
      buffer = unit.text;
      page = unit.page;
      heading = unit.heading;
      continue;
    }

    buffer = candidate;
  }

  flush();

  return chunks;
}

/** Дописывает в начало каждого фрагмента хвост предыдущего. */
function withOverlap(chunks: readonly TextChunk[], overlapChars: number): TextChunk[] {
  if (overlapChars === 0) {
    return [...chunks];
  }

  return chunks.map((chunk, index) => {
    const previous = index === 0 ? undefined : chunks[index - 1];
    const overlap = previous === undefined ? '' : tailOf(previous.content, overlapChars);

    if (overlap.length === 0) {
      return chunk;
    }

    const content = `${overlap}\n${chunk.content}`;

    return { ...chunk, content, charCount: content.length };
  });
}

/** Хвост фрагмента длиной не больше `limit`, обрезанный по границе слова. */
function tailOf(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  const tail = text.slice(text.length - limit);
  const boundary = tail.search(/\s/);

  return (boundary === -1 ? tail : tail.slice(boundary + 1)).trim();
}
