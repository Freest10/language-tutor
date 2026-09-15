import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  API_PREFIX,
  apiErrorResponseSchema,
  getProfileResponseSchema,
  levelHistoryEntrySchema,
  type LearnerProfile,
} from '@lt/shared';

import { buildApp } from '../src/app.js';
import { closeDb, getDb, IN_MEMORY_DB_PATH, openDatabase, setDb } from '../src/db/connection.js';
import { rowToLevelHistoryEntry } from '../src/db/mappers.js';
import { migrate } from '../src/db/migrate.js';
import { PROFILE_ROW_ID, type LevelHistoryRow } from '../src/db/rows.js';
import { getProfile, getProfileForPrompt } from '../src/services/profileService.js';

const PROFILE_URL = `${API_PREFIX}/profile`;

let app: FastifyInstance;

/** Все записи истории уровня в порядке добавления. */
function levelHistoryRows(): LevelHistoryRow[] {
  return getDb()
    .prepare('SELECT * FROM level_history ORDER BY changed_at')
    .all() as LevelHistoryRow[];
}

/** Профиль после ответа сервера: читается заново, чтобы проверить сохранение. */
async function fetchProfile(): Promise<LearnerProfile> {
  const response = await app.inject({ method: 'GET', url: PROFILE_URL });

  expect(response.statusCode).toBe(200);

  return getProfileResponseSchema.parse(response.json());
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
});

describe('GET /api/profile', () => {
  it('отдаёт профиль-заготовку на свежей базе', async () => {
    const profile = await fetchProfile();

    expect(profile.id).toBe(PROFILE_ROW_ID);
    expect(profile.learningLanguage).toBe('en');
    expect(profile.interfaceLanguage).toBe('ru');
    expect(profile.explanationLanguage).toBe('ru');
    expect(profile.level).toBe('A1');
    expect(profile.levelConfidence).toBe(0);
    expect(profile.goals.length).toBeGreaterThan(0);
    expect(profile.interests).toEqual([]);
    expect(profile.dailyMinutes).toBe(20);
    expect(profile.placementCompletedAt).toBeNull();
  });

  it('пересоздаёт профиль, если строку удалили в обход приложения', async () => {
    getDb().prepare('DELETE FROM profile').run();

    const profile = await fetchProfile();

    expect(profile.id).toBe(PROFILE_ROW_ID);
    expect(profile.goals.length).toBeGreaterThan(0);
  });
});

