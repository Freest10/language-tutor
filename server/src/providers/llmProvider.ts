/**
 * Языковая модель: `POST {LLM_BASE_URL}/chat/completions`.
 *
 * Провайдер сознательно тонкий — он только отправляет диалог и разбирает ответ.
 * Сборкой промптов занимаются фичевые пакеты, а строгий JSON по схеме —
 * `structuredJson.ts` поверх этого же провайдера.
 *
 * Ответ модели очищается от блоков рассуждений (`<think>…</think>`): локальные
 * reasoning-модели вроде qwen3 выводят их прямо в `content`, и без очистки они
 * попали бы ученику в реплику.
 */
import { z } from 'zod';

import { OpenAiCompatibleClient, type RetryPolicy } from './openaiCompatible.js';
import {
  isProviderError,
  ProviderError,
  type ChatRequest,
  type ChatResult,
  type ChatUsage,
  type LlmProvider,
  type ProviderLogger,
} from './types.js';

/** Путь OpenAI-совместимого эндпоинта чата. */
export const CHAT_COMPLETIONS_PATH = '/chat/completions';

/** Параметры провайдера языковой модели. */
export interface LlmProviderOptions {
  /** Базовый URL OpenAI-совместимого API. */
  baseUrl: string;
  /** Имя модели по умолчанию. */
  model: string;
  apiKey?: string | undefined;
  /** Таймаут одного запроса, мс. */
  timeoutMs?: number | undefined;
  /** Температура генерации по умолчанию. */
  temperature?: number | undefined;
  retry?: Partial<RetryPolicy> | undefined;
  logger?: ProviderLogger | undefined;
}

/** Ответ OpenAI-совместимого `/chat/completions`; лишние поля игнорируются. */
const chatCompletionSchema = z.object({
  model: z.string().nullish(),
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.string().nullish(),
            /** Некоторые сборки выносят рассуждения в отдельное поле. */
            reasoning_content: z.string().nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
      total_tokens: z.number().nullish(),
    })
    .nullish(),
});

/** Блок рассуждений reasoning-моделей: в текст ответа он не входит. */
const THINK_BLOCK_PATTERN = /<think>[\s\S]*?<\/think>/gi;

/** Убирает блоки рассуждений и обрамляющие пробелы. */
export function stripReasoning(text: string): string {
  return text.replace(THINK_BLOCK_PATTERN, '').trim();
}

/**
 * Значение `response_format` запроса.
 *
 * Строгий режим (`json_schema`) сильнее свободного (`json_object`): сервер модели
 * ограничивает генерацию грамматикой схемы, и ответ не по схеме становится
 * невозможен. Выбирает режим вызывающая сторона — она же умеет отступить назад,
 * если сервер такого режима не знает.
 */
function responseFormat(request: ChatRequest): Record<string, unknown> | undefined {
  if (request.jsonSchema !== undefined) {
    return {
      type: 'json_schema',
      json_schema: { name: request.jsonSchema.name, schema: request.jsonSchema.schema },
    };
  }

  return request.jsonMode === true ? { type: 'json_object' } : undefined;
}

/**
 * Отказ 404 — это «нет такой модели», а не обычная ошибка сервера.
 *
 * Ollama отвечает так на `model 'qwen3:8b' not found`, и отличить этот случай
 * важно: сообщение «модель ответила ошибкой» отправляет пользователя искать
 * поломку в модели, хотя чинить надо строку `LLM_MODEL` — модель просто не
 * установлена. Тот же статус отдаёт неверный `LLM_BASE_URL`, поэтому названы обе
 * переменные. Адрес в текст не подставляется: в нём бывает ключ доступа.
 */
function describeNotFound(error: unknown, model: string): unknown {
  if (!isProviderError(error) || error.kind !== 'http' || error.status !== 404) {
    return error;
  }

  return new ProviderError(
    'llm',
    'model_not_found',
    `Модель «${model}» не найдена у провайдера: проверьте LLM_MODEL и LLM_BASE_URL`,
    {
      status: error.status,
      detail: error.detail,
      attempt: error.attempt,
      model,
      cause: error,
    },
  );
}

/** Приводит расход токенов к типу приложения; `null` — провайдер его не сообщил. */
function toUsage(usage: z.infer<typeof chatCompletionSchema>['usage']): ChatUsage | null {
  if (usage === null || usage === undefined) {
    return null;
  }

  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;

  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
  };
}

/** Провайдер чата поверх OpenAI-совместимого HTTP API. */
class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly model: string;

  private readonly client: OpenAiCompatibleClient;
  private readonly temperature: number | undefined;

  constructor(options: LlmProviderOptions) {
    this.model = options.model;
    this.temperature = options.temperature;
    this.client = new OpenAiCompatibleClient({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
      retry: options.retry,
      target: 'llm',
      logger: options.logger,
    });
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    if (request.messages.length === 0) {
      throw new ProviderError('llm', 'invalid_response', 'Запрос к модели без единой реплики');
    }

    const temperature = request.temperature ?? this.temperature;
    const format = responseFormat(request);
    const body = {
      model: request.model ?? this.model,
      // `content` уходит как есть: строка для обычного диалога и список кусков
      // (`text` + `image_url`) для страницы скана — форма та же, что у OpenAI.
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream: false,
      ...(temperature === undefined ? {} : { temperature }),
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      ...(format === undefined ? {} : { response_format: format }),
    };

    let payload: unknown;

    try {
      payload = await this.client.postJson(CHAT_COMPLETIONS_PATH, body, {
        signal: request.signal,
      });
    } catch (error) {
      throw describeNotFound(error, body.model);
    }

    const parsed = chatCompletionSchema.safeParse(payload);

    if (!parsed.success) {
      throw new ProviderError(
        'llm',
        'invalid_response',
        'Ответ модели не соответствует формату chat/completions',
        { cause: parsed.error },
      );
    }

    const choice = parsed.data.choices[0];

    return {
      text: stripReasoning(choice?.message?.content ?? ''),
      usage: toUsage(parsed.data.usage),
      model: parsed.data.model ?? body.model,
      finishReason: choice?.finish_reason ?? null,
    };
  }
}

/** Собирает провайдер языковой модели с явно заданной конфигурацией. */
export function createLlmProvider(options: LlmProviderOptions): LlmProvider {
  return new OpenAiCompatibleLlmProvider(options);
}
