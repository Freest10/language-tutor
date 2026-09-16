import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_PREFIX,
  apiErrorResponseSchema,
  createLessonResponseSchema,
  getLessonResponseSchema,
  listLessonsResponseSchema,
  regenerateLessonPlanResponseSchema,
  type CreateLessonResponse,
  type Id,
  type RegenerateLessonPlanResponse,
} from '@lt/shared';

import { buildApp } from '../src/app.js';
import { closeDb, getDb, IN_MEMORY_DB_PATH, openDatabase, setDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { PROFILE_ROW_ID, type LessonPlanStepRow } from '../src/db/rows.js';
import { createMaterialFromText } from '../src/services/materialService.js';

const LESSONS_URL = `${API_PREFIX}/lessons`;

/** Текст материала: по нему проверяется, что цитаты доходят до промпта. */
const MATERIAL_TEXT = [
  'Im Supermarkt',
  'Anna kauft Brot, Käse und Milch für das Frühstück.',
  'An der Kasse bezahlt sie mit Karte und fragt nach einer Quittung.',
].join('\n\n');

/** Фраза материала, которая обязана найтись в промпте. */
const MATERIAL_QUOTE = 'An der Kasse bezahlt sie mit Karte';

type FetchMock = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;

/** Реплика диалога с моделью. */
interface PromptMessage {
  role: string;
  content: string;
}

let app: FastifyInstance;

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

/** Шаг плана в формате `lesson_plan`. */
function step(overrides: Record<string, unknown> = {}): object {
  return {
    type: 'vocabulary',
    title: 'Слова о покупках',
    objectives: ['Назвать продукты'],
    targetItems: ['das Brot', 'die Milch'],
    instructions: 'Разберите с учеником пять слов и попросите составить с ними фразы.',
    estimatedMinutes: 4,
    materialRefs: [],
    ...overrides,
  };
}

/** План урока в формате `lesson_plan`. */
function planReply(steps: object[], overrides: Record<string, unknown> = {}): object {
  return {
    title: 'Покупки в супермаркете',
    topic: 'Покупки',
    steps,
    ...overrides,
  };
}

/** План из пяти шагов на 20 минут. */
function defaultPlan(): object {
  return planReply([
    step({ type: 'warmup', title: 'Разминка', estimatedMinutes: 3 }),
    step({ type: 'vocabulary', title: 'Слова о покупках', estimatedMinutes: 5 }),
    step({ type: 'grammar', title: 'Винительный падеж', estimatedMinutes: 5 }),
    step({ type: 'speaking', title: 'Диалог у кассы', estimatedMinutes: 5 }),
    step({ type: 'wrapup', title: 'Итоги', estimatedMinutes: 2 }),
  ]);
}

/** Реплики, ушедшие модели в первом обращении. */
function promptMessagesOf(fetchMock: FetchMock, call = 0): PromptMessage[] {
  const request = fetchMock.mock.calls[call];

  expect(request).toBeDefined();

  const body = JSON.parse(String(request?.[1].body)) as { messages: PromptMessage[] };

  return body.messages;
}

/** Весь текст промпта первого обращения: системная часть и задача. */
function promptOf(fetchMock: FetchMock, call = 0): string {
  return promptMessagesOf(fetchMock, call)
    .map((message) => message.content)
    .join('\n');
}

/** Создаёт урок и проверяет, что сервер его принял. */
async function createLesson(payload: object = {}): Promise<CreateLessonResponse> {
  const response = await app.inject({ method: 'POST', url: LESSONS_URL, payload });

  expect(response.statusCode).toBe(201);

  return createLessonResponseSchema.parse(response.json());
}

/** Пересобирает план урока. */
async function regeneratePlan(
  lessonId: Id,
  payload: object = {},
): Promise<RegenerateLessonPlanResponse> {
  const response = await app.inject({
    method: 'POST',
    url: `${LESSONS_URL}/${lessonId}/plan/regenerate`,
    payload,
  });

  expect(response.statusCode).toBe(200);

  return regenerateLessonPlanResponseSchema.parse(response.json());
}

/** Шаги плана урока прямо из базы, в порядке колонки `"order"`. */
function stepRows(lessonId: Id): LessonPlanStepRow[] {
  return getDb()
    .prepare('SELECT * FROM lesson_plan_steps WHERE lesson_id = ? ORDER BY "order" ASC')
    .all(lessonId) as LessonPlanStepRow[];
}

/** Число записей в таблице. */
function countRows(table: string): number {
  const { total } = getDb().prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as {
    total: number;
  };

  return total;
}

/** Правит профиль в обход API: обновление уровня через API попало бы в историю. */
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

/** Кладёт в базу материал, из которого не удалось извлечь текст. */
function seedBrokenMaterial(id: Id): Id {
  getDb()
    .prepare(
      `INSERT INTO materials (
         id, title, source_type, status, status_message, original_file_name, file_path,
         mime_type, size_bytes, language, level, char_count, chunk_count, page_count,
         topics, summary, created_at, updated_at
       ) VALUES (@id, 'Скан учебника', 'pdf', 'error_no_text_layer',
         'В PDF нет текстового слоя', 'scan.pdf', NULL, 'application/pdf', 1024, 'de', NULL,
         0, 0, 2, '[]', NULL, @now, @now)`,
    )
    .run({ id, now: '2026-09-01T10:00:00.000Z' });

  return id;
}

/** Помечает шаги плана пройденными и переводит урок в статус «идёт». */
function markStepsCompleted(lessonId: Id, stepIds: readonly Id[], currentStepId: Id): void {
  const db = getDb();
  const update = db.prepare(
    `UPDATE lesson_plan_steps SET status = 'completed', started_at = @at, completed_at = @at
       WHERE id = @id`,
  );

  for (const id of stepIds) {
    update.run({ id, at: '2026-09-02T10:00:00.000Z' });
  }

  db.prepare(
    `UPDATE lessons SET status = 'in_progress', current_step_id = @step, started_at = @at
       WHERE id = @id`,
  ).run({ id: lessonId, step: currentStepId, at: '2026-09-02T10:00:00.000Z' });
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

describe('POST /api/lessons', () => {
  it('создаёт урок с планом и сохраняет шаги по порядку', async () => {
    stubLlm(defaultPlan());

    const lesson = await createLesson();

    expect(lesson.status).toBe('draft');
    expect(lesson.title).toBe('Покупки в супермаркете');
    expect(lesson.plannedMinutes).toBe(20);
    expect(lesson.currentStepId).toBeNull();
    expect(lesson.plan).toHaveLength(5);

    const rows = stepRows(lesson.id);

    expect(rows.map((row) => row.order)).toEqual([0, 1, 2, 3, 4]);
    expect(rows.map((row) => row.title)).toEqual([
      'Разминка',
      'Слова о покупках',
      'Винительный падеж',
      'Диалог у кассы',
      'Итоги',
    ]);
    expect(rows.every((row) => row.status === 'pending')).toBe(true);
    expect(rows.every((row) => row.lesson_id === lesson.id)).toBe(true);
    expect(JSON.parse(rows[1]?.target_items ?? '[]')).toEqual(['das Brot', 'die Milch']);
  });

  it('строит урок по целям профиля, когда материалы не выбраны', async () => {
    presetProfile({ level: 'B1', learningLanguage: 'de' });

    const fetchMock = stubLlm(defaultPlan());
    const lesson = await createLesson();

    expect(lesson.materialIds).toEqual([]);
    expect(lesson.level).toBe('B1');
    expect(lesson.learningLanguage).toBe('de');
    expect(lesson.explanationLanguage).toBe('ru');
    expect(countRows('lesson_materials')).toBe(0);

    const prompt = promptOf(fetchMock);

    expect(prompt).toContain('CEFR level: B1');
    expect(prompt).toContain('Научиться общаться на повседневные темы');
    expect(prompt).toContain('German (de)');
    expect(prompt).toContain('Russian (ru)');
    expect(prompt).toContain('No materials were uploaded');
  });

  it('кладёт в промпт цитаты из материалов и привязывает фрагменты к шагам', async () => {
    const material = await createMaterialFromText({ text: MATERIAL_TEXT, title: 'Супермаркет' });
    const chunkId = (
      getDb()
        .prepare('SELECT id FROM material_chunks WHERE material_id = ? ORDER BY "order"')
        .all(material.id) as { id: string }[]
    )[0]?.id;

    const fetchMock = stubLlm(
      planReply([
        step({ type: 'warmup', title: 'Разминка', estimatedMinutes: 3 }),
        step({
          type: 'reading',
          title: 'Читаем про кассу',
          materialRefs: ['C1'],
          estimatedMinutes: 6,
        }),
        step({
          type: 'speaking',
          title: 'Диалог у кассы',
          materialRefs: ['C9'],
          estimatedMinutes: 6,
        }),
        step({ type: 'wrapup', title: 'Итоги', estimatedMinutes: 5 }),
      ]),
    );
    const lesson = await createLesson({ materialIds: [material.id], topic: 'Покупки' });

    expect(lesson.materialIds).toEqual([material.id]);
    expect(lesson.plan[1]?.materialChunkIds).toEqual([chunkId]);
    // Метки, которых в промпте не было, отбрасываются, а не сохраняются как есть.
    expect(lesson.plan[2]?.materialChunkIds).toEqual([]);

    const prompt = promptOf(fetchMock);

    expect(prompt).toContain(MATERIAL_QUOTE);
    expect(prompt).toContain('[C1]');
    expect(prompt).toContain('Супермаркет');
    expect(prompt).toContain('Topic: Покупки');

    const links = getDb()
      .prepare('SELECT material_id FROM lesson_materials WHERE lesson_id = ?')
      .all(lesson.id) as { material_id: string }[];

    expect(links.map((link) => link.material_id)).toEqual([material.id]);
  });

  it('приводит минуты шагов к длительности урока', async () => {
    stubLlm(
      planReply([
        step({ type: 'warmup', estimatedMinutes: 20 }),
        step({ type: 'vocabulary', estimatedMinutes: 30 }),
        step({ type: 'speaking', estimatedMinutes: 30 }),
        step({ type: 'wrapup', estimatedMinutes: 20 }),
      ]),
    );

    const lesson = await createLesson({ durationMinutes: 30 });
    const total = lesson.plan.reduce((sum, planStep) => sum + planStep.estimatedMinutes, 0);

    expect(lesson.plannedMinutes).toBe(30);
    expect(total).toBe(30);
    expect(lesson.plan.every((planStep) => planStep.estimatedMinutes >= 1)).toBe(true);
  });

  it('чинит план не по схеме ремонтным заходом', async () => {
    const fetchMock = stubLlm(
      planReply([step({ type: 'warmup' }), step({ type: 'wrapup' })]),
      defaultPlan(),
    );
    const lesson = await createLesson();

    expect(lesson.plan).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('отвечает 502 и не оставляет в базе ни урока, ни шагов', async () => {
    stubLlm('никакого JSON', 'снова никакого JSON');

    const response = await app.inject({ method: 'POST', url: LESSONS_URL, payload: {} });

    expect(response.statusCode).toBe(502);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('upstream_error');
    expect(body.error.details).toMatchObject({ reason: 'llm_invalid_response' });
    expect(countRows('lessons')).toBe(0);
    expect(countRows('lesson_plan_steps')).toBe(0);
    expect(countRows('lesson_materials')).toBe(0);
  });

  it('отвечает 400 и называет материал, из которого не извлечён текст', async () => {
    const brokenId = seedBrokenMaterial('material-broken');
    const response = await app.inject({
      method: 'POST',
      url: LESSONS_URL,
      payload: { materialIds: [brokenId] },
    });

    expect(response.statusCode).toBe(400);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('bad_request');

    const details = body.error.details as {
      reason?: string;
      materials?: { id?: string; status?: string }[];
    };

    expect(details.reason).toBe('materials_not_ready');
    expect(details.materials).toEqual([
      expect.objectContaining({ id: brokenId, status: 'error_no_text_layer' }),
    ]);
    expect(countRows('lessons')).toBe(0);
  });

  it('отвечает 404 на неизвестный материал', async () => {
    const response = await app.inject({
      method: 'POST',
      url: LESSONS_URL,
      payload: { materialIds: ['no-such-material'] },
    });

    expect(response.statusCode).toBe(404);
    expect(apiErrorResponseSchema.parse(response.json()).error.details).toMatchObject({
      reason: 'material_not_found',
    });
  });

  it('отвечает 400 на длительность урока вне допустимых границ', async () => {
    const response = await app.inject({
      method: 'POST',
      url: LESSONS_URL,
      payload: { durationMinutes: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });
});

describe('GET /api/lessons', () => {
  it('отдаёт уроки от новых к старым с фильтром по статусу и пагинацией', async () => {
    stubLlm(defaultPlan(), defaultPlan(), defaultPlan());

    const first = await createLesson({ title: 'Первый' });
    const second = await createLesson({ title: 'Второй' });

    await createLesson({ title: 'Третий' });

    getDb().prepare(`UPDATE lessons SET status = 'completed' WHERE id = ?`).run(first.id);
    // Порядок сортировки задаётся `created_at`: в тесте уроки создаются в одну миллисекунду.
    getDb()
      .prepare('UPDATE lessons SET created_at = ? WHERE id = ?')
      .run('2026-09-01T10:00:00.000Z', second.id);

    const all = await app.inject({ method: 'GET', url: `${LESSONS_URL}?limit=2` });

    expect(all.statusCode).toBe(200);

    const page = listLessonsResponseSchema.parse(all.json());

    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.items.at(-1)?.title).not.toBe('Второй');

    const tail = await app.inject({ method: 'GET', url: `${LESSONS_URL}?limit=2&offset=2` });
    const tailPage = listLessonsResponseSchema.parse(tail.json());

    expect(tailPage.items).toHaveLength(1);
    expect(tailPage.hasMore).toBe(false);
    expect(tailPage.items[0]?.title).toBe('Второй');

    const completed = await app.inject({ method: 'GET', url: `${LESSONS_URL}?status=completed` });
    const completedPage = listLessonsResponseSchema.parse(completed.json());

    expect(completedPage.total).toBe(1);
    expect(completedPage.items[0]?.id).toBe(first.id);
    expect(completedPage.items[0]?.plan).toHaveLength(5);
  });

  it('фильтрует уроки по названию', async () => {
    stubLlm(defaultPlan(), defaultPlan());

    await createLesson({ title: 'Покупки в магазине' });
    await createLesson({ title: 'Собеседование' });

    const response = await app.inject({ method: 'GET', url: `${LESSONS_URL}?search=магазин` });
    const page = listLessonsResponseSchema.parse(response.json());

    expect(page.total).toBe(1);
    expect(page.items[0]?.title).toBe('Покупки в магазине');
  });
});

describe('GET /api/lessons/:id', () => {
  it('отдаёт урок с планом и материалами', async () => {
    const material = await createMaterialFromText({ text: MATERIAL_TEXT, title: 'Супермаркет' });

    stubLlm(defaultPlan());

    const created = await createLesson({ materialIds: [material.id] });
    const response = await app.inject({ method: 'GET', url: `${LESSONS_URL}/${created.id}` });

    expect(response.statusCode).toBe(200);

    const body = getLessonResponseSchema.parse(response.json());

    expect(body.lesson.id).toBe(created.id);
    expect(body.lesson.materialIds).toEqual([material.id]);
    expect(body.lesson.plan.map((planStep) => planStep.order)).toEqual([0, 1, 2, 3, 4]);
    expect(body.exercises).toEqual([]);
    expect(body.attempts).toEqual([]);
  });

  it('отвечает 404 на неизвестный урок', async () => {
    const response = await app.inject({ method: 'GET', url: `${LESSONS_URL}/no-such-lesson` });

    expect(response.statusCode).toBe(404);
    expect(apiErrorResponseSchema.parse(response.json()).error.details).toMatchObject({
      reason: 'lesson_not_found',
    });
  });
});

describe('POST /api/lessons/:id/plan/regenerate', () => {
  it('заменяет план черновика, не плодя дубликатов', async () => {
    const fetchMock = stubLlm(
      defaultPlan(),
      planReply([
        step({ type: 'warmup', title: 'Новая разминка', estimatedMinutes: 4 }),
        step({ type: 'listening', title: 'Слушаем диалог', estimatedMinutes: 6 }),
        step({ type: 'speaking', title: 'Говорим сами', estimatedMinutes: 6 }),
        step({ type: 'wrapup', title: 'Новые итоги', estimatedMinutes: 4 }),
      ]),
    );
    const created = await createLesson();
    const updated = await regeneratePlan(created.id, { feedback: 'Больше говорения' });

    expect(updated.plan).toHaveLength(4);
    expect(updated.plan.map((planStep) => planStep.title)).toEqual([
      'Новая разминка',
      'Слушаем диалог',
      'Говорим сами',
      'Новые итоги',
    ]);
    expect(countRows('lesson_plan_steps')).toBe(4);

    const rows = stepRows(created.id);

    expect(rows.map((row) => row.order)).toEqual([0, 1, 2, 3]);

    const prompt = promptOf(fetchMock, 1);

    expect(prompt).toContain('Больше говорения');
  });

  it('сохраняет пройденные шаги при keepCompletedSteps', async () => {
    stubLlm(
      defaultPlan(),
      planReply([
        step({ type: 'listening', title: 'Слушаем диалог', estimatedMinutes: 5 }),
        step({ type: 'speaking', title: 'Говорим сами', estimatedMinutes: 5 }),
        step({ type: 'wrapup', title: 'Новые итоги', estimatedMinutes: 2 }),
      ]),
    );

    const created = await createLesson();
    const done = created.plan.slice(0, 2).map((planStep) => planStep.id);

    markStepsCompleted(created.id, done, String(created.plan[2]?.id));

    const updated = await regeneratePlan(created.id, { keepCompletedSteps: true });

    expect(updated.plan).toHaveLength(5);
    expect(updated.plan.slice(0, 2).map((planStep) => planStep.id)).toEqual(done);
    expect(updated.plan.slice(0, 2).every((planStep) => planStep.status === 'completed')).toBe(
      true,
    );
    expect(updated.plan.slice(2).map((planStep) => planStep.title)).toEqual([
      'Слушаем диалог',
      'Говорим сами',
      'Новые итоги',
    ]);
    // Урок продолжается: текущим становится первый непройденный шаг нового плана.
    expect(updated.currentStepId).toBe(updated.plan[2]?.id);

    const rows = stepRows(created.id);

    expect(rows).toHaveLength(5);
    expect(countRows('lesson_plan_steps')).toBe(5);
    expect(rows.map((row) => row.order)).toEqual([0, 1, 2, 3, 4]);
    expect(rows.slice(0, 2).map((row) => row.status)).toEqual(['completed', 'completed']);
  });

  it('называет модели пройденные шаги, которые остаются в плане', async () => {
    const fetchMock = stubLlm(
      defaultPlan(),
      planReply([
        step({ type: 'speaking', title: 'Говорим сами', estimatedMinutes: 8 }),
        step({ type: 'wrapup', title: 'Новые итоги', estimatedMinutes: 4 }),
      ]),
    );
    const created = await createLesson();
    const done = created.plan.slice(0, 2).map((planStep) => planStep.id);

    markStepsCompleted(created.id, done, String(created.plan[2]?.id));
    await regeneratePlan(created.id);

    const prompt = promptOf(fetchMock, 1);

    expect(prompt).toContain('Разминка');
    expect(prompt).toContain('Слова о покупках');
    expect(prompt).toContain('Plan only the steps that come after them.');
  });

  it('полностью заменяет план при keepCompletedSteps: false', async () => {
    stubLlm(
      defaultPlan(),
      planReply([
        step({ type: 'warmup', title: 'Совсем новая разминка', estimatedMinutes: 4 }),
        step({ type: 'grammar', title: 'Новая грамматика', estimatedMinutes: 6 }),
        step({ type: 'speaking', title: 'Новое говорение', estimatedMinutes: 6 }),
        step({ type: 'wrapup', title: 'Новые итоги', estimatedMinutes: 4 }),
      ]),
    );

    const created = await createLesson();
    const done = created.plan.slice(0, 2).map((planStep) => planStep.id);

    markStepsCompleted(created.id, done, String(created.plan[2]?.id));

    const updated = await regeneratePlan(created.id, { keepCompletedSteps: false });

    expect(updated.plan).toHaveLength(4);
    expect(updated.plan.map((planStep) => planStep.id)).not.toContain(done[0]);
    expect(countRows('lesson_plan_steps')).toBe(4);
    expect(updated.currentStepId).toBe(updated.plan[0]?.id);
  });

  it('оставляет старый план, если модель ответила не по схеме', async () => {
    stubLlm(defaultPlan(), 'никакого JSON', 'снова никакого JSON');

    const created = await createLesson();
    const response = await app.inject({
      method: 'POST',
      url: `${LESSONS_URL}/${created.id}/plan/regenerate`,
      payload: {},
    });

    expect(response.statusCode).toBe(502);
    expect(countRows('lesson_plan_steps')).toBe(5);
    expect(stepRows(created.id).map((row) => row.title)).toEqual(
      created.plan.map((planStep) => planStep.title),
    );
  });

  it('отвечает 409 на завершённый урок', async () => {
    stubLlm(defaultPlan());

    const created = await createLesson();

    getDb().prepare(`UPDATE lessons SET status = 'completed' WHERE id = ?`).run(created.id);

    const response = await app.inject({
      method: 'POST',
      url: `${LESSONS_URL}/${created.id}/plan/regenerate`,
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(apiErrorResponseSchema.parse(response.json()).error.details).toMatchObject({
      reason: 'lesson_completed',
    });
  });

  it('отвечает 404 на неизвестный урок', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${LESSONS_URL}/no-such-lesson/plan/regenerate`,
      payload: {},
    });

    expect(response.statusCode).toBe(404);
  });
});