describe('PUT /api/profile', () => {
  it('сохраняет цели и интересы, они переживают повторный GET', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: PROFILE_URL,
      payload: {
        goals: ['Заказать кофе в кафе', 'Пройти собеседование'],
        interests: ['путешествия', 'кино'],
      },
    });

    expect(response.statusCode).toBe(200);

    const updated = getProfileResponseSchema.parse(response.json());

    expect(updated.goals).toEqual(['Заказать кофе в кафе', 'Пройти собеседование']);

    const reloaded = await fetchProfile();

    expect(reloaded.goals).toEqual(['Заказать кофе в кафе', 'Пройти собеседование']);
    expect(reloaded.interests).toEqual(['путешествия', 'кино']);
  });

  it('обновляет дневную норму и язык интерфейса', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: PROFILE_URL,
      payload: { dailyMinutes: 45, interfaceLanguage: 'en' },
    });

    expect(response.statusCode).toBe(200);

    const reloaded = await fetchProfile();

    expect(reloaded.dailyMinutes).toBe(45);
    expect(reloaded.interfaceLanguage).toBe('en');
  });

  it('принимает любой язык из списка пресетов, не только английский', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: PROFILE_URL,
      payload: { learningLanguage: 'de' },
    });

    expect(response.statusCode).toBe(200);
    expect((await fetchProfile()).learningLanguage).toBe('de');
  });

  it('пишет ручную смену уровня в историю с обоснованием и метриками', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: PROFILE_URL,
      payload: { level: 'B1' },
    });

    expect(response.statusCode).toBe(200);
    expect(getProfileResponseSchema.parse(response.json()).level).toBe('B1');

    const rows = levelHistoryRows();

    expect(rows).toHaveLength(1);

    const entry = levelHistoryEntrySchema.parse(rowToLevelHistoryEntry(rows[0] as LevelHistoryRow));

    expect(entry.source).toBe('manual');
    expect(entry.toLevel).toBe('B1');
    expect(entry.reason.length).toBeGreaterThan(0);
    expect(entry.metrics.exercisesEvaluated).toBe(0);
    expect((await fetchProfile()).level).toBe('B1');
  });

  it('помечает первую запись истории как первичную установку уровня', async () => {
    await app.inject({ method: 'PUT', url: PROFILE_URL, payload: { level: 'B1' } });
    await app.inject({ method: 'PUT', url: PROFILE_URL, payload: { level: 'A2' } });

    const entries = levelHistoryRows().map((row) => rowToLevelHistoryEntry(row));

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ direction: 'initial', fromLevel: null, toLevel: 'B1' });
    expect(entries[1]).toMatchObject({ direction: 'down', fromLevel: 'B1', toLevel: 'A2' });
  });

  it('не пишет историю, если уровень не изменился', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: PROFILE_URL,
      payload: { level: 'A1', dailyMinutes: 30 },
    });

    expect(response.statusCode).toBe(200);
    expect(levelHistoryRows()).toHaveLength(0);
  });

  it('сбрасывает уверенность и признак пройденного placement при смене изучаемого языка', async () => {
    getDb()
      .prepare(
        `UPDATE profile
            SET level = 'B2', level_confidence = 0.8,
                placement_completed_at = '2026-09-15T10:20:30.000Z'
          WHERE id = ?`,
      )
      .run(PROFILE_ROW_ID);

    const response = await app.inject({
      method: 'PUT',
      url: PROFILE_URL,
      payload: { learningLanguage: 'es' },
    });

    expect(response.statusCode).toBe(200);

    const reloaded = await fetchProfile();

    expect(reloaded.learningLanguage).toBe('es');
    expect(reloaded.levelConfidence).toBe(0);
    expect(reloaded.placementCompletedAt).toBeNull();
    // Уровень без нового измерения не сбрасывается.
    expect(reloaded.level).toBe('B2');
  });

  it('отвечает 400 на недопустимый уровень CEFR', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: PROFILE_URL,
      payload: { level: 'B3' },
    });

    expect(response.statusCode).toBe(400);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('validation_error');
    expect(body.error.details).toMatchObject({ source: 'body' });
  });

  it('отвечает 400 на язык вне списка пресетов', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: PROFILE_URL,
      payload: { learningLanguage: 'zz' },
    });

    expect(response.statusCode).toBe(400);

    const body = apiErrorResponseSchema.parse(response.json());

    expect(body.error.code).toBe('bad_request');
    expect(body.error.details).toMatchObject({
      reason: 'unsupported_language',
      field: 'learningLanguage',
      value: 'zz',
    });
    expect((await fetchProfile()).learningLanguage).toBe('en');
  });

  it('отвечает 400 на пустое тело', async () => {
    const response = await app.inject({ method: 'PUT', url: PROFILE_URL, payload: {} });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });

  it('отвечает 400 на дневную норму вне допустимых границ', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: PROFILE_URL,
      payload: { dailyMinutes: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe('validation_error');
  });
});

describe('getProfileForPrompt', () => {
  it('содержит уровень, цели, интересы и оба языка', async () => {
    await app.inject({
      method: 'PUT',
      url: PROFILE_URL,
      payload: {
        learningLanguage: 'de',
        explanationLanguage: 'ru',
        level: 'A2',
        goals: ['Заказать кофе в кафе'],
        interests: ['путешествия'],
      },
    });

    const prompt = getProfileForPrompt();

    expect(prompt).toContain('German (de)');
    expect(prompt).toContain('Russian (ru)');
    expect(prompt).toContain('A2');
    expect(prompt).toContain('Заказать кофе в кафе');
    expect(prompt).toContain('путешествия');
  });

  it('принимает профиль аргументом и помечает пустой список интересов', () => {
    const prompt = getProfileForPrompt(getProfile());

    expect(prompt).toContain('English (en)');
    expect(prompt).toContain('- Interests: not specified');
    expect(prompt).toContain('placement not completed');
  });
});
