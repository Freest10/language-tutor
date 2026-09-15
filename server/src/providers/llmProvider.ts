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
    const body = {
      model: request.model ?? this.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream: false,
      ...(temperature === undefined ? {} : { temperature }),
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      ...(request.jsonMode === true ? { response_format: { type: 'json_object' } } : {}),
    };

    const payload = await this.client.postJson(CHAT_COMPLETIONS_PATH, body, {
      signal: request.signal,
    });
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
