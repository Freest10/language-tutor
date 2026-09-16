/**
 * Слой базы: соединение и мапперы «строка ↔ домен».
 *
 * Круговые преобразования сущностей с заполненными полями проверяет
 * `db.migrations.test.ts`; здесь — то, что вокруг них: как открывается соединение,
 * как нормализуются даты, что происходит с `undefined` и что будет,
 * если в JSON-колонке окажется мусор.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ERROR_CATEGORIES,
  type ErrorLogEntry,
  type Exercise,
  type ExerciseAttempt,
  type LearnerProfile,
  type Lesson,
  type LessonMessage,
  type LessonPlanStep,
  type LevelHistoryEntry,
  type Material,
  type MaterialChunk,
  type PlacementSession,
  type PlacementTurn,
  type VocabularyItem,
} from '@lt/shared';

import {
  closeDb,
  DEFAULT_DB_RELATIVE_PATH,
  getDb,
  IN_MEMORY_DB_PATH,
  isInMemoryPath,
  openDatabase,
  resolveDbPath,
  setDb,
  type Db,
} from '../src/db/connection.js';
import { getSchemaVersion, migrate } from '../src/db/migrate.js';
import {
  emptyErrorCountsByCategory,
  errorLogEntryToRow,
  exerciseAttemptToRow,
  exerciseToRow,
  fromSqliteBool,
  isOnboardingCompleted,
  learnerProfileToRow,
  lessonMaterialsToRows,
  lessonMessageToRow,
  lessonPlanStepToRow,
  lessonToRow,
  levelHistoryEntryToRow,
  materialChunkToRow,
  materialToRow,
  nowIso,
  placementSessionToRow,
  placementTurnToRow,
  rowsToLessonMaterialIds,
  rowToErrorLogEntry,
  rowToLearnerProfile,
  rowToLesson,
  rowToLessonMessage,
  rowToLessonPlanStep,
  rowToLevelHistoryEntry,
  rowToMaterial,
  rowToMaterialChunk,
  rowToPlacementSession,
  rowToPlacementTurn,
  rowToVocabularyItem,
  toIsoDate,
  toIsoDateTime,
  toSqliteBool,
  toVocabularyLemma,
  vocabularyItemToRow,
} from '../src/db/mappers.js';
import {
  PROFILE_ROW_ID,
  type ErrorLogRow,
  type LevelHistoryRow,
  type MaterialChunkRow,
  type MaterialRow,
  type PlacementSessionRow,
  type PlacementTurnRow,
  type ProfileRow,
  type TableName,
  type VocabularyItemRow,
} from '../src/db/rows.js';

const NOW = '2026-09-15T10:20:30.000Z';
const EARLIER = '2026-09-15T09:00:00.000Z';

/** База в памяти с актуальной схемой. */
function createMigratedDb(): Db {
  const db = openDatabase(IN_MEMORY_DB_PATH);

  migrate(db);

  return db;
}

function insertRow(db: Db, table: TableName, row: object): void {
  const columns = Object.keys(row);
  const sql =
    `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(', ')}) ` +
    `VALUES (${columns.map((column) => `@${column}`).join(', ')})`;

  db.prepare(sql).run(row);
}

function selectById<Row>(db: Db, table: TableName, id: string): Row {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;

  if (row === undefined) {
    throw new Error(`Строка ${table}.${id} не найдена`);
  }

  return row;
}

