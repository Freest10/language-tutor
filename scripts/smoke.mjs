#!/usr/bin/env node
/* global fetch, FormData, Blob, AbortSignal, console, process */
/**
 * Дымовая проверка живого стека: `npm run smoke`.
 *
 * Скрипт ходит по API уже запущенного приложения и по адресу языковой модели
 * из `.env`, прогоняя сценарий целиком: здоровье сервера, конфигурация, ответ
 * модели, голосовые эндпоинты, профиль, материал, план урока, прогресс.
 * В отличие от `GET /api/config`, который сообщает конфигурацию, здесь каждый
 * провайдер действительно опрашивается.
 *
 * Правила вывода:
 * - проверки не прекращаются на первом отказе: падение одного шага не мешает
 *   узнать состояние остальных, в конце печатается сводка;
 * - у каждого провала есть строка «что делать»: цель скрипта — не сообщить
 *   о поломке, а объяснить, чем её чинить;
 * - код возврата 0 — провалов нет, 1 — есть, 2 — скрипт запущен неверно.
 *
 * Шаги, которым нужен сервер, пропускаются, если сервер не ответил: их отказ
 * ничего бы не добавил к первому же провалу.
 *
 * Зависимостей нет и не появится: только встроенный `fetch` и модули `node:*`.
 * Запускать можно без сборки — скрипт ничего не импортирует из пакетов репозитория.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** Корень монорепо: скрипт лежит в `<корень>/scripts`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Адрес запущенного приложения по умолчанию (`PORT` из `.env.example`). */
const DEFAULT_BASE_URL = 'http://localhost:8787';

/** Значения по умолчанию совпадают с `server/src/config/env.ts`. */
const DEFAULT_LLM_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_LLM_MODEL = 'qwen3:8b';

/** Таймаут быстрых запросов к приложению, мс. */
const QUICK_TIMEOUT_MS = 15_000;

/** Таймаут голосовых запросов, мс: распознавание на CPU не мгновенное. */
const DEFAULT_VOICE_TIMEOUT_MS = 90_000;

/** Таймаут короткого запроса к модели, мс: первый запрос грузит веса в память. */
const DEFAULT_LLM_TIMEOUT_MS = 120_000;

/** Таймаут генерации плана урока, мс: на локальной модели это десятки секунд. */
const DEFAULT_PLAN_TIMEOUT_MS = 300_000;

/** Длительность урока в проверке, минуты: меньше — меньше работы модели. */
const SMOKE_LESSON_MINUTES = 15;

/** Границы числа шагов плана из `prompts/lessonPlan.ts`. */
const LESSON_PLAN_MIN_STEPS = 4;
const LESSON_PLAN_MAX_STEPS = 7;

/** Текст тестового материала: короткий, но достаточный для разбиения на фрагменты. */
const MATERIAL_TEXT = [
  'Smoke test material for the language tutor.',
  'A short text is enough to check that uploading, text extraction and chunking work.',
  'The tutor should be able to build a small speaking lesson around it.',
  'Yesterday I went to the market and bought bread, cheese and two bottles of water.',
  'The seller asked me where I was from, and I answered that I had moved here last year.',
  'We talked about the weather, the prices and the best time to come for fresh vegetables.',
].join(' ');

/** Оформление вывода: цвет включается только для терминала. */
const USE_COLOR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

/** ANSI-коды оформления. */
const COLORS = {
  ok: '[32m',
  fail: '[31m',
  skip: '[33m',
  dim: '[2m',
  bold: '[1m',
  reset: '[0m',
};

/** Подписи статусов шага. */
const STATUS_LABELS = { ok: 'ok', fail: 'ПРОВАЛ', skip: 'пропуск' };

/** Отказ проверки: сообщение и подсказки «что делать». */
class SmokeError extends Error {
  /**
   * @param {string} message
   * @param {string[]} [hints]
   */
  constructor(message, hints = []) {
    super(message);
    this.name = 'SmokeError';
    this.hints = hints;
  }
}

/** Красит текст, если вывод идёт в терминал. */
function paint(kind, text) {
  return USE_COLOR ? `${COLORS[kind]}${text}${COLORS.reset}` : text;
}

