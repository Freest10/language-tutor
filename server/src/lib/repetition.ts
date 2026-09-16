/**
 * Распознавание повторов в репликах тьютора.
 *
 * Модель на уроке иногда зацикливается: задаёт вопрос, на который ученик уже
 * ответил, и урок топчется на месте. Причины бывают разные — короткое окно
 * контекста у локальной модели, слабая модель, неудачная выборка, — но признак
 * один и тот же, и увидеть его можно без модели: новая реплика почти дословно
 * повторяет одну из предыдущих.
 *
 * Сравнение идёт по множествам слов, а не по строкам целиком: между «Расскажи,
 * что ты делал вчера?» и «Расскажи, что ты делал вчера!» разницы для ученика
 * нет, а посимвольное сравнение её бы нашло. Порядок слов и знаки препинания
 * не важны по той же причине.
 *
 * Короткие реплики («Отлично!», «А ещё?») повтором не считаются: у них слишком
 * мало слов, чтобы отличить осмысленное совпадение от случайного, и запрещать
 * их значило бы запретить тьютору обычные связки.
 *
 * Отдельно сравнивается вопрос, которым реплика заканчивается. Тьютор по правилам
 * промпта сначала откликается на сказанное учеником и только потом спрашивает,
 * поэтому реплика «Ты любишь кафе. А что ещё вы делаете вместе?» на множестве
 * слов почти не похожа на «Ты любишь гулять. Отлично! А что ещё вы делаете
 * вместе?» — а для ученика это тот же вопрос в третий раз.
 */

/**
 * Доля общих слов, начиная с которой реплики считаются одной и той же.
 *
 * Порог подобран по тому, как модель повторяется на самом деле: она редко
 * повторяет реплику слово в слово, обычно меняется обрамление — «Gut! Was
 * trinkst du zum Frühstück?» превращается в «Und was trinkst du zum
 * Frühstück?». Общих слов там 5 из 7, то есть 0.71, и порог 0.8 такой повтор
 * пропустил бы.
 *
 * Ошибиться в эту сторону дешевле: ложное срабатывание стоит одного лишнего
 * обращения к модели, а пропущенный повтор — впустую потраченного хода урока.
 */
export const REPEAT_SIMILARITY_THRESHOLD = 0.65;

/** Меньше этого числа значимых слов — сравнивать бессмысленно. */
export const REPEAT_MIN_WORDS = 4;

/**
 * Слова реплики в сравнимом виде: без регистра, без знаков препинания.
 *
 * Границей слова считается всё, что не буква и не цифра: `\p{L}` и `\p{N}`
 * покрывают и латиницу, и кириллицу, и иероглифы, а `\w` — нет.
 */
export function utteranceWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/**
 * Доля общих слов у двух реплик: 1 — те же слова, 0 — ни одного общего.
 *
 * Считается по множествам (мера Жаккара), поэтому повторённое дважды слово
 * не перевешивает остальные.
 */
export function wordSimilarity(left: string, right: string): number {
  const leftWords = new Set(utteranceWords(left));
  const rightWords = new Set(utteranceWords(right));

  if (leftWords.size === 0 || rightWords.size === 0) {
    return 0;
  }

  let shared = 0;

  for (const word of leftWords) {
    if (rightWords.has(word)) {
      shared += 1;
    }
  }

  return shared / (leftWords.size + rightWords.size - shared);
}

/**
 * Вопрос, которым заканчивается реплика: последнее предложение, если оно
 * вопросительное. `undefined` — реплика заканчивается не вопросом.
 *
 * Границей предложения считаются `.`, `!`, `?` и их восточноазиатские и
 * испанские варианты; достаточно, чтобы отделить вопрос от отклика перед ним.
 */
export function closingQuestion(text: string): string | undefined {
  const trimmed = text.trim();

  if (!/[?？]$/u.test(trimmed)) {
    return undefined;
  }

  const sentences = trimmed.split(/(?<=[.!?。！？…])\s+/u);
  const last = sentences.at(-1)?.trim();

  return last === undefined || last === '' ? undefined : last;
}

/** Похожи ли две реплики настолько, чтобы считаться одной и той же. */
function isSameUtterance(left: string, right: string): boolean {
  return (
    utteranceWords(left).length >= REPEAT_MIN_WORDS &&
    utteranceWords(right).length >= REPEAT_MIN_WORDS &&
    wordSimilarity(left, right) >= REPEAT_SIMILARITY_THRESHOLD
  );
}

/**
 * Повторяет ли реплика одну из предыдущих — целиком или своим финальным вопросом.
 *
 * @param candidate реплика, которую тьютор собирается сказать.
 * @param previous предыдущие реплики тьютора, самые свежие — последними.
 * @returns `true` — ученик это уже слышал.
 */
export function isRepeatedUtterance(candidate: string, previous: readonly string[]): boolean {
  if (previous.some((earlier) => isSameUtterance(candidate, earlier))) {
    return true;
  }

  const question = closingQuestion(candidate);

  if (question === undefined) {
    return false;
  }

  return previous.some((earlier) => {
    const earlierQuestion = closingQuestion(earlier);

    return earlierQuestion !== undefined && isSameUtterance(question, earlierQuestion);
  });
}
