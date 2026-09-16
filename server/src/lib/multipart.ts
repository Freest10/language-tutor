/**
 * Разбор multipart-запросов: пределы и перевод ошибок парсера в ответы API.
 *
 * Пределы разбора нужны обоим multipart-эндпоинтам (материалы и распознавание
 * речи): без них один запрос удерживает в памяти сколько угодно частей, а
 * `fileSize` ограничивает только каждую часть по отдельности. Отдельные части
 * уже не нужны — их поток сливается через `part.file.resume()`, — но сами
 * пределы всё равно обязаны быть.
 */

/** Код ошибки, если он у неё есть. */
function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;

  return typeof code === 'string' ? code : undefined;
}

/** Превышен предел размера одной файловой части. */
export function isFileTooLarge(error: unknown): boolean {
  return codeOf(error) === 'FST_REQ_FILE_TOO_LARGE';
}

/**
 * Разбор прерван пределами числа частей, файлов или полей.
 *
 * `@fastify/multipart` на этих пределах не бросает свою ошибку в цикл перебора,
 * а рвёт поток запроса, и до обработчика доходит `ERR_STREAM_PREMATURE_CLOSE`.
 * Тот же код приходит, когда клиент оборвал загрузку сам. В обоих случаях это
 * отказ на стороне запроса, а не сбой сервера, и отвечать на него 500 неверно.
 */
export function isMultipartLimit(error: unknown): boolean {
  const code = codeOf(error);

  return (
    code === 'FST_PARTS_LIMIT' ||
    code === 'FST_FILES_LIMIT' ||
    code === 'FST_FIELDS_LIMIT' ||
    code === 'ERR_STREAM_PREMATURE_CLOSE'
  );
}