/** Материал без единого необязательного поля: все они переданы как `undefined`. */
function bareMaterial(): Material {
  return {
    id: 'material-bare',
    title: 'Без подробностей',
    sourceType: 'text',
    status: 'pending',
    statusMessage: undefined,
    originalFileName: undefined,
    mimeType: undefined,
    sizeBytes: undefined,
    language: 'de',
    level: undefined,
    charCount: 0,
    chunkCount: 0,
    pageCount: undefined,
    topics: [],
    summary: undefined,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('соединение с базой', () => {
  const originalDbPath = process.env.DB_PATH;
  const tempDirs: string[] = [];

  afterEach(() => {
    closeDb();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    if (originalDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = originalDbPath;
    }
  });

  it('отличает базу в памяти от файла на диске', () => {
    expect(isInMemoryPath(IN_MEMORY_DB_PATH)).toBe(true);
    expect(isInMemoryPath('file::memory:?cache=shared')).toBe(true);
    expect(isInMemoryPath('/var/data/app.db')).toBe(false);
    expect(isInMemoryPath('memory.db')).toBe(false);
  });

  it('без DB_PATH берёт data/app.db в корне монорепо', () => {
    delete process.env.DB_PATH;

    const path = resolveDbPath();

    expect(isAbsolute(path)).toBe(true);
    expect(path.endsWith(DEFAULT_DB_RELATIVE_PATH)).toBe(true);
    expect(path.endsWith(join('data', 'app.db'))).toBe(true);
  });

  it('пустой DB_PATH равносилен его отсутствию', () => {
    process.env.DB_PATH = '   ';

    expect(resolveDbPath().endsWith(`data${sep}app.db`)).toBe(true);
  });

  it('оставляет базу в памяти как есть, а путь к файлу делает абсолютным', () => {
    process.env.DB_PATH = IN_MEMORY_DB_PATH;
    expect(resolveDbPath()).toBe(IN_MEMORY_DB_PATH);

    process.env.DB_PATH = 'file::memory:?cache=shared';
    expect(resolveDbPath()).toBe('file::memory:?cache=shared');

    process.env.DB_PATH = join('tmp', 'custom.db');
    expect(resolveDbPath()).toBe(resolve(join('tmp', 'custom.db')));
  });

  it('включает внешние ключи для базы в памяти и не трогает журнал', () => {
    const db = openDatabase(IN_MEMORY_DB_PATH);

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('memory');
    db.close();
  });

  it('создаёт каталог файла базы и включает WAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lt-db-'));

    tempDirs.push(dir);

    const dbPath = join(dir, 'nested', 'app.db');
    const db = openDatabase(dbPath);

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(existsSync(dbPath)).toBe(true);
    db.close();
  });

  it('открывает соединение процесса один раз и сразу мигрирует его', () => {
    process.env.DB_PATH = IN_MEMORY_DB_PATH;
    closeDb();

    const db = getDb();

    expect(getSchemaVersion(db)).toBeGreaterThan(0);
    expect(db.prepare(`SELECT count(*) AS total FROM profile`).get()).toEqual({ total: 1 });
    expect(getDb()).toBe(db);
  });

  it('подмена соединения закрывает прежнее, повторная тем же — нет', () => {
    process.env.DB_PATH = IN_MEMORY_DB_PATH;
    closeDb();

    const first = getDb();
    const second = createMigratedDb();

    setDb(second);

    expect(getDb()).toBe(second);
    expect(() => first.prepare(`SELECT 1`).get()).toThrow();

    setDb(second);

    expect(second.prepare(`SELECT count(*) AS total FROM profile`).get()).toEqual({ total: 1 });
  });

  it('closeDb закрывает соединение, а следующий getDb открывает новое', () => {
    process.env.DB_PATH = IN_MEMORY_DB_PATH;
    closeDb();

    const db = getDb();

    closeDb();

    expect(() => db.prepare(`SELECT 1`).get()).toThrow();

    const reopened = getDb();

    expect(reopened).not.toBe(db);
    expect(getSchemaVersion(reopened)).toBeGreaterThan(0);

    // Повторное закрытие уже закрытого соединения безопасно.
    closeDb();
    expect(() => {
      closeDb();
    }).not.toThrow();
  });
});