/** Печатает строку отчёта. */
function print(text = '') {
  console.log(text);
}

/** Длительность в человекочитаемом виде. */
function formatMs(ms) {
  if (ms < 1000) {
    return `${String(Math.round(ms))} мс`;
  }

  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} с` : `${(ms / 60_000).toFixed(1)} мин`;
}

/** Число с существительным в нужном падеже: 1 провал, 2 провала, 5 провалов. */
function plural(count, [one, few, many]) {
  const mod100 = count % 100;
  const mod10 = count % 10;

  if (mod100 >= 11 && mod100 <= 14) {
    return `${String(count)} ${many}`;
  }

  if (mod10 === 1) {
    return `${String(count)} ${one}`;
  }

  return `${String(count)} ${mod10 >= 2 && mod10 <= 4 ? few : many}`;
}

/** Размер в человекочитаемом виде. */
function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${String(bytes)} Б`;
  }

  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} КиБ`
    : `${(bytes / (1024 * 1024)).toFixed(1)} МиБ`;
}

/** Обрезает текст до предела, добавляя многоточие. */
function short(text, limit = 160) {
  const value = String(text).replace(/\s+/g, ' ').trim();

  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** Непустая строка окружения либо запасное значение. */
function envValue(name, fallback) {
  const value = process.env[name];

  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

/** Положительное число из окружения либо запасное значение. */
function envNumber(name, fallback) {
  const value = Number(envValue(name, ''));

  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Убирает завершающие слэши: `http://host/v1/` → `http://host/v1`. */
function trimSlash(url) {
  return url.replace(/\/+$/, '');
}

/** Разбирает аргументы командной строки; при ошибке печатает справку и выходит. */
function readOptions() {
  try {
    const { values } = parseArgs({
      options: {
        url: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    });

    return values;
  } catch (error) {
    print(`Не разобраны аргументы: ${error.message}`);
    printUsage();
    process.exit(2);
  }
}

/** Справка по запуску. */
function printUsage() {
  print('');
  print('Использование: npm run smoke [-- --url http://localhost:8787]');
  print('');
  print('Переменные окружения:');
  print('  SMOKE_BASE_URL         адрес приложения (по умолчанию http://localhost:8787)');
  print('  SMOKE_LLM_TIMEOUT_MS   таймаут короткого запроса к модели (120000)');
  print('  SMOKE_PLAN_TIMEOUT_MS  таймаут генерации плана урока (300000)');
  print('  SMOKE_VOICE_TIMEOUT_MS таймаут голосовых запросов (90000)');
  print('');
  print('Адрес и модель LLM берутся из `.env` репозитория (LLM_BASE_URL, LLM_MODEL).');
}

/** Подхватывает `.env` репозитория; заданные переменные окружения имеют приоритет. */
function loadEnvFile() {
  const envPath = join(ROOT, '.env');

  if (!existsSync(envPath)) {
    return null;
  }

  try {
    process.loadEnvFile(envPath);

    return envPath;
  } catch {
    // Нечитаемый `.env` не повод отменять проверку: возьмём значения по умолчанию.
    return null;
  }
}

/** Разбирает тело ответа: текст всегда, JSON — если разбирается. */
async function readPayload(response) {
  let text;

  try {
    text = await response.text();
  } catch {
    return { text: '', json: undefined };
  }

  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: undefined };
  }
}

/** Объясняет, почему запрос не дошёл до сервера. */
function describeFetchFailure(error, url, timeoutMs) {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `нет ответа за ${formatMs(timeoutMs)} (${url})`;
  }

  const code = error?.cause?.code ?? error?.code;

  if (code === 'ECONNREFUSED') {
    return `соединение отклонено: по адресу ${url} никто не слушает`;
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `хост не найден: ${url}`;
  }

  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return `сертификат не принят: ${url} (${String(code)})`;
  }

  return `запрос не удался: ${url} — ${String(error?.message ?? error)}`;
}

