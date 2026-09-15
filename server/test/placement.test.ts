import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_PREFIX,
  apiErrorResponseSchema,
  createPlacementSessionResponseSchema,
  finishPlacementSessionResponseSchema,
  getProfileResponseSchema,
  levelHistoryEntrySchema,
  submitPlacementTurnResponseSchema,
  type CreatePlacementSessionResponse,
  type FinishPlacementSessionResponse,
  type LearnerProfile,
  type SubmitPlacementTurnResponse,
} from '@lt/shared';

import type { Env } from '../src/config/env.js';
import type { LevelHistoryRow } from '../src/db/rows.js';

/** Подмена переменных окружения: провайдер читает `env` на каждом запросе. */
const envState = vi.hoisted(() => ({ overrides: {} as Partial<Env> }));

vi.mock('../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env.js')>();

  return {
    ...actual,
    get env(): Env {
      return { ...actual.env, ...envState.overrides };
    },
  };
});

const { buildApp } = await import('../src/app.js');
const { closeDb, getDb, IN_MEMORY_DB_PATH, openDatabase, setDb } =
  await import('../src/db/connection.js');
const { rowToLevelHistoryEntry } = await import('../src/db/mappers.js');
const { migrate } = await import('../src/db/migrate.js');
const { PROFILE_ROW_ID } = await import('../src/db/rows.js');
const { buildPlacementSystemPrompt } = await import('../src/prompts/placement.js');

const SESSIONS_URL = `${API_PREFIX}/placement/sessions`;

type FetchMock = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;