describe('нормализация дат', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('приводит момент времени к UTC независимо от записи', () => {
    expect(toIsoDateTime('2026-09-15T12:20:30+02:00')).toBe(NOW);
    expect(toIsoDateTime('2026-09-15T10:20:30Z')).toBe(NOW);
    expect(toIsoDateTime(new Date(Date.UTC(2026, 8, 15, 10, 20, 30)))).toBe(NOW);
    expect(toIsoDateTime(Date.UTC(2026, 8, 15, 10, 20, 30))).toBe(NOW);
  });

  it('отказывается разбирать то, что моментом времени не является', () => {
    expect(() => toIsoDateTime('вчера')).toThrow(/вчера/);
    expect(() => toIsoDateTime('')).toThrow(/ISO-8601/);
    expect(() => toIsoDateTime(Number.NaN)).toThrow(/ISO-8601/);
    expect(() => toIsoDateTime(new Date('не дата'))).toThrow(/ISO-8601/);
  });

  it('берёт календарную дату по UTC, а не по зоне записи', () => {
    expect(toIsoDate(NOW)).toBe('2026-09-15');
    expect(toIsoDate('2026-09-16T01:30:00+03:00')).toBe('2026-09-15');
    expect(toIsoDate('2026-09-15T23:30:00-03:00')).toBe('2026-09-16');
  });

  it('nowIso отдаёт текущий момент в формате хранения', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    expect(nowIso()).toBe(NOW);
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('сортировка колонки с датами по алфавиту совпадает с хронологической', () => {
    const db = createMigratedDb();
    const written = [
      { id: 'm-1', createdAt: '2026-09-15T12:20:30+02:00' },
      { id: 'm-2', createdAt: '2026-01-02T03:04:05.678Z' },
      { id: 'm-3', createdAt: '2026-09-14T23:59:59-05:00' },
      { id: 'm-4', createdAt: '2027-03-01T00:00:00+09:00' },
    ];

    for (const item of written) {
      insertRow(
        db,
        'materials',
        materialToRow({ ...bareMaterial(), id: item.id, createdAt: item.createdAt }),
      );
    }

    const byColumn = (
      db.prepare(`SELECT id FROM materials ORDER BY created_at`).all() as { id: string }[]
    ).map((row) => row.id);
    const byTime = [...written]
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .map((item) => item.id);

    expect(byColumn).toEqual(byTime);
    expect(byColumn).toEqual(['m-2', 'm-3', 'm-1', 'm-4']);
    db.close();
  });
});

describe('логические значения', () => {
  it('переводятся в 0/1 и обратно', () => {
    expect(toSqliteBool(true)).toBe(1);
    expect(toSqliteBool(false)).toBe(0);
    expect(fromSqliteBool(1)).toBe(true);
    expect(fromSqliteBool(0)).toBe(false);
    // Любое ненулевое значение колонки — истина.
    expect(fromSqliteBool(2)).toBe(true);
  });
});