/** Объясняет ответ с ошибкой: конверт `{ error: { code, message, details } }` или сырой текст. */
function describeHttpFailure(result) {
  const error = result.json?.error;

  if (error !== null && typeof error === 'object') {
    const reason = error.details?.reason;
    const suffix = typeof reason === 'string' ? ` (reason: ${reason})` : '';

    return `HTTP ${String(result.status)}, код «${String(error.code)}»: ${String(error.message)}${suffix}`;
  }

  return `HTTP ${String(result.status)}: ${short(result.text) || 'пустой ответ'}`;
}

/** Код ошибки из конверта приложения, если он есть. */
function errorCode(result) {
  const code = result.json?.error?.code;

  return typeof code === 'string' ? code : null;
}

/**
 * HTTP-запрос с таймаутом. Бросает `SmokeError`, если ответ не получен вовсе;
 * ответ с кодом 4xx/5xx возвращается как есть — его разбирает сама проверка.
 */
async function request(url, options = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs = QUICK_TIMEOUT_MS, hints = [] } = options;
  let response;

  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new SmokeError(describeFetchFailure(error, url, timeoutMs), hints);
  }

  const payload = await readPayload(response);

  return { status: response.status, ok: response.ok, ...payload };
}

/** Тот же запрос, но ответ не 2xx — это сразу отказ проверки. */
async function requestOk(url, options = {}) {
  const result = await request(url, options);

  if (!result.ok) {
    throw new SmokeError(describeHttpFailure(result), options.hints ?? []);
  }

  return result;
}