/** Ответ `/chat/completions` с заданным текстом модели. */
function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      model: 'test-model',
      choices: [{ message: { content }, finish_reason: 'stop' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Очередь ответов модели: каждое обращение забирает следующий. */
function stubLlm(...replies: (string | object)[]): FetchMock {
  const queue = replies.map((reply) => (typeof reply === 'string' ? reply : JSON.stringify(reply)));
  const fetchMock: FetchMock = vi.fn(async () => {
    const next = queue.shift();

    if (next === undefined) {
      throw new Error('LLM-мок: обращений больше, чем заготовленных ответов');
    }

    return chatResponse(next);
  });

  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

/** Первый вопрос сессии в формате `placement_question`. */
function question(text: string, skill = 'grammar'): object {
  return { assistantMessage: text, skill };
}

/** Оценка ответа в формате `placement_evaluation`. */
function evaluation(overrides: Record<string, unknown> = {}): object {
  return {
    score: 0.8,
    feedback: 'Ответ полный, есть ошибка в артикле',
    estimatedLevel: 'B1',
    confidence: 0.6,
    rationale: 'Строит сложные фразы, путается в падежах',
    shouldFinish: false,
    assistantMessage: 'Was machst du am Wochenende?',
    skill: 'vocabulary',
    ...overrides,
  };
}

/** Итог теста в формате `placement_result`. */
function summary(overrides: Record<string, unknown> = {}): object {
  return {
    level: 'B1',
    confidence: 0.8,
    rationale: 'Уверенно отвечает на бытовые вопросы',
    strengths: ['богатый словарь'],
    weaknesses: ['артикли'],
    recommendedGoals: ['Заказать кофе в кафе'],
    ...overrides,
  };
}

/** Системные сообщения, ушедшие модели в первом обращении. */
function systemPromptOf(fetchMock: FetchMock): string {
  const call = fetchMock.mock.calls[0];

  expect(call).toBeDefined();

  const body = JSON.parse(String(call?.[1].body)) as {
    messages: { role: string; content: string }[];
  };

  return body.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
}

let app: FastifyInstance;

/** Создаёт сессию и проверяет, что сервер принял её. */
async function createSession(payload: object = {}): Promise<CreatePlacementSessionResponse> {
  const response = await app.inject({ method: 'POST', url: SESSIONS_URL, payload });

  expect(response.statusCode).toBe(201);

  return createPlacementSessionResponseSchema.parse(response.json());
}

/** Отвечает на вопрос сессии. */
async function answerTurn(
  sessionId: string,
  turnId: string,
  answer = 'Ich fahre morgen nach Berlin',
): Promise<SubmitPlacementTurnResponse> {
  const response = await app.inject({
    method: 'POST',
    url: `${SESSIONS_URL}/${sessionId}/turns`,
    payload: { turnId, answer },
  });

  expect(response.statusCode).toBe(200);

  return submitPlacementTurnResponseSchema.parse(response.json());
}

/** Завершает тест. */
async function finishSession(
  sessionId: string,
  payload: object = {},
): Promise<FinishPlacementSessionResponse> {
  const response = await app.inject({
    method: 'POST',
    url: `${SESSIONS_URL}/${sessionId}/finish`,
    payload,
  });

  expect(response.statusCode).toBe(200);

  return finishPlacementSessionResponseSchema.parse(response.json());
}

/** Сессия, прочитанная заново. */
async function fetchSession(sessionId: string): Promise<CreatePlacementSessionResponse> {
  const response = await app.inject({ method: 'GET', url: `${SESSIONS_URL}/${sessionId}` });

  expect(response.statusCode).toBe(200);

  return createPlacementSessionResponseSchema.parse(response.json());
}

/** Профиль, прочитанный заново. */
async function fetchProfile(): Promise<LearnerProfile> {
  const response = await app.inject({ method: 'GET', url: `${API_PREFIX}/profile` });

  expect(response.statusCode).toBe(200);

  return getProfileResponseSchema.parse(response.json());
}

/** Все записи истории уровня в порядке добавления. */
function levelHistoryRows(): LevelHistoryRow[] {
  return getDb()
    .prepare('SELECT * FROM level_history ORDER BY changed_at')
    .all() as LevelHistoryRow[];
}

/** Правит профиль в обход API: смена уровня через API попала бы в историю. */
function presetProfile(fields: { level?: string; learningLanguage?: string }): void {
  if (fields.level !== undefined) {
    getDb().prepare('UPDATE profile SET level = ? WHERE id = ?').run(fields.level, PROFILE_ROW_ID);
  }

  if (fields.learningLanguage !== undefined) {
    getDb()
      .prepare('UPDATE profile SET learning_language = ? WHERE id = ?')
      .run(fields.learningLanguage, PROFILE_ROW_ID);
  }
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeDb();
});

beforeEach(() => {
  const db = openDatabase(IN_MEMORY_DB_PATH);

  migrate(db);
  setDb(db);
  envState.overrides = {};
  // Ни один тест не ходит в сеть: обращение мимо мока должно быть заметным.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Тест обратился в сеть без мока');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/placement/sessions', () => {
  it('создаёт сессию и задаёт первый вопрос на изучаемом языке', async () => {
    presetProfile({ learningLanguage: 'de' });

    const fetchMock = stubLlm(question('Wie heißt du?', 'speaking'));
    const created = await createSession();

    expect(created.session.status).toBe('in_progress');
    expect(created.session.learningLanguage).toBe('de');
    expect(created.session.explanationLanguage).toBe('ru');
    expect(created.session.maxTurns).toBe(8);
    expect(created.session.turns).toHaveLength(1);
    expect(created.nextTurn?.question).toBe('Wie heißt du?');
    expect(created.nextTurn?.questionLanguage).toBe('de');
    expect(created.nextTurn?.skill).toBe('speaking');
    expect(created.nextTurn?.targetLevel).toBe('A1');
    expect(created.nextTurn?.answeredAt).toBeNull();

    const prompt = systemPromptOf(fetchMock);

    expect(prompt).toContain('German (de)');
    expect(prompt).toContain('Russian (ru)');
  });

  it('уважает число вопросов и языки из тела запроса', async () => {
    stubLlm(question('¿Cómo te llamas?'));

    const created = await createSession({
      learningLanguage: 'es',
      explanationLanguage: 'en',
      maxTurns: 3,
    });

    expect(created.session.learningLanguage).toBe('es');
    expect(created.session.explanationLanguage).toBe('en');
    expect(created.session.maxTurns).toBe(3);
    // Уровень профиля относится к другому языку, поэтому тест начинается с A1.
    expect(created.nextTurn?.targetLevel).toBe('A1');
  });

  it('чинит ответ модели не по схеме ремонтным заходом', async () => {
    const fetchMock = stubLlm('Конечно! Вот вопрос.', question('How are you?'));
    const created = await createSession();

    expect(created.nextTurn?.question).toBe('How are you?');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('отвечает 502 и сохраняет сессию, если ремонт не помог', async () => {
    stubLlm('никакого JSON', 'снова никакого JSON');

    const response = await app.inject({ method: 'POST', url: SESSIONS_URL, payload: {} });

    expect(response.statusCode).toBe(502);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('upstream_error');

    const details = body.error.details as { sessionId?: string; reason?: string } | undefined;

    expect(details?.reason).toBe('llm_invalid_response');
    expect(details?.sessionId).toBeTypeOf('string');

    const restored = await fetchSession(String(details?.sessionId));

    expect(restored.session.status).toBe('in_progress');
    expect(restored.session.turns).toHaveLength(0);
    expect(restored.nextTurn).toBeNull();
  });

  it('отвечает 501 и сохраняет сессию, если языковая модель не настроена', async () => {
    envState.overrides = { llmBaseUrl: '' };

    const response = await app.inject({ method: 'POST', url: SESSIONS_URL, payload: {} });

    expect(response.statusCode).toBe(501);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('not_configured');

    const details = body.error.details as { sessionId?: string; reason?: string } | undefined;

    expect(details?.reason).toBe('llm_not_configured');

    const restored = await fetchSession(String(details?.sessionId));

    expect(restored.session.status).toBe('in_progress');
    expect(restored.session.turns).toHaveLength(0);
  });

  it('отвечает 503, когда модель недоступна', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new TypeError('fetch failed');
      }),
    );

    const response = await app.inject({ method: 'POST', url: SESSIONS_URL, payload: {} });

    expect(response.statusCode).toBe(503);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('upstream_unavailable');
    expect(body.error.details).toMatchObject({ reason: 'llm_unavailable' });
  });

  it('отвечает 400 на язык вне списка пресетов', async () => {
    const response = await app.inject({
      method: 'POST',
      url: SESSIONS_URL,
      payload: { learningLanguage: 'zz' },
    });

    expect(response.statusCode).toBe(400);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('bad_request');
    expect(body.error.details).toMatchObject({
      reason: 'unsupported_language',
      field: 'learningLanguage',
    });
  });

  it('отвечает 400 на число вопросов вне допустимых границ', async () => {
    const response = await app.inject({
      method: 'POST',
      url: SESSIONS_URL,
      payload: { maxTurns: 99 },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });
});

describe('GET /api/placement/sessions/:id', () => {
  it('восстанавливает незавершённый тест вместе с историей ходов', async () => {
    stubLlm(question('Wie geht es dir?'), evaluation({ assistantMessage: 'Und dein Tag?' }));

    const created = await createSession();
    const firstTurnId = String(created.nextTurn?.id);

    await answerTurn(created.session.id, firstTurnId, 'Mir geht es gut');

    const restored = await fetchSession(created.session.id);

    expect(restored.session.status).toBe('in_progress');
    expect(restored.session.turns).toHaveLength(2);
    expect(restored.session.turns[0]?.question).toBe('Wie geht es dir?');
    expect(restored.session.turns[0]?.answer).toBe('Mir geht es gut');
    expect(restored.session.turns[0]?.score).toBe(0.8);
    expect(restored.session.turns[0]?.answeredAt).not.toBeNull();
    expect(restored.nextTurn?.id).toBe(restored.session.turns[1]?.id);
    expect(restored.nextTurn?.question).toBe('Und dein Tag?');
  });

  it('отвечает 404 на неизвестную сессию', async () => {
    const response = await app.inject({ method: 'GET', url: `${SESSIONS_URL}/no-such-session` });

    expect(response.statusCode).toBe(404);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('not_found');
    expect(body.error.details).toMatchObject({ reason: 'placement_session_not_found' });
  });
});

describe('POST /api/placement/sessions/:id/turns', () => {
  it('поднимает и опускает сложность следующего вопроса по оценке ответа', async () => {
    presetProfile({ level: 'B1' });
    stubLlm(
      question('Erzähl von deinem Beruf'),
      evaluation({ score: 0.9, assistantMessage: 'Was würdest du ändern?' }),
      evaluation({ score: 0.2, assistantMessage: 'Wie alt bist du?' }),
    );

    const created = await createSession();

    expect(created.nextTurn?.targetLevel).toBe('B1');

    const first = await answerTurn(created.session.id, String(created.nextTurn?.id));

    expect(first.finished).toBe(false);
    expect(first.nextTurn?.targetLevel).toBe('B2');

    const second = await answerTurn(created.session.id, String(first.nextTurn?.id));

    expect(second.nextTurn?.targetLevel).toBe('B1');
  });

  it('не показывает ученику оценку: наружу уходит только вопрос', async () => {
    stubLlm(
      question('Wie war dein Wochenende?'),
      evaluation({
        score: 0.95,
        estimatedLevel: 'B2',
        feedback: 'СЛУЖЕБНЫЙ РАЗБОР: ошибка в порядке слов',
        rationale: 'СЛУЖЕБНОЕ ОБОСНОВАНИЕ: уровень B2',
        assistantMessage: 'Was planst du für den Sommer?',
      }),
    );

    const created = await createSession();
    const answered = await answerTurn(created.session.id, String(created.nextTurn?.id));

    expect(answered.nextTurn?.question).toBe('Was planst du für den Sommer?');
    expect(answered.nextTurn?.question).not.toContain('B2');
    expect(answered.nextTurn?.question).not.toContain('СЛУЖЕБНЫЙ');
    expect(answered.nextTurn?.question).not.toContain('СЛУЖЕБНОЕ');
    expect(answered.nextTurn?.score).toBeNull();
    expect(answered.nextTurn?.feedback).toBeNull();
    expect(answered.nextTurn?.estimatedLevel).toBeNull();
    // Оценка остаётся у сервера — в полях оценённого хода, а не в вопросе.
    expect(answered.evaluatedTurn.score).toBe(0.95);
    expect(answered.evaluatedTurn.estimatedLevel).toBe('B2');
  });

  it('запрещает модели раскрывать оценку ученику в системном промпте', () => {
    const prompt = buildPlacementSystemPrompt({
      learningLanguage: 'de',
      explanationLanguage: 'ru',
      maxTurns: 8,
      profileSummary: 'Learner profile:\n- CEFR level: A2',
    });

    expect(prompt).toContain('Never reveal the assessment to the learner');
    expect(prompt).toContain('German (de)');
    expect(prompt).toContain('Russian (ru)');
  });

  it('принудительно завершает тест при исчерпании лимита вопросов', async () => {
    stubLlm(
      question('Frage eins'),
      evaluation({ assistantMessage: 'Frage zwei' }),
      // Модель просит продолжать, но лимит вопросов уже исчерпан.
      evaluation({ shouldFinish: false, assistantMessage: 'Frage drei' }),
    );

    const created = await createSession({ maxTurns: 2 });
    const first = await answerTurn(created.session.id, String(created.nextTurn?.id));

    expect(first.finished).toBe(false);
    expect(first.nextTurn?.question).toBe('Frage zwei');

    const second = await answerTurn(created.session.id, String(first.nextTurn?.id));

    expect(second.finished).toBe(true);
    expect(second.nextTurn).toBeNull();
    expect(second.session.turns).toHaveLength(2);

    const restored = await fetchSession(created.session.id);

    expect(restored.session.turns).toHaveLength(2);
    expect(restored.nextTurn).toBeNull();
  });

  it('завершает тест, когда модель сочла уровень ясным', async () => {
    stubLlm(question('Frage eins'), evaluation({ shouldFinish: true, assistantMessage: null }));

    const created = await createSession();
    const answered = await answerTurn(created.session.id, String(created.nextTurn?.id));

    expect(answered.finished).toBe(true);
    expect(answered.nextTurn).toBeNull();
  });

  it('отвечает 409 на повторный ответ на тот же вопрос', async () => {
    stubLlm(question('Frage eins'), evaluation());

    const created = await createSession();
    const turnId = String(created.nextTurn?.id);

    await answerTurn(created.session.id, turnId);

    const response = await app.inject({
      method: 'POST',
      url: `${SESSIONS_URL}/${created.session.id}/turns`,
      payload: { turnId, answer: 'ещё раз' },
    });

    expect(response.statusCode).toBe(409);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('conflict');
    expect(body.error.details).toMatchObject({ reason: 'placement_turn_already_answered' });
  });

  it('отвечает 404 на вопрос из другой сессии', async () => {
    stubLlm(question('Frage eins'));

    const created = await createSession();
    const response = await app.inject({
      method: 'POST',
      url: `${SESSIONS_URL}/${created.session.id}/turns`,
      payload: { turnId: 'turn-from-another-session', answer: 'ответ' },
    });

    expect(response.statusCode).toBe(404);
    expect(apiErrorResponseSchema.parse(response.json()).error.details).toMatchObject({
      reason: 'placement_turn_not_found',
    });
  });

  it('отвечает 400 на пустой ответ', async () => {
    stubLlm(question('Frage eins'));

    const created = await createSession();
    const response = await app.inject({
      method: 'POST',
      url: `${SESSIONS_URL}/${created.session.id}/turns`,
      payload: { turnId: created.nextTurn?.id, answer: '   ' },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });
});

describe('POST /api/placement/sessions/:id/finish', () => {
  it('проходит полный цикл и записывает уровень в профиль и историю', async () => {
    stubLlm(
      question('Frage eins'),
      evaluation({ score: 0.9 }),
      evaluation({ score: 0.6 }),
      evaluation({ score: 0.9 }),
      summary({ level: 'B1', confidence: 0.75 }),
    );

    const created = await createSession();
    const first = await answerTurn(created.session.id, String(created.nextTurn?.id));
    const second = await answerTurn(created.session.id, String(first.nextTurn?.id));

    await answerTurn(created.session.id, String(second.nextTurn?.id));

    const finished = await finishSession(created.session.id);

    expect(finished.session.status).toBe('completed');
    expect(finished.session.completedAt).not.toBeNull();
    expect(finished.result.level).toBe('B1');
    expect(finished.result.turnsEvaluated).toBe(3);
    expect(finished.result.accuracy).toBeCloseTo(0.8, 5);
    expect(finished.result.strengths).toEqual(['богатый словарь']);
    expect(finished.result.weaknesses).toEqual(['артикли']);
    expect(finished.profile?.level).toBe('B1');

    const profile = await fetchProfile();

    expect(profile.level).toBe('B1');
    expect(profile.levelConfidence).toBe(0.75);
    expect(profile.placementCompletedAt).not.toBeNull();

    const rows = levelHistoryRows();

    expect(rows).toHaveLength(1);

    const entry = levelHistoryEntrySchema.parse(rowToLevelHistoryEntry(rows[0] as LevelHistoryRow));

    expect(entry.source).toBe('placement');
    expect(entry.toLevel).toBe('B1');
    expect(entry.fromLevel).toBeNull();
    expect(entry.direction).toBe('initial');
    expect(entry.confidence).toBe(0.75);
    expect(entry.reason.length).toBeGreaterThan(0);
    expect(entry.metrics.exercisesEvaluated).toBe(3);
    expect(entry.metrics.accuracy).toBeCloseTo(0.8, 5);

    const restored = await fetchSession(created.session.id);

    expect(restored.session.status).toBe('completed');
    expect(restored.session.result?.level).toBe('B1');
    expect(restored.nextTurn).toBeNull();
  });

  it('не трогает профиль при applyToProfile: false', async () => {
    stubLlm(question('Frage eins'), evaluation({ shouldFinish: true }), summary({ level: 'C1' }));

    const created = await createSession();

    await answerTurn(created.session.id, String(created.nextTurn?.id));

    const finished = await finishSession(created.session.id, { applyToProfile: false });

    expect(finished.result.level).toBe('C1');
    expect(finished.profile).toBeNull();

    const profile = await fetchProfile();

    expect(profile.level).toBe('A1');
    expect(profile.placementCompletedAt).toBeNull();
    expect(levelHistoryRows()).toHaveLength(0);
  });

  it('отвечает 409 на повторное завершение', async () => {
    stubLlm(question('Frage eins'), evaluation({ shouldFinish: true }), summary());

    const created = await createSession();

    await answerTurn(created.session.id, String(created.nextTurn?.id));
    await finishSession(created.session.id);

    const response = await app.inject({
      method: 'POST',
      url: `${SESSIONS_URL}/${created.session.id}/finish`,
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(apiErrorResponseSchema.parse(response.json()).error.details).toMatchObject({
      reason: 'placement_session_not_active',
    });
  });

  it('отвечает 409, пока нет ни одного ответа', async () => {
    stubLlm(question('Frage eins'));

    const created = await createSession();
    const response = await app.inject({
      method: 'POST',
      url: `${SESSIONS_URL}/${created.session.id}/finish`,
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(apiErrorResponseSchema.parse(response.json()).error.details).toMatchObject({
      reason: 'placement_no_answers',
    });
  });

  it('отвечает 409, если тест шёл не на изучаемом языке профиля', async () => {
    stubLlm(question('¿Cómo estás?'), evaluation({ shouldFinish: true }), summary());

    const created = await createSession({ learningLanguage: 'es' });

    await answerTurn(created.session.id, String(created.nextTurn?.id));

    const response = await app.inject({
      method: 'POST',
      url: `${SESSIONS_URL}/${created.session.id}/finish`,
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(apiErrorResponseSchema.parse(response.json()).error.details).toMatchObject({
      reason: 'placement_language_mismatch',
    });

    // Сессия осталась активной: итог можно сохранить без переноса в профиль.
    const saved = await finishSession(created.session.id, { applyToProfile: false });

    expect(saved.session.status).toBe('completed');
  });

  it('сохраняет сессию, когда модель не смогла собрать итог', async () => {
    stubLlm(
      question('Frage eins'),
      evaluation({ shouldFinish: true }),
      'ответ не по схеме',
      'и ремонт не помог',
    );

    const created = await createSession();

    await answerTurn(created.session.id, String(created.nextTurn?.id));

    const response = await app.inject({
      method: 'POST',
      url: `${SESSIONS_URL}/${created.session.id}/finish`,
      payload: {},
    });

    expect(response.statusCode).toBe(502);

    const restored = await fetchSession(created.session.id);

    expect(restored.session.status).toBe('in_progress');
    expect(restored.session.turns[0]?.answer).not.toBeNull();
  });
});
