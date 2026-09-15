/**
 * Строгий JSON от языковой модели: ответ, разобранный Zod-схемой.
 *
 * Этим хелпером пользуются все места, где модель возвращает данные, а не реплику:
 * определение уровня, план урока, проверка ответов ученика. Схема здесь —
 * единственный источник истины: она и подсказывает модели формат (JSON Schema
 * в системной инструкции), и проверяет результат.
 *
 * Надёжность достигается тремя приёмами, в порядке применения:
 * 1. `response_format: { type: 'json_object' }` — если сервер модели его не знает
 *    и отвечает 4xx, запрос молча повторяется без этого поля;
 * 2. извлечение JSON из текста — модели любят обрамлять ответ ```-блоком
 *    или предварять пояснением;
 * 3. один ремонтный заход — модели показывают её же ответ и список претензий
 *    Zod и просят прислать исправленный JSON.
 *
 * Если и это не помогло, поднимается `ProviderError` вида `invalid_response`,
 * который маршрут превращает в 502 `upstream_error`.
 */
import { z } from 'zod';

import { formatZodIssues } from '../lib/validate.js';

import { resolveLlmProvider } from './factory.js';
import {
  isProviderError,
  ProviderError,
  type ChatMessage,
  type ChatUsage,
  type LlmProvider,
  type ProviderLogger,
} from './types.js';

/** Сколько обращений к модели допустимо суммарно (деградация + ремонт). */
export const MAX_STRUCTURED_ATTEMPTS = 4;

/** Ремонтных заходов по умолчанию: один. */
export const DEFAULT_REPAIR_ATTEMPTS = 1;

/** Статусы, по которым считаем, что сервер модели не знает `response_format`. */
const JSON_MODE_UNSUPPORTED_STATUSES = new Set([400, 404, 405, 415, 422, 501]);

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
  /** Удалось ли воспользоваться `response_format`. */
  jsonModeUsed: boolean;
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
    lines.push(`JSON Schema ответа: ${jsonSchema}`);
  }

  if (options.schemaDescription !== undefined && options.schemaDescription.length > 0) {
    lines.push(options.schemaDescription);
  }

  return lines.join('\n');
}

/** JSON Schema по Zod-схеме; `null` — схему нельзя представить (есть преобразования). */
function toJsonSchema<Schema extends z.ZodType>(schema: Schema): string | null {
  try {
    return JSON.stringify(z.toJSONSchema(schema, { io: 'output' }));
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

/** Не знает ли сервер модели про `response_format`. */
function isJsonModeUnsupported(error: unknown): boolean {
  return (
    isProviderError(error) &&
    error.kind === 'http' &&
    error.status !== undefined &&
    JSON_MODE_UNSUPPORTED_STATUSES.has(error.status)
  );
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

  let repairsLeft = request.repairAttempts ?? DEFAULT_REPAIR_ATTEMPTS;
  let jsonMode = true;
  let usage: ChatUsage | null = null;
  let attempts = 0;
  let lastProblem = 'модель не прислала JSON';
  let lastRaw = '';

  while (attempts < MAX_STRUCTURED_ATTEMPTS) {
    attempts += 1;

    let text: string;

    try {
      const result = await provider.chat({
        messages: conversation,
        jsonMode,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        signal: request.signal,
      });

      usage = addUsage(usage, result.usage);
      text = result.text;
    } catch (error) {
      if (jsonMode && isJsonModeUnsupported(error)) {
        jsonMode = false;
        request.logger?.warn(
          { target: 'llm', status: isProviderError(error) ? error.status : undefined },
          'провайдер: response_format не поддержан, повтор без него',
        );

        continue;
      }

      throw error;
    }

    lastRaw = text;

    const parsed = parseStructuredJson(request.schema, text);

    if (parsed.ok) {
      return { data: parsed.data, attempts, raw: text, usage, jsonModeUsed: jsonMode };
    }

    lastProblem = parsed.problem;

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