/** JSON-запрос к приложению. */
function postJson(url, body, options = {}) {
  return requestOk(url, {
    ...options,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Короткая WAV-запись с тоном: нужна, чтобы проверить распознавание, не записывая
 * ничего с микрофона. Тон, а не тишина, — чтобы у распознавателя был сигнал.
 */
function toneWav({ seconds = 1, sampleRate = 16_000, frequency = 220 } = {}) {
  const samples = Math.round(seconds * sampleRate);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); // длина блока fmt
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // моно
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // байт в секунду
  view.setUint16(32, 2, true); // выравнивание блока
  view.setUint16(34, 16, true); // бит на отсчёт
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);

  for (let index = 0; index < samples; index += 1) {
    // Плавное затухание к краям: щелчки на границах записи распознавателю не нужны.
    const fade = Math.sin((Math.PI * index) / samples);
    const value = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * fade * 0.3;

    view.setInt16(44 + index * 2, Math.round(value * 32_767), true);
  }

  return bytes;
}

/** Длина двоичных данных, закодированных в base64. */
function base64Bytes(value) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;

  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

/** Подсказки, когда не отвечает само приложение. */
function serverHints(baseUrl) {
  return [
    'запустите приложение: `npm run dev` (или только сервер: `npm run dev:server`);',
    `проверьте адрес: сейчас проверяется ${baseUrl}, другой задаётся \`--url\` или SMOKE_BASE_URL;`,
    'если сервер запущен, посмотрите его вывод: ошибка конфигурации печатается при старте.',
  ];
}

/** Подсказки, когда не отвечает языковая модель. */
function llmHints(llm) {
  return [
    'поднимите модель: `ollama serve` + `ollama pull ' +
      llm.model +
      '` (или `docker compose --profile ollama up -d`);',
    `проверьте LLM_BASE_URL в .env: сейчас ${llm.baseUrl};`,
    'облачный провайдер вместо локального — пресет 3 в .env.example, разбор — docs/providers.md.',
  ];
}

/** Подсказки для отказа голосового эндпоинта. */
function voiceHints(kind, result) {
  const upper = kind.toUpperCase();
  const code = errorCode(result);

  if (code === 'not_configured') {
    return [
      `заполните ${upper}_BASE_URL и ${upper}_MODEL в .env либо верните ${upper}_PROVIDER=browser;`,
      'готовые наборы переменных — пресеты в .env.example.',
    ];
  }

  return [
    `поднимите сервис: \`docker compose --profile ${kind} up -d\`;`,
    `проверьте ${upper}_BASE_URL и ${upper}_MODEL в .env — адрес должен оканчиваться на /v1;`,
    'подробности — docs/providers.md.',
  ];
}

/** Проверка: живость сервера и доступность базы. */
async function checkHealth(state) {
  const result = await requestOk(`${state.baseUrl}/api/health`, {
    hints: serverHints(state.baseUrl),
  });
  const payload = result.json;

  if (payload?.status !== 'ok' || payload.db !== 'ok') {
    throw new SmokeError(
      `сервер ответил неожиданным телом: ${short(result.text)}`,
      serverHints(state.baseUrl),
    );
  }

  state.serverUp = true;

  return { details: [`база: ${String(payload.db)}, версия сервера: ${String(payload.version)}`] };
}

/** Проверка: конфигурация провайдеров, какой она видится серверу. */
async function checkConfig(state) {
  const result = await requestOk(`${state.baseUrl}/api/config`, {
    hints: serverHints(state.baseUrl),
  });
  const config = result.json;

  if (config?.llm === undefined || config.stt === undefined || config.tts === undefined) {
    throw new SmokeError(`в ответе нет возможностей провайдеров: ${short(result.text)}`);
  }

  state.config = config;

  /** Строка вида «openai · настроен · модель kokoro» либо с причиной отказа. */
  const describe = (capability) => {
    const parts = [];

    if (typeof capability.provider === 'string') {
      parts.push(capability.provider);
    }

    parts.push(capability.available === true ? 'настроен' : 'не настроен');

    if (typeof capability.model === 'string') {
      parts.push(`модель ${capability.model}`);
    }

    if (typeof capability.reason === 'string') {
      parts.push(capability.reason);
    }

    return parts.join(' · ');
  };

  return {
    details: [
      `LLM: ${describe(config.llm)}`,
      `STT: ${describe(config.stt)}`,
      `TTS: ${describe(config.tts)}`,
      `языков в интерфейсе: ${String(config.supportedLanguages?.length ?? 0)}, ` +
        `материал до ${formatBytes(Number(config.limits?.maxMaterialUploadBytes ?? 0))}`,
    ],
  };
}

/** Проверка: языковая модель действительно отвечает на `/chat/completions`. */
async function checkLlm(state) {
  const { llm } = state;
  const headers = { 'content-type': 'application/json' };

  if (llm.apiKey !== undefined) {
    headers.authorization = `Bearer ${llm.apiKey}`;
  }

  const result = await request(`${trimSlash(llm.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: llm.model,
      messages: [{ role: 'user', content: 'Reply with one word: ok' }],
      stream: false,
      temperature: 0,
      max_tokens: 256,
    }),
    timeoutMs: state.timeouts.llm,
    hints: llmHints(llm),
  });

  if (!result.ok) {
    const hints = llmHints(llm);

    if (result.status === 404) {
      hints.unshift(
        `модель «${llm.model}» серверу неизвестна: скачайте её (\`ollama pull ${llm.model}\`) или поправьте LLM_MODEL;`,
      );
    }

    if (result.status === 401 || result.status === 403) {
      hints.unshift('провайдер требует ключ: заполните LLM_API_KEY в .env;');
    }

    throw new SmokeError(describeHttpFailure(result), hints);
  }

  const message = result.json?.choices?.[0]?.message;

  if (message === undefined) {
    throw new SmokeError(
      `ответ не похож на chat/completions: ${short(result.text)}`,
      llmHints(llm),
    );
  }

  const text = String(message.content ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  const details = [`адрес: ${trimSlash(llm.baseUrl)}/chat/completions`];

  details.push(
    text === ''
      ? 'модель ответила пустым текстом (весь ответ ушёл в рассуждения) — эндпоинт живой'
      : `ответ модели: «${short(text, 60)}»`,
  );
  details.push(`модель в ответе: ${String(result.json?.model ?? llm.model)}`);

  return { details };
}

/** Проверка: серверное распознавание речи. */
async function checkStt(state) {
  const capability = state.config?.stt;

  if (capability?.provider === 'browser') {
    return {
      skipped:
        'STT_PROVIDER=browser — распознаёт браузер, серверный эндпоинт отключён. ' +
        'Это работает в Chromium-браузерах; в Firefox распознавания нет — ему нужен серверный STT.',
    };
  }

  const form = new FormData();

  form.append('audio', new Blob([toneWav()], { type: 'audio/wav' }), 'smoke.wav');
  form.append('language', 'en');

  const result = await request(`${state.baseUrl}/api/voice/stt`, {
    method: 'POST',
    body: form,
    timeoutMs: state.timeouts.voice,
    hints: voiceHints('stt', { json: undefined }),
  });

  if (!result.ok) {
    throw new SmokeError(describeHttpFailure(result), voiceHints('stt', result));
  }

  const text = String(result.json?.text ?? '');

  return {
    details: [
      `провайдер ответил, модель: ${String(result.json?.model ?? capability?.model ?? 'не указана')}`,
      text === ''
        ? 'расшифровка пустая — в тестовой записи нет речи, это нормально'
        : `расшифровка тона: «${short(text, 60)}»`,
    ],
  };
}

/** Проверка: серверный синтез речи. */
async function checkTts(state) {
  const capability = state.config?.tts;

  if (capability?.provider === 'browser') {
    return {
      skipped:
        'TTS_PROVIDER=browser — озвучивает браузер голосами системы, серверный эндпоинт отключён.',
    };
  }

  const result = await request(`${state.baseUrl}/api/voice/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Smoke test.', speed: 1 }),
    timeoutMs: state.timeouts.voice,
    hints: voiceHints('tts', { json: undefined }),
  });

  if (!result.ok) {
    throw new SmokeError(describeHttpFailure(result), voiceHints('tts', result));
  }

  const audio = String(result.json?.audioBase64 ?? '');

  if (audio === '') {
    throw new SmokeError('провайдер вернул ответ без аудио', voiceHints('tts', result));
  }

  return {
    details: [
      `аудио: ${formatBytes(base64Bytes(audio))}, тип ${String(result.json?.contentType ?? '—')}`,
      `голос: ${String(result.json?.voice ?? 'по умолчанию')}, модель: ${String(result.json?.model ?? capability?.model ?? '—')}`,
    ],
  };
}

/** Проверка: чтение профиля ученика. */
async function checkProfileRead(state) {
  const result = await requestOk(`${state.baseUrl}/api/profile`, {
    hints: serverHints(state.baseUrl),
  });
  const profile = result.json;

  if (typeof profile?.level !== 'string') {
    throw new SmokeError(`в ответе нет профиля: ${short(result.text)}`);
  }

  state.profile = profile;

  return {
    details: [
      `уровень ${String(profile.level)}, изучается ${String(profile.learningLanguage)}, ` +
        `объяснения на ${String(profile.explanationLanguage)}`,
      `дневная норма: ${String(profile.dailyMinutes)} мин, целей: ${String(profile.goals?.length ?? 0)}, ` +
        `интересов: ${String(profile.interests?.length ?? 0)}`,
    ],
  };
}

/** Проверка: запись профиля. Пишется то же значение — данные не меняются. */
async function checkProfileWrite(state) {
  if (state.profile === undefined) {
    return { skipped: 'профиль не прочитан на предыдущем шаге' };
  }

  const dailyMinutes = state.profile.dailyMinutes;
  const result = await requestOk(`${state.baseUrl}/api/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dailyMinutes }),
    hints: serverHints(state.baseUrl),
  });

  if (result.json?.dailyMinutes !== dailyMinutes) {
    throw new SmokeError(
      `после записи dailyMinutes=${String(dailyMinutes)} сервер вернул ${String(result.json?.dailyMinutes)}`,
    );
  }

  return {
    details: [
      `PUT /api/profile принят, dailyMinutes=${String(dailyMinutes)} перезаписан тем же значением`,
    ],
  };
}

