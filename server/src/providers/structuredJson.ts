/**
 * Строгий JSON от языковой модели: ответ, разобранный Zod-схемой.
 *
 * Этим хелпером пользуются все места, где модель возвращает данные, а не реплику:
 * определение уровня, план урока, проверка ответов ученика. Схема здесь —
 * единственный источник истины: она и подсказывает модели формат (JSON Schema
 * в системной инструкции), и проверяет результат.
 *
 * Надёжность достигается четырьмя приёмами, в порядке применения:
 * 1. `response_format: { type: 'json_schema' }` — сервер модели ограничивает
 *    генерацию грамматикой схемы, и ответ не по схеме становится невозможен.
 *    Так умеют llama.cpp, Ollama, vLLM и OpenAI; именно этот режим и спасает
 *    локальные модели на 8B, которые словесную инструкцию нередко нарушают;
 * 2. лестница режимов вниз: сервер, не знающий `json_schema`, отвечает 4xx —
 *    тогда запрос повторяется со слабым `json_object`, а потом и вовсе без
 *    `response_format`. Возможности сервера не угадываются заранее и не
 *    настраиваются: они выясняются из его же ответа;
 * 3. извлечение JSON из текста — модели любят обрамлять ответ ```-блоком
 *    или предварять пояснением;
 * 4. один ремонтный заход — модели показывают её же ответ и список претензий
 *    Zod и просят прислать исправленный JSON.
 *
 * Если и это не помогло, поднимается `ProviderError` вида `invalid_response`,
 * который маршрут превращает в 502 `upstream_error`.
 *
 * Отдельно распознаётся оборванный ответ (`finish_reason: 'length'`): JSON в нём
 * не дописан не потому, что модель не поняла задачу, а потому, что ответ не
 * поместился в окно контекста. Ремонтный заход тут бесполезен — он делает
 * диалог только длиннее, — поэтому такой отказ поднимается сразу и своим видом.
 */
import { z } from 'zod';

import { formatZodIssues } from '../lib/validate.js';

import { resolveLlmProvider } from './factory.js';
import {
  isProviderError,
  ProviderError,
  type ChatJsonSchema,
  type ChatMessage,
  type ChatRequest,
  type ChatUsage,
  type LlmProvider,
  type ProviderLogger,
} from './types.js';

/**
 * Сколько обращений к модели допустимо суммарно (деградация + ремонт).
 *
 * Худший случай: два шага вниз по лестнице режимов (`json_schema` → `json_object`
 * → без `response_format`), сама генерация и один ремонтный заход.
 */
export const MAX_STRUCTURED_ATTEMPTS = 5;

/** Ремонтных заходов по умолчанию: один. */
export const DEFAULT_REPAIR_ATTEMPTS = 1;

/**
 * Статусы, по которым считаем, что сервер модели не знает запрошенный режим.
 *
 * 404 сюда не входит: у OpenAI-совместимых серверов это «нет такой модели»
 * (или адрес ведёт не туда), и повтор в другом режиме лишь прячет настоящую
 * причину за лишним запросом.
 */
const FORMAT_UNSUPPORTED_STATUSES = new Set([400, 405, 415, 422, 501]);

/**
 * Причины завершения генерации, означающие «ответ обрезан».
 *
 * `length` — общепринятое значение OpenAI-совместимых серверов, `max_tokens`
 * встречается у отдельных сборок.
 */
const TRUNCATED_FINISH_REASONS = new Set(['length', 'max_tokens']);

/** Режимы ответа, от строгого к свободному: следующий пробуется, если сервер не знает текущего. */
export const STRUCTURED_FORMATS = ['json_schema', 'json_object', 'text'] as const;

/** Режим ответа, которым запрошен структурированный JSON. */
export type StructuredFormat = (typeof STRUCTURED_FORMATS)[number];

/** Запрос структурированного ответа. */
export interface StructuredJsonRequest<Schema extends z.ZodType> {
  /** Схема ответа: и инструкция модели, и проверка результата. */
  schema: Schema;
  /** Реплики задачи; инструкция о формате добавляется первой автоматически. */
  messages: ChatMessage[];
  /** Имя структуры для промпта и логов, например `placement_result`. */
  schemaName?: string | undefined;
  /** Словесное уточнение формата, если схемы недостаточно. */
  schemaDescription?: string | undefined;
  /** Температура генерации; по умолчанию — заданная провайдером. */
  temperature?: number | undefined;
  /** Верхняя граница длины ответа в токенах. */
  maxTokens?: number | undefined;
  /** Провайдер; по умолчанию — настроенный переменными окружения. */
  provider?: LlmProvider | undefined;
  logger?: ProviderLogger | undefined;
  signal?: AbortSignal | undefined;
  /** Сколько раз просить модель исправить ответ; `0` — не просить. */
  repairAttempts?: number | undefined;
}