describe('undefined при записи, null при чтении', () => {
  let db: Db;

  beforeEach(() => {
    db = createMigratedDb();
  });

  afterEach(() => {
    db.close();
  });

  it('материал: все необязательные колонки становятся NULL', () => {
    const row = materialToRow(bareMaterial());

    expect(row.status_message).toBeNull();
    expect(row.original_file_name).toBeNull();
    expect(row.file_path).toBeNull();
    expect(row.mime_type).toBeNull();
    expect(row.size_bytes).toBeNull();
    expect(row.level).toBeNull();
    expect(row.page_count).toBeNull();
    expect(row.summary).toBeNull();
    expect(row.topics).toBe('[]');

    insertRow(db, 'materials', row);

    const material = rowToMaterial(selectById<MaterialRow>(db, 'materials', 'material-bare'));

    expect(material).toEqual({
      ...bareMaterial(),
      statusMessage: null,
      originalFileName: null,
      mimeType: null,
      sizeBytes: null,
      level: null,
      pageCount: null,
      summary: null,
    });
  });

  it('фрагмент материала: страница и заголовок', () => {
    const chunk: MaterialChunk = {
      id: 'chunk-bare',
      materialId: 'material-bare',
      order: 0,
      content: 'Ein Satz.',
      charCount: 9,
      page: undefined,
      heading: undefined,
      createdAt: NOW,
    };

    insertRow(db, 'materials', materialToRow(bareMaterial()));
    insertRow(db, 'material_chunks', materialChunkToRow(chunk));

    const stored = rowToMaterialChunk(
      selectById<MaterialChunkRow>(db, 'material_chunks', 'chunk-bare'),
    );

    expect(stored.page).toBeNull();
    expect(stored.heading).toBeNull();
    expect(stored.content).toBe('Ein Satz.');
  });

  it('сессия и вопрос определения уровня: незавершённые поля', () => {
    const turn: PlacementTurn = {
      id: 'turn-bare',
      sessionId: 'session-bare',
      order: 0,
      question: 'Wie heißt du?',
      questionLanguage: 'de',
      targetLevel: 'A1',
      skill: 'speaking',
      answer: undefined,
      source: undefined,
      score: undefined,
      feedback: undefined,
      estimatedLevel: undefined,
      askedAt: NOW,
      answeredAt: undefined,
    };
    const session: PlacementSession = {
      id: 'session-bare',
      status: 'in_progress',
      learningLanguage: 'de',
      explanationLanguage: 'ru',
      maxTurns: 8,
      turns: [turn],
      result: undefined,
      startedAt: EARLIER,
      completedAt: undefined,
      createdAt: EARLIER,
      updatedAt: NOW,
    };

    insertRow(db, 'placement_sessions', placementSessionToRow(session));
    insertRow(db, 'placement_turns', placementTurnToRow(turn));

    const storedTurn = rowToPlacementTurn(
      selectById<PlacementTurnRow>(db, 'placement_turns', 'turn-bare'),
    );
    const storedSession = rowToPlacementSession(
      selectById<PlacementSessionRow>(db, 'placement_sessions', 'session-bare'),
    );

    expect(storedTurn).toEqual({
      ...turn,
      answer: null,
      source: null,
      score: null,
      feedback: null,
      estimatedLevel: null,
      answeredAt: null,
    });
    expect(storedSession.result).toBeNull();
    expect(storedSession.completedAt).toBeNull();
    // Вопросы приходят отдельным запросом: без них список пуст, а не undefined.
    expect(storedSession.turns).toEqual([]);
  });

  it('урок, шаг плана, реплика, задание и попытка', () => {
    const step: LessonPlanStep = {
      id: 'step-bare',
      lessonId: 'lesson-bare',
      order: 0,
      type: 'speaking',
      title: 'Разговор',
      objectives: [],
      targetItems: [],
      instructions: 'Поговори о погоде.',
      estimatedMinutes: 5,
      status: 'pending',
      materialChunkIds: [],
      exerciseIds: [],
      startedAt: undefined,
      completedAt: undefined,
    };
    const lesson: Lesson = {
      id: 'lesson-bare',
      title: 'Погода',
      status: 'draft',
      learningLanguage: 'de',
      explanationLanguage: 'ru',
      level: 'A1',
      topic: undefined,
      goals: [],
      materialIds: [],
      plan: [step],
      currentStepId: undefined,
      plannedMinutes: 15,
      summary: undefined,
      startedAt: undefined,
      completedAt: undefined,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const message: LessonMessage = {
      id: 'message-bare',
      lessonId: lesson.id,
      stepId: undefined,
      role: 'tutor',
      source: 'text',
      content: 'Wie ist das Wetter?',
      language: undefined,
      corrections: [],
      audioPath: undefined,
      durationMs: undefined,
      createdAt: NOW,
    };
    const exercise: Exercise = {
      id: 'exercise-bare',
      lessonId: lesson.id,
      stepId: undefined,
      order: 0,
      type: 'free_speech',
      prompt: 'Опиши погоду.',
      instructions: undefined,
      options: [],
      expectedAnswer: undefined,
      acceptableAnswers: [],
      hints: [],
      targetItems: [],
      level: undefined,
      createdAt: NOW,
    };
    const attempt: ExerciseAttempt = {
      id: 'attempt-bare',
      exerciseId: exercise.id,
      lessonId: lesson.id,
      stepId: undefined,
      answer: 'Es regnet.',
      source: 'text',
      isCorrect: true,
      score: 1,
      corrections: [],
      feedback: 'Верно.',
      durationMs: undefined,
      createdAt: NOW,
    };

    insertRow(db, 'lessons', lessonToRow(lesson));
    insertRow(db, 'lesson_plan_steps', lessonPlanStepToRow(step));
    insertRow(db, 'lesson_messages', lessonMessageToRow(message));
    insertRow(db, 'exercises', exerciseToRow(exercise));
    insertRow(db, 'exercise_attempts', exerciseAttemptToRow(attempt));

    const storedStep = rowToLessonPlanStep(
      db.prepare(`SELECT * FROM lesson_plan_steps WHERE id = ?`).get(step.id) as never,
    );
    const storedLesson = rowToLesson(
      db.prepare(`SELECT * FROM lessons WHERE id = ?`).get(lesson.id) as never,
      { materialIds: [], plan: [storedStep] },
    );
    const storedMessage = rowToLessonMessage(
      db.prepare(`SELECT * FROM lesson_messages WHERE id = ?`).get(message.id) as never,
    );

    expect(storedLesson.topic).toBeNull();
    expect(storedLesson.currentStepId).toBeNull();
    expect(storedLesson.summary).toBeNull();
    expect(storedLesson.startedAt).toBeNull();
    expect(storedLesson.completedAt).toBeNull();
    expect(storedLesson.goals).toEqual([]);
    expect(storedStep.startedAt).toBeNull();
    expect(storedStep.completedAt).toBeNull();
    expect(storedStep.materialChunkIds).toEqual([]);
    expect(storedMessage.stepId).toBeNull();
    expect(storedMessage.language).toBeNull();
    expect(storedMessage.audioPath).toBeNull();
    expect(storedMessage.durationMs).toBeNull();
    expect(storedMessage.corrections).toEqual([]);

    const exerciseRow = exerciseToRow(exercise);
    const attemptRow = exerciseAttemptToRow(attempt);

    expect(exerciseRow.step_id).toBeNull();
    expect(exerciseRow.instructions).toBeNull();
    expect(exerciseRow.expected_answer).toBeNull();
    expect(exerciseRow.level).toBeNull();
    expect(attemptRow.step_id).toBeNull();
    expect(attemptRow.duration_ms).toBeNull();
    expect(attemptRow.is_correct).toBe(1);
  });

  it('слово словаря, запись журнала ошибок и запись истории уровня', () => {
    const word: VocabularyItem = {
      id: 'word-bare',
      term: 'Regen',
      translation: 'дождь',
      language: 'de',
      translationLanguage: 'ru',
      partOfSpeech: undefined,
      transcription: undefined,
      example: undefined,
      level: undefined,
      status: 'new',
      timesSeen: 0,
      timesCorrect: 0,
      lessonId: undefined,
      materialId: undefined,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const errorEntry: ErrorLogEntry = {
      id: 'error-bare',
      category: 'spelling',
      severity: 'minor',
      original: 'regen',
      corrected: 'Regen',
      explanation: 'Существительные пишутся с большой буквы.',
      targetItem: undefined,
      language: 'de',
      lessonId: undefined,
      stepId: undefined,
      exerciseId: undefined,
      messageId: undefined,
      occurredAt: NOW,
      createdAt: NOW,
    };
    const levelEntry: LevelHistoryEntry = {
      id: 'level-bare',
      fromLevel: undefined,
      toLevel: 'A1',
      direction: 'initial',
      source: 'placement',
      confidence: 0.6,
      reason: 'Первое определение уровня.',
      metrics: {
        accuracy: 0.6,
        lessonsConsidered: 0,
        lessonsSinceLastChange: 0,
        exercisesEvaluated: 0,
        windowFrom: EARLIER,
        windowTo: NOW,
      },
      changedAt: NOW,
      createdAt: NOW,
    };

    insertRow(db, 'vocabulary_items', vocabularyItemToRow(word));
    insertRow(db, 'error_log', errorLogEntryToRow(errorEntry));
    insertRow(db, 'level_history', levelHistoryEntryToRow(levelEntry));

    const storedWord = rowToVocabularyItem(
      selectById<VocabularyItemRow>(db, 'vocabulary_items', word.id),
    );
    const storedError = rowToErrorLogEntry(selectById<ErrorLogRow>(db, 'error_log', errorEntry.id));
    const storedLevel = rowToLevelHistoryEntry(
      selectById<LevelHistoryRow>(db, 'level_history', levelEntry.id),
    );

    expect(storedWord).toEqual({
      ...word,
      partOfSpeech: null,
      transcription: null,
      example: null,
      level: null,
      lessonId: null,
      materialId: null,
    });
    expect(storedError).toEqual({
      ...errorEntry,
      targetItem: null,
      lessonId: null,
      stepId: null,
      exerciseId: null,
      messageId: null,
    });
    expect(storedLevel).toEqual({ ...levelEntry, fromLevel: null });
  });
});

describe('JSON в колонках', () => {
  let db: Db;

  beforeEach(() => {
    db = createMigratedDb();
    insertRow(db, 'materials', materialToRow(bareMaterial()));
  });

  afterEach(() => {
    db.close();
  });

  it('сообщает имя колонки, когда JSON повреждён', () => {
    db.prepare(`UPDATE materials SET topics = ? WHERE id = ?`).run('{сломано', 'material-bare');

    const row = selectById<MaterialRow>(db, 'materials', 'material-bare');

    expect(() => rowToMaterial(row)).toThrow(/materials\.topics/);
    expect(() => rowToMaterial(row)).toThrow(/не удалось разобрать JSON/);
  });

  it('сохраняет исходную причину разбора в cause', () => {
    db.prepare(`UPDATE materials SET topics = ? WHERE id = ?`).run('nope', 'material-bare');

    let caught: unknown;

    try {
      rowToMaterial(selectById<MaterialRow>(db, 'materials', 'material-bare'));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it('не принимает JSON не того вида вместо массива', () => {
    db.prepare(`UPDATE materials SET topics = ? WHERE id = ?`).run('{"a":1}', 'material-bare');
    expect(() => rowToMaterial(selectById<MaterialRow>(db, 'materials', 'material-bare'))).toThrow(
      /materials\.topics: ожидался JSON-массив/,
    );

    db.prepare(`UPDATE materials SET topics = ? WHERE id = ?`).run('null', 'material-bare');
    expect(() => rowToMaterial(selectById<MaterialRow>(db, 'materials', 'material-bare'))).toThrow(
      /ожидался JSON-массив/,
    );
  });

  it('не принимает JSON не того вида вместо объекта', () => {
    const entry: LevelHistoryEntry = {
      id: 'level-json',
      fromLevel: 'A1',
      toLevel: 'A2',
      direction: 'up',
      source: 'progress',
      confidence: 0.8,
      reason: 'Достаточно верных ответов.',
      metrics: {
        accuracy: 0.9,
        lessonsConsidered: 3,
        lessonsSinceLastChange: 4,
        exercisesEvaluated: 24,
        windowFrom: EARLIER,
        windowTo: NOW,
      },
      changedAt: NOW,
      createdAt: NOW,
    };

    insertRow(db, 'level_history', levelHistoryEntryToRow(entry));
    db.prepare(`UPDATE level_history SET metrics = ? WHERE id = ?`).run('[1,2]', entry.id);

    expect(() =>
      rowToLevelHistoryEntry(selectById<LevelHistoryRow>(db, 'level_history', entry.id)),
    ).toThrow(/level_history\.metrics: ожидался JSON-объект/);

    db.prepare(`UPDATE level_history SET metrics = ? WHERE id = ?`).run('null', entry.id);
    expect(() =>
      rowToLevelHistoryEntry(selectById<LevelHistoryRow>(db, 'level_history', entry.id)),
    ).toThrow(/ожидался JSON-объект/);
  });

  it('называет колонку профиля при повреждённом JSON целей', () => {
    db.prepare(`UPDATE profile SET goals = ? WHERE id = ?`).run('[неполный', PROFILE_ROW_ID);

    expect(() =>
      rowToLearnerProfile(selectById<ProfileRow>(db, 'profile', PROFILE_ROW_ID)),
    ).toThrow(/profile\.goals/);
  });

  it('хранит пустые коллекции как [] и переживает вложенные объекты', () => {
    const row = materialToRow({ ...bareMaterial(), id: 'material-json', topics: [] });

    expect(row.topics).toBe('[]');

    insertRow(db, 'materials', row);
    expect(rowToMaterial(selectById<MaterialRow>(db, 'materials', 'material-json')).topics).toEqual(
      [],
    );

    const lesson: Lesson = {
      id: 'lesson-json',
      title: 'Итог',
      status: 'completed',
      learningLanguage: 'de',
      explanationLanguage: 'ru',
      level: 'A2',
      topic: 'погода',
      goals: ['рассказать о погоде'],
      materialIds: [],
      plan: [],
      currentStepId: null,
      plannedMinutes: 20,
      summary: {
        text: 'Хороший урок.',
        strengths: ['лексика'],
        weaknesses: ['артикли'],
        recommendations: ['повторить падежи'],
        newVocabulary: ['der Regen'],
        exercisesTotal: 4,
        exercisesCorrect: 3,
        accuracy: 0.75,
        durationMinutes: 18,
      },
      startedAt: EARLIER,
      completedAt: NOW,
      createdAt: EARLIER,
      updatedAt: NOW,
    };

    insertRow(db, 'lessons', lessonToRow(lesson));

    const stored = rowToLesson(
      db.prepare(`SELECT * FROM lessons WHERE id = ?`).get(lesson.id) as never,
      { materialIds: [], plan: [] },
    );

    expect(stored.summary).toEqual(lesson.summary);
  });
});

describe('профиль', () => {
  let db: Db;

  beforeEach(() => {
    db = createMigratedDb();
  });

  afterEach(() => {
    db.close();
  });

  const profile: LearnerProfile = {
    id: PROFILE_ROW_ID,
    learningLanguage: 'de',
    interfaceLanguage: 'ru',
    explanationLanguage: 'ru',
    level: 'A2',
    levelConfidence: 0.7,
    goals: ['заказать кофе'],
    interests: ['путешествия'],
    dailyMinutes: 25,
    placementCompletedAt: NOW,
    createdAt: EARLIER,
    updatedAt: NOW,
  };

  /** Перезаписывает единственную строку профиля. */
  function saveProfile(row: ProfileRow): void {
    db.prepare(`DELETE FROM profile`).run();
    insertRow(db, 'profile', row);
  }

  it('переживает круговое преобразование через базу', () => {
    saveProfile(learnerProfileToRow(profile));

    expect(rowToLearnerProfile(selectById<ProfileRow>(db, 'profile', PROFILE_ROW_ID))).toEqual(
      profile,
    );
  });

  it('считает онбординг пройденным, если уровень определён', () => {
    const row = learnerProfileToRow(profile);

    expect(row.onboarding_completed).toBe(1);
    saveProfile(row);
    expect(isOnboardingCompleted(selectById<ProfileRow>(db, 'profile', PROFILE_ROW_ID))).toBe(true);
  });

  it('без завершённого определения уровня онбординг не пройден', () => {
    const row = learnerProfileToRow({ ...profile, placementCompletedAt: undefined });

    expect(row.onboarding_completed).toBe(0);
    expect(row.placement_completed_at).toBeNull();
    saveProfile(row);

    const stored = selectById<ProfileRow>(db, 'profile', PROFILE_ROW_ID);

    expect(isOnboardingCompleted(stored)).toBe(false);
    expect(rowToLearnerProfile(stored).placementCompletedAt).toBeNull();
  });

  it('явный признак онбординга важнее выведенного', () => {
    expect(
      learnerProfileToRow({ ...profile, placementCompletedAt: null }, { onboardingCompleted: true })
        .onboarding_completed,
    ).toBe(1);
    expect(learnerProfileToRow(profile, { onboardingCompleted: false }).onboarding_completed).toBe(
      0,
    );
  });

  it('нормализует даты профиля к UTC', () => {
    const row = learnerProfileToRow({
      ...profile,
      placementCompletedAt: '2026-09-15T12:20:30+02:00',
      createdAt: '2026-09-15T11:00:00+02:00',
      updatedAt: '2026-09-15T12:20:30+02:00',
    });

    expect(row.placement_completed_at).toBe(NOW);
    expect(row.created_at).toBe(EARLIER);
    expect(row.updated_at).toBe(NOW);
  });
});

describe('материалы урока', () => {
  it('нумеруются порядком в массиве и читаются в том же порядке', () => {
    const rows = lessonMaterialsToRows('lesson-1', ['material-b', 'material-a'], NOW);

    expect(rows).toEqual([
      { lesson_id: 'lesson-1', material_id: 'material-b', order: 0, created_at: NOW },
      { lesson_id: 'lesson-1', material_id: 'material-a', order: 1, created_at: NOW },
    ]);
    expect(rowsToLessonMaterialIds(rows)).toEqual(['material-b', 'material-a']);
  });

  it('восстанавливает порядок из колонки, не трогая исходный массив', () => {
    const shuffled = [
      { lesson_id: 'lesson-1', material_id: 'c', order: 2, created_at: NOW },
      { lesson_id: 'lesson-1', material_id: 'a', order: 0, created_at: NOW },
      { lesson_id: 'lesson-1', material_id: 'b', order: 1, created_at: NOW },
    ];
    const snapshot = [...shuffled];

    expect(rowsToLessonMaterialIds(shuffled)).toEqual(['a', 'b', 'c']);
    expect(shuffled).toEqual(snapshot);
  });

  it('пустой список материалов даёт пустой результат', () => {
    expect(lessonMaterialsToRows('lesson-1', [])).toEqual([]);
    expect(rowsToLessonMaterialIds([])).toEqual([]);
  });

  it('по умолчанию проставляет текущий момент', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    expect(lessonMaterialsToRows('lesson-1', ['material-a'])[0]?.created_at).toBe(NOW);

    vi.useRealTimers();
  });
});

describe('лемма словаря', () => {
  it('схлопывает регистр и обрамляющие пробелы', () => {
    expect(toVocabularyLemma('Kaffee')).toBe('kaffee');
    expect(toVocabularyLemma('  KAFFEE  ')).toBe('kaffee');
    expect(toVocabularyLemma('\tkaffee\n')).toBe('kaffee');
  });

  it('даёт один ключ для разных написаний одного слова', () => {
    const variants = ['Kaffee', 'kaffee', ' Kaffee ', 'KAFFEE'];

    expect(new Set(variants.map(toVocabularyLemma)).size).toBe(1);
  });

  it('не склеивает разные слова и сохраняет внутренние пробелы', () => {
    expect(toVocabularyLemma('der Kaffee')).toBe('der kaffee');
    expect(toVocabularyLemma('Tee')).not.toBe(toVocabularyLemma('Kaffee'));
  });

  it('вычисляется из term при записи слова', () => {
    const row = vocabularyItemToRow({
      id: 'word-lemma',
      term: '  Der Regen  ',
      translation: 'дождь',
      language: 'de',
      translationLanguage: 'ru',
      partOfSpeech: null,
      transcription: null,
      example: null,
      level: null,
      status: 'new',
      timesSeen: 0,
      timesCorrect: 0,
      lessonId: null,
      materialId: null,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(row.lemma).toBe('der regen');
    // Исходное написание сохраняется как есть: пользователю показывается его вариант.
    expect(row.term).toBe('  Der Regen  ');
  });
});

describe('счётчики ошибок по категориям', () => {
  it('перечисляют все категории и начинаются с нуля', () => {
    const counts = emptyErrorCountsByCategory();

    expect(ERROR_CATEGORIES).toHaveLength(5);
    expect(Object.keys(counts).sort()).toEqual([...ERROR_CATEGORIES].sort());
    expect(Object.values(counts)).toEqual([0, 0, 0, 0, 0]);
  });

  it('каждый вызов даёт независимый объект', () => {
    const first = emptyErrorCountsByCategory();

    first.grammar += 3;

    expect(emptyErrorCountsByCategory().grammar).toBe(0);
    expect(first.grammar).toBe(3);
  });
});