/** Проверка: материал из текста создаётся, разбирается и читается обратно. */
async function checkMaterial(state) {
  const created = await postJson(
    `${state.baseUrl}/api/materials`,
    { title: `smoke ${new Date().toISOString()}`, text: MATERIAL_TEXT },
    { hints: serverHints(state.baseUrl) },
  );
  const material = created.json;

  if (typeof material?.id !== 'string') {
    throw new SmokeError(`сервер не вернул материал: ${short(created.text)}`);
  }

  state.materialId = material.id;

  if (material.status !== 'ready') {
    throw new SmokeError(
      `материал создан со статусом «${String(material.status)}»: ${String(material.statusMessage ?? 'без пояснения')}`,
      ['статусы материалов и разбор форматов — server/src/services/materialService.ts.'],
    );
  }

  const fetched = await requestOk(`${state.baseUrl}/api/materials/${material.id}`, {
    hints: serverHints(state.baseUrl),
  });
  const chunks = fetched.json?.chunks?.items;

  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new SmokeError('материал сохранён, но фрагментов текста в нём нет');
  }

  return {
    details: [
      `материал ${material.id} создан, статус ${String(material.status)}`,
      `фрагментов: ${String(material.chunkCount ?? chunks.length)}, ` +
        `символов: ${String(material.charCount ?? MATERIAL_TEXT.length)}`,
    ],
  };
}