/** Результат структурированного запроса. */
export interface StructuredJsonResult<Value> {
  /** Разобранное схемой значение. */
  data: Value;
  /** Сколько обращений к модели понадобилось. */
  attempts: number;
  /** Последний сырой ответ модели (для лога и отладки промптов). */
  raw: string;
  /** Суммарный расход токенов по всем обращениям; `null` — не сообщён. */
  usage: ChatUsage | null;
  /** Каким режимом `response_format` удалось получить ответ. */
  format: StructuredFormat;
}

/** Итог разбора текста ответа схемой. */
export type StructuredJsonParse<Value> =
  { ok: true; data: Value; json: string } | { ok: false; problem: string };

/** Блок рассуждений reasoning-моделей. */
const THINK_BLOCK_PATTERN = /<think>[\s\S]*?<\/think>/gi;

/** Содержимое первого ```-блока. */
const FENCED_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;

/** Вырезает из подстроки сбалансированный объект или массив с учётом строк. */
function balancedSlice(text: string): string | null {
  const start = firstStructureIndex(text);

  if (start === -1) {
    return null;
  }

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;

      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

/** Позиция первой открывающей скобки объекта или массива. */
function firstStructureIndex(text: string): number {
  const brace = text.indexOf('{');
  const bracket = text.indexOf('[');

  if (brace === -1) {
    return bracket;
  }

  if (bracket === -1) {
    return brace;
  }

  return Math.min(brace, bracket);
}

/**
 * Достаёт JSON из ответа модели: снимает блоки рассуждений и ```-обрамление,
 * затем берёт первый сбалансированный объект или массив. `null` — JSON не найден.
 */
export function extractJsonText(raw: string): string | null {
  const text = raw.replace(THINK_BLOCK_PATTERN, '').trim();

  if (text.length === 0) {
    return null;
  }

  const fenced = FENCED_BLOCK_PATTERN.exec(text)?.[1]?.trim();

  return balancedSlice(fenced !== undefined && fenced.length > 0 ? fenced : text);
}

/** Разбирает ответ модели схемой; при неудаче объясняет, что именно не так. */
export function parseStructuredJson<Schema extends z.ZodType>(
  schema: Schema,
  raw: string,
): StructuredJsonParse<z.output<Schema>> {
  const json = extractJsonText(raw);

  if (json === null) {
    return { ok: false, problem: 'в ответе нет JSON-объекта' };
  }

  let value: unknown;

  try {
    value = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      problem: `JSON не разбирается: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    const issues = formatZodIssues(parsed.error)
      .map((issue) => `${issue.path === '' ? '<корень>' : issue.path}: ${issue.message}`)
      .join('; ');

    return { ok: false, problem: `значение не соответствует схеме (${issues})` };
  }

  return { ok: true, data: parsed.data, json };
}

/** Собирает системную инструкцию: формат ответа и JSON Schema, если она выводима. */
export function buildJsonInstruction<Schema extends z.ZodType>(
  schema: Schema,
  options: { schemaName?: string | undefined; schemaDescription?: string | undefined } = {},
): string {
  const name = options.schemaName ?? 'result';
  const lines = [
    `Ответь ровно одним JSON-значением по схеме "${name}".`,
    'Без markdown, без ```-блоков, без пояснений до или после JSON.',
    'Все строки — на языке, заданном задачей; ключи не переводи и не добавляй своих.',
  ];
  const jsonSchema = toJsonSchema(schema);

  if (jsonSchema !== null) {
    lines.push(`JSON Schema ответа: ${JSON.stringify(jsonSchema)}`);
  }

  if (options.schemaDescription !== undefined && options.schemaDescription.length > 0) {
    lines.push(options.schemaDescription);
  }

  return lines.join('\n');
}

/**
 * JSON Schema по Zod-схеме; `null` — схему нельзя представить (есть преобразования).
 *
 * `io: 'output'` — схема описывает то, что должно получиться после разбора, а не
 * то, что допустимо прислать: поля со значением по умолчанию в результате есть
 * всегда, и модели незачем знать, что их можно опустить.
 *
 * `$schema` снимается: серверу модели этот ключ не нужен, а в промпте он занимает
 * место. Заодно это избавляет от отказов серверов, которые строят по схеме
 * грамматику и на незнакомый ключ отвечают 4xx.
 */
export function toJsonSchema<Schema extends z.ZodType>(
  schema: Schema,
): Record<string, unknown> | null {
  try {
    // Ключ `$schema` отбрасывается намеренно: см. комментарий выше. Префикс `_`
    // — конвенция проекта для осознанно неиспользуемых значений.
    const { $schema: _$schema, ...rest } = z.toJSONSchema(schema, { io: 'output' }) as Record<
      string,
      unknown
    >;

    return rest;
  } catch {
    // Схемы с `transform` в JSON Schema не переводятся — обойдёмся описанием.
    return null;
  }
}

/** Просьба исправить ответ: модель видит свой текст и претензии к нему. */
function repairPrompt(problem: string, instruction: string): string {
  return [
    `Предыдущий ответ не подошёл: ${problem}.`,
    'Пришли исправленный ответ целиком.',
    instruction,
  ].join('\n');
}

/** Не знает ли сервер модели про запрошенный `response_format`. */
function isFormatUnsupported(error: unknown): boolean {
  return (
    isProviderError(error) &&
    error.kind === 'http' &&
    error.status !== undefined &&
    FORMAT_UNSUPPORTED_STATUSES.has(error.status)
  );
}

/** Следующий режим лестницы; `null` — отступать дальше некуда. */
function nextFormat(format: StructuredFormat): StructuredFormat | null {
  return STRUCTURED_FORMATS[STRUCTURED_FORMATS.indexOf(format) + 1] ?? null;
}

/** Поля запроса к модели, задающие режим ответа. */
function formatRequest(
  format: StructuredFormat,
  jsonSchema: ChatJsonSchema | null,
): Pick<ChatRequest, 'jsonMode' | 'jsonSchema'> {
  if (format === 'json_schema' && jsonSchema !== null) {
    return { jsonSchema };
  }

  return { jsonMode: format !== 'text' };
}

/** Складывает расход токенов по нескольким обращениям. */
function addUsage(total: ChatUsage | null, next: ChatUsage | null): ChatUsage | null {
  if (next === null) {
    return total;
  }

  if (total === null) {
    return next;
  }

  return {
    promptTokens: total.promptTokens + next.promptTokens,
    completionTokens: total.completionTokens + next.completionTokens,
    totalTokens: total.totalTokens + next.totalTokens,
  };
}

/**
 * Запрашивает у модели ответ, разобранный Zod-схемой.
 *
 * Бросает `ProviderError` (`invalid_response`), если после ремонтного захода
 * ответ всё ещё не соответствует схеме, и пробрасывает отказы провайдера как есть.
 */
export async function requestStructuredJson<Schema extends z.ZodType>(
  request: StructuredJsonRequest<Schema>,
): Promise<StructuredJsonResult<z.output<Schema>>> {
  const provider = request.provider ?? resolveLlmProvider({ logger: request.logger });
  const instruction = buildJsonInstruction(request.schema, {
    schemaName: request.schemaName,
    schemaDescription: request.schemaDescription,
  });
  const conversation: ChatMessage[] = [
    { role: 'system', content: instruction },
    ...request.messages,
  ];
  const derived = toJsonSchema(request.schema);
  const jsonSchema: ChatJsonSchema | null =
    derived === null ? null : { name: request.schemaName ?? 'result', schema: derived };

  let repairsLeft = request.repairAttempts ?? DEFAULT_REPAIR_ATTEMPTS;
  // Схему, которую не удалось представить в JSON Schema, строгим режимом не
  // попросишь: лестница для неё начинается со следующей ступени.
  let format: StructuredFormat = jsonSchema === null ? 'json_object' : 'json_schema';
  let usage: ChatUsage | null = null;
  let attempts = 0;
  let lastProblem = 'модель не прислала JSON';
  let lastRaw = '';

  while (attempts < MAX_STRUCTURED_ATTEMPTS) {
    attempts += 1;

    let text: string;
    // Оборван ли ответ — свойство одного захода, а не всего запроса: следующий
    // (в другом режиме или после ремонта) отвечает заново.
    let truncated: boolean;

    try {
      const result = await provider.chat({
        messages: conversation,
        ...formatRequest(format, jsonSchema),
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        signal: request.signal,
      });

      usage = addUsage(usage, result.usage);
      text = result.text;
      truncated = result.finishReason !== null && TRUNCATED_FINISH_REASONS.has(result.finishReason);
    } catch (error) {
      const fallback: StructuredFormat | null = isFormatUnsupported(error)
        ? nextFormat(format)
        : null;

      if (fallback !== null) {
        request.logger?.warn(
          {
            target: 'llm',
            status: isProviderError(error) ? error.status : undefined,
            format,
            fallback,
          },
          'провайдер: режим response_format не поддержан, повтор ступенью ниже',
        );
        format = fallback;

        continue;
      }

      throw error;
    }

    lastRaw = text;

    const parsed = parseStructuredJson(request.schema, text);

    if (parsed.ok) {
      return { data: parsed.data, attempts, raw: text, usage, format };
    }

    lastProblem = parsed.problem;

    // Обрезанный ответ чинить нечем: он не поместился в окно контекста, и
    // следующий заход, вместе с историей переписки, не поместится тем более.
    if (truncated) {
      throw new ProviderError(
        'llm',
        'response_truncated',
        'Модель оборвала ответ: он не поместился в окно контекста',
        { attempt: attempts, detail: lastRaw.slice(0, 500) },
      );
    }

    if (repairsLeft <= 0) {
      break;
    }

    repairsLeft -= 1;
    request.logger?.warn(
      { target: 'llm', attempt: attempts, problem: lastProblem },
      'провайдер: ответ модели не прошёл схему, просим исправить',
    );
    conversation.push(
      { role: 'assistant', content: text },
      { role: 'user', content: repairPrompt(lastProblem, instruction) },
    );
  }

  throw new ProviderError(
    'llm',
    'invalid_response',
    `Модель вернула ответ не по схеме: ${lastProblem}`,
    { attempt: attempts, detail: lastRaw.slice(0, 500) },
  );
}