/** Проверка: генерация плана урока — самый долгий шаг, вся цепочка целиком. */
async function checkLesson(state) {
  const body = {
    topic: 'smoke test: short speaking lesson',
    durationMinutes: SMOKE_LESSON_MINUTES,
  };

  if (state.materialId !== undefined) {
    body.materialIds = [state.materialId];
  }

  const hints = [
    'сначала посмотрите на шаг «Короткий запрос к модели»: без живой LLM план не построить;',
    'если модель отвечает, но план не приходит — возьмите модель побольше (от 8B) ' +
      'и уменьшите LLM_TEMPERATURE: план требует строгого JSON;',
    `если модель просто не успевает — поднимите LLM_TIMEOUT_MS в .env и SMOKE_PLAN_TIMEOUT_MS (сейчас ${formatMs(state.timeouts.plan)}).`,
  ];
  const result = await request(`${state.baseUrl}/api/lessons`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: state.timeouts.plan,
    hints,
  });

  if (!result.ok) {
    throw new SmokeError(describeHttpFailure(result), hints);
  }

  const lesson = result.json;
  const plan = Array.isArray(lesson?.plan) ? lesson.plan : [];

  if (typeof lesson?.id !== 'string' || plan.length === 0) {
    throw new SmokeError(`сервер вернул урок без плана: ${short(result.text)}`, hints);
  }

  state.lessonId = lesson.id;

  if (plan.length < LESSON_PLAN_MIN_STEPS || plan.length > LESSON_PLAN_MAX_STEPS) {
    throw new SmokeError(
      `в плане ${String(plan.length)} шагов, ожидалось от ${String(LESSON_PLAN_MIN_STEPS)} до ${String(LESSON_PLAN_MAX_STEPS)}`,
      hints,
    );
  }

  await requestOk(`${state.baseUrl}/api/lessons/${lesson.id}`, {
    hints: serverHints(state.baseUrl),
  });

  const minutes = plan.reduce((total, step) => total + Number(step.estimatedMinutes ?? 0), 0);

  return {
    details: [
      `урок «${short(String(lesson.title), 60)}» (${lesson.id}) создан и читается обратно`,
      `шагов: ${String(plan.length)} — ${plan.map((step) => String(step.type)).join(', ')}`,
      `минут в плане: ${String(minutes)} при заказанных ${String(SMOKE_LESSON_MINUTES)}`,
    ],
  };
}

/** Проверка: сводка прогресса. */
async function checkProgress(state) {
  const result = await requestOk(`${state.baseUrl}/api/progress/summary`, {
    hints: serverHints(state.baseUrl),
  });
  const summary = result.json;

  if (typeof summary?.level !== 'string') {
    throw new SmokeError(`в ответе нет сводки: ${short(result.text)}`);
  }

  return {
    details: [
      `уровень ${String(summary.level)}, уроков завершено: ${String(summary.lessonsCompleted)}, ` +
        `в работе: ${String(summary.lessonsInProgress)}`,
      `слов в словаре: ${String(summary.vocabulary?.total ?? 0)}, ` +
        `серия занятий: ${String(summary.streakDays)} дн.`,
    ],
  };
}

/** Список шагов проверки в порядке выполнения. */
const STEPS = [
  {
    title: 'Живость сервера',
    target: 'GET /api/health',
    run: checkHealth,
  },
  {
    title: 'Конфигурация провайдеров',
    target: 'GET /api/config',
    note: 'сообщает настройки, а не живую доступность — её проверяют шаги ниже',
    needsServer: true,
    run: checkConfig,
  },
  {
    title: 'Короткий запрос к модели',
    target: 'POST {LLM_BASE_URL}/chat/completions',
    note: 'первый запрос грузит веса в память — это может занять минуту',
    run: checkLlm,
  },
  {
    title: 'Распознавание речи',
    target: 'POST /api/voice/stt',
    needsServer: true,
    run: checkStt,
  },
  {
    title: 'Синтез речи',
    target: 'POST /api/voice/tts',
    needsServer: true,
    run: checkTts,
  },
  {
    title: 'Чтение профиля',
    target: 'GET /api/profile',
    needsServer: true,
    run: checkProfileRead,
  },
  {
    title: 'Запись профиля',
    target: 'PUT /api/profile',
    needsServer: true,
    run: checkProfileWrite,
  },
  {
    title: 'Материал из текста',
    target: 'POST /api/materials, GET /api/materials/:id',
    needsServer: true,
    run: checkMaterial,
  },
  {
    title: 'Генерация плана урока',
    target: 'POST /api/lessons, GET /api/lessons/:id',
    note: 'на локальной модели это десятки секунд — ждём',
    needsServer: true,
    run: checkLesson,
  },
  {
    title: 'Сводка прогресса',
    target: 'GET /api/progress/summary',
    needsServer: true,
    run: checkProgress,
  },
];

/** Печатает шапку отчёта и предупреждение о записи в базу. */
function printHeader(state) {
  print(paint('bold', 'language-tutor · проверка живого стека'));
  print(`  приложение: ${state.baseUrl}`);
  print(`  модель:     ${trimSlash(state.llm.baseUrl)} · ${state.llm.model}`);
  print(
    `  окружение:  ${state.envPath === null ? '.env не найден, взяты значения по умолчанию' : state.envPath}`,
  );
  print('');
  print(paint('skip', '  Внимание: проверка пишет в базу того сервера, к которому подключается:'));
  print('    - профиль перезаписывается тем же значением dailyMinutes;');
  print('    - создаётся тестовый материал (удаляется в конце проверки);');
  print('    - создаётся черновик урока — он остаётся: удаления уроков в API нет.');
  print('    Чтобы не трогать рабочую базу, поднимите сервер на отдельной:');
  print('      DB_PATH=./data/smoke.db UPLOAD_DIR=./data/smoke-uploads npm run dev:server');
  print('');
}

/** Выполняет один шаг и печатает его результат. */
async function runStep(step, index, state) {
  const position = `[${String(index + 1)}/${String(STEPS.length)}]`;

  print(`${position} ${paint('bold', step.title)} ${paint('dim', `· ${step.target}`)}`);

  if (step.note !== undefined) {
    print(`       ${paint('dim', step.note)}`);
  }

  if (step.needsServer === true && state.serverUp !== true) {
    print(`       ${paint('skip', STATUS_LABELS.skip)}: сервер не ответил на шаге 1`);

    return { status: 'skip', title: step.title, problem: 'сервер не ответил' };
  }

  const started = Date.now();
  let outcome;

  try {
    outcome = (await step.run(state)) ?? {};
  } catch (error) {
    outcome =
      error instanceof SmokeError
        ? { problem: error.message, hints: error.hints }
        : { problem: `неожиданная ошибка: ${String(error?.message ?? error)}`, hints: [] };
  }

  const elapsed = formatMs(Date.now() - started);

  if (outcome.skipped !== undefined) {
    print(`       ${paint('skip', STATUS_LABELS.skip)}: ${outcome.skipped}`);

    return { status: 'skip', title: step.title, problem: outcome.skipped };
  }

  if (outcome.problem !== undefined) {
    print(`       ${paint('fail', STATUS_LABELS.fail)} (${elapsed}): ${outcome.problem}`);

    for (const hint of outcome.hints ?? []) {
      print(`         ${paint('dim', '→')} ${hint}`);
    }

    return { status: 'fail', title: step.title, problem: outcome.problem };
  }

  print(`       ${paint('ok', STATUS_LABELS.ok)} (${elapsed})`);

  for (const detail of outcome.details ?? []) {
    print(`         ${detail}`);
  }

  return { status: 'ok', title: step.title };
}

/** Убирает за собой созданный материал; урок удалить нечем — про него сообщаем. */
async function cleanup(state) {
  if (state.materialId === undefined) {
    return;
  }

  print('');

  try {
    const result = await request(`${state.baseUrl}/api/materials/${state.materialId}`, {
      method: 'DELETE',
    });

    print(
      result.ok
        ? `Уборка: тестовый материал ${state.materialId} удалён.`
        : `Уборка: материал ${state.materialId} удалить не удалось (${describeHttpFailure(result)}) — удалите его из списка материалов.`,
    );
  } catch (error) {
    print(
      `Уборка: материал ${state.materialId} удалить не удалось (${error.message}) — удалите его из списка материалов.`,
    );
  }

  if (state.lessonId !== undefined) {
    print(`Уборка: черновик урока ${state.lessonId} остался в базе — удаления уроков в API нет.`);
  }
}

/** Печатает сводку и возвращает код возврата. */
function printSummary(results, elapsedMs) {
  const failed = results.filter((result) => result.status === 'fail');
  const skipped = results.filter((result) => result.status === 'skip');
  const passed = results.filter((result) => result.status === 'ok');

  print('');
  print('─'.repeat(72));
  print(
    `Итог: ${paint('ok', `${String(passed.length)} ok`)}, ` +
      `${paint(
        failed.length === 0 ? 'dim' : 'fail',
        plural(failed.length, ['провал', 'провала', 'провалов']),
      )}, ` +
      `${paint('skip', plural(skipped.length, ['пропуск', 'пропуска', 'пропусков']))} — ` +
      formatMs(elapsedMs),
  );

  if (failed.length === 0) {
    print(paint('ok', 'Стек живой: можно запускать `npm run dev` и заниматься.'));

    if (skipped.length > 0) {
      print(paint('dim', 'Пропущенные шаги — это выключенные возможности, а не поломки.'));
    }

    return 0;
  }

  print('Провалы:');

  for (const result of failed) {
    print(`  - ${result.title}: ${result.problem}`);
  }

  print(
    'Что делать: смотрите строки «→» под каждым провалом, матрица провайдеров — docs/providers.md.',
  );

  return 1;
}

/** Точка входа. */
async function main() {
  const options = readOptions();

  if (options.help === true) {
    printUsage();

    return 0;
  }

  const envPath = loadEnvFile();
  const state = {
    baseUrl: trimSlash(options.url ?? envValue('SMOKE_BASE_URL', DEFAULT_BASE_URL)),
    envPath,
    llm: {
      baseUrl: envValue('LLM_BASE_URL', DEFAULT_LLM_BASE_URL),
      model: envValue('LLM_MODEL', DEFAULT_LLM_MODEL),
      apiKey: envValue('LLM_API_KEY', undefined),
    },
    timeouts: {
      llm: envNumber('SMOKE_LLM_TIMEOUT_MS', DEFAULT_LLM_TIMEOUT_MS),
      plan: envNumber('SMOKE_PLAN_TIMEOUT_MS', DEFAULT_PLAN_TIMEOUT_MS),
      voice: envNumber('SMOKE_VOICE_TIMEOUT_MS', DEFAULT_VOICE_TIMEOUT_MS),
    },
    serverUp: false,
  };

  printHeader(state);

  const started = Date.now();
  const results = [];

  for (const [index, step] of STEPS.entries()) {
    // Шаги идут строго подряд: материал нужен уроку, профиль — записи профиля.
    results.push(await runStep(step, index, state));
  }

  await cleanup(state);

  return printSummary(results, Date.now() - started);
}

process.exitCode = await main();
