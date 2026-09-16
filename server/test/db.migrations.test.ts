import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  errorLogEntrySchema,
  exerciseAttemptSchema,
  exerciseSchema,
  getProfileResponseSchema,
  lessonMessageSchema,
  lessonSchema,
  levelHistoryEntrySchema,
  materialChunkSchema,
  materialSchema,
  placementSessionSchema,
  vocabularyItemSchema,
  type ErrorLogEntry,
  type Exercise,
  type ExerciseAttempt,
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

import { IN_MEMORY_DB_PATH, openDatabase, type Db } from '../src/db/connection.js';
import { getSchemaVersion, loadMigrations, migrate } from '../src/db/migrate.js';
import {
  errorLogEntryToRow,
  exerciseAttemptToRow,
  exerciseToRow,
  lessonMaterialsToRows,
  lessonMessageToRow,
  lessonPlanStepToRow,
  lessonToRow,
  levelHistoryEntryToRow,
  materialChunkToRow,
  materialToRow,
  placementSessionToRow,
  placementTurnToRow,
  rowToErrorLogEntry,
  rowToExercise,
  rowToExerciseAttempt,
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
  vocabularyItemToRow,
} from '../src/db/mappers.js';
import {
  PROFILE_ROW_ID,
  TABLES,
  type ErrorLogRow,
  type ExerciseAttemptRow,
  type ExerciseRow,
  type LessonMessageRow,
  type LessonPlanStepRow,
  type LessonRow,
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

/** Обязательные индексы из ТЗ пакета плюс те, что гасят полные сканы при каскадах. */
const REQUIRED_INDEXES = [
  'idx_material_chunks_material_id',
  'idx_lesson_messages_lesson_id',
  'idx_lesson_plan_steps_lesson_id_order',
  'idx_vocabulary_items_language_lemma',
  'idx_error_log_lesson_id',
];

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

function countRows(db: Db, table: TableName, where = '1 = 1', ...params: unknown[]): number {
  const row = db
    .prepare(`SELECT count(*) AS total FROM ${table} WHERE ${where}`)
    .get(...params) as { total: number };

  return row.total;
}

describe('миграции', () => {
  let db: Db;

  beforeAll(() => {
    db = createMigratedDb();
  });

  afterAll(() => {
    db.close();
  });

  it('находит файлы миграций и нумерует их с 001', () => {
    const migrations = loadMigrations();

    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]?.version).toBe(1);
    expect(migrations[0]?.name).toBe('001_init.sql');
  });

  it('поднимает версию схемы до последней миграции', () => {
    expect(getSchemaVersion(db)).toBe(loadMigrations().at(-1)?.version);
  });

  it('создаёт все таблицы схемы', () => {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[];
    const names = tables.map((table) => table.name);

    expect(TABLES).toHaveLength(14);
    for (const table of TABLES) {
      expect(names).toContain(table);
    }
  });

  it('создаёт обязательные индексы', () => {
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as {
      name: string;
    }[];
    const names = indexes.map((index) => index.name);

    for (const index of REQUIRED_INDEXES) {
      expect(names).toContain(index);
    }
  });

  it('включает проверку внешних ключей', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('повторный прогон ничего не применяет', () => {
    const versionBefore = getSchemaVersion(db);
    const result = migrate(db);

    expect(result.applied).toEqual([]);
    expect(result.from).toBe(versionBefore);
    expect(result.to).toBe(versionBefore);
    expect(countRows(db, 'profile')).toBe(1);
  });
});

describe('строка профиля', () => {
  let db: Db;

  beforeAll(() => {
    db = createMigratedDb();
  });

  afterAll(() => {
    db.close();
  });

  it('создаётся миграцией в единственном экземпляре', () => {
    expect(countRows(db, 'profile')).toBe(1);

    const row = selectById<ProfileRow>(db, 'profile', PROFILE_ROW_ID);

    expect(row.onboarding_completed).toBe(0);
    expect(row.placement_completed_at).toBeNull();
  });

  it('запрещает вторую строку профиля', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO profile (id, learning_language, interface_language,
        explanation_language, level, created_at, updated_at)
        VALUES ('2', 'en', 'ru', 'ru', 'A1', ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow();
  });

  it('проходит контракт GET /api/profile', () => {
    const profile = rowToLearnerProfile(selectById<ProfileRow>(db, 'profile', PROFILE_ROW_ID));
    const parsed = getProfileResponseSchema.parse(profile);

    expect(parsed.id).toBe(PROFILE_ROW_ID);
    expect(parsed.goals.length).toBeGreaterThan(0);
    expect(parsed.level).toBe('A1');
    expect(parsed.placementCompletedAt).toBeNull();
  });
});

describe('каскадное удаление', () => {
  let db: Db;

  // Граф пересобирается перед каждым тестом: пока база жила на весь describe и
  // мутировалась по очереди, проверки зависели от порядка тестов — после
  // удаления урока проверка «журнал ошибок пережил удаление» стала бы
  // тривиально истинной просто потому, что удалять было уже нечего.
  beforeEach(() => {
    db = createMigratedDb();
    seedGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  it('удаляет фрагменты вместе с материалом', () => {
    insertRow(
      db,
      'material_chunks',
      materialChunkToRow({ ...chunkFixture, id: 'chunk-2', order: 1 }),
    );
    expect(countRows(db, 'material_chunks', 'material_id = ?', materialFixture.id)).toBe(2);

    db.prepare(`DELETE FROM materials WHERE id = ?`).run(materialFixture.id);

    expect(countRows(db, 'materials', 'id = ?', materialFixture.id)).toBe(0);
    expect(countRows(db, 'material_chunks', 'material_id = ?', materialFixture.id)).toBe(0);
    // Связь урока с материалом тоже уходит, а словарь остаётся с материалом в NULL.
    expect(countRows(db, 'lesson_materials', 'material_id = ?', materialFixture.id)).toBe(0);
    expect(countRows(db, 'vocabulary_items', 'id = ?', vocabularyFixture.id)).toBe(1);
  });

  it('удаляет шаги, реплики, задания и попытки вместе с уроком', () => {
    // Урок на месте вместе со всем, что на него ссылается: удаление ниже — это
    // именно каскад, а не удаление уже пустых таблиц.
    expect(countRows(db, 'lesson_plan_steps', 'lesson_id = ?', lessonFixture.id)).toBe(1);
    expect(countRows(db, 'lesson_messages', 'lesson_id = ?', lessonFixture.id)).toBe(1);
    expect(countRows(db, 'exercises', 'lesson_id = ?', lessonFixture.id)).toBe(1);
    expect(countRows(db, 'exercise_attempts', 'lesson_id = ?', lessonFixture.id)).toBe(1);
    expect(countRows(db, 'error_log', 'lesson_id = ?', lessonFixture.id)).toBe(1);

    db.prepare(`DELETE FROM lessons WHERE id = ?`).run(lessonFixture.id);

    expect(countRows(db, 'lesson_plan_steps', 'lesson_id = ?', lessonFixture.id)).toBe(0);
    expect(countRows(db, 'lesson_messages', 'lesson_id = ?', lessonFixture.id)).toBe(0);
    expect(countRows(db, 'exercises', 'lesson_id = ?', lessonFixture.id)).toBe(0);
    expect(countRows(db, 'exercise_attempts', 'lesson_id = ?', lessonFixture.id)).toBe(0);
    // Журнал ошибок переживает удаление урока: ссылки гасятся в NULL.
    expect(countRows(db, 'error_log', 'lesson_id IS NULL')).toBe(1);
  });

  it('удаляет вопросы вместе с сессией определения уровня', () => {
    expect(countRows(db, 'placement_turns', 'session_id = ?', placementSessionFixture.id)).toBe(1);

    db.prepare(`DELETE FROM placement_sessions WHERE id = ?`).run(placementSessionFixture.id);

    expect(countRows(db, 'placement_turns', 'session_id = ?', placementSessionFixture.id)).toBe(0);
  });

  it('не даёт сослаться на несуществующий урок', () => {
    // Урок называется явно и заведомо отсутствует: раньше проверка держалась на
    // том, что урок удалил предыдущий тест, и от перестановки тестов ломалась.
    expect(() =>
      insertRow(
        db,
        'lesson_messages',
        lessonMessageToRow({ ...messageFixture, id: 'message-2', lessonId: 'lesson-которого-нет' }),
      ),
    ).toThrow();
  });
});

const materialFixture: Material = {
  id: 'material-1',
  title: 'Deutsch im Café',
  sourceType: 'pdf',
  status: 'ready',
  statusMessage: null,
  originalFileName: 'cafe.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 20480,
  language: 'de',
  level: 'A2',
  charCount: 120,
  chunkCount: 1,
  coveredChunkCount: 0,
  pageCount: 2,
  topics: ['кафе', 'заказ'],
  summary: 'Диалоги в кафе.',
  createdAt: NOW,
  updatedAt: NOW,
};

const chunkFixture: MaterialChunk = {
  id: 'chunk-1',
  materialId: materialFixture.id,
  order: 0,
  content: 'Ich möchte einen Kaffee, bitte.',
  charCount: 30,
  page: 1,
  heading: 'Im Café',
  createdAt: NOW,
};

const planStepFixture: LessonPlanStep = {
  id: 'step-1',
  lessonId: 'lesson-1',
  order: 0,
  type: 'speaking',
  title: 'Диалог в кафе',
  objectives: ['заказать напиток'],
  targetItems: ['ich möchte'],
  instructions: 'Разыграй диалог с бариста и поправь ошибки в артиклях.',
  estimatedMinutes: 7,
  status: 'in_progress',
  materialChunkIds: [chunkFixture.id],
  exerciseIds: ['exercise-1'],
  startedAt: NOW,
  completedAt: null,
};

const lessonFixture: Lesson = {
  id: 'lesson-1',
  title: 'Заказ в кафе',
  status: 'in_progress',
  learningLanguage: 'de',
  explanationLanguage: 'ru',
  level: 'A2',
  topic: 'кафе',
  goals: ['заказать кофе'],
  materialIds: [materialFixture.id],
  plan: [planStepFixture],
  currentStepId: planStepFixture.id,
  plannedMinutes: 20,
  summary: null,
  startedAt: NOW,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const exerciseFixture: Exercise = {
  id: 'exercise-1',
  lessonId: lessonFixture.id,
  stepId: planStepFixture.id,
  order: 0,
  type: 'translate',
  prompt: 'Переведи: я хотел бы кофе',
  instructions: null,
  options: [],
  expectedAnswer: 'Ich möchte einen Kaffee',
  acceptableAnswers: ['Ich hätte gern einen Kaffee'],
  hints: ['möchte'],
  targetItems: ['möchten'],
  level: 'A2',
  createdAt: NOW,
};

const attemptFixture: ExerciseAttempt = {
  id: 'attempt-1',
  exerciseId: exerciseFixture.id,
  lessonId: lessonFixture.id,
  stepId: planStepFixture.id,
  answer: 'Ich möchte ein Kaffee',
  source: 'voice',
  isCorrect: false,
  score: 0.5,
  corrections: [
    {
      category: 'grammar',
      severity: 'major',
      original: 'ein Kaffee',
      corrected: 'einen Kaffee',
      explanation: 'После möchte нужен винительный падеж: einen Kaffee.',
      targetItem: 'einen',
    },
  ],
  feedback: 'Почти верно: поправь артикль.',
  durationMs: 3200,
  createdAt: NOW,
};

const messageFixture: LessonMessage = {
  id: 'message-1',
  lessonId: lessonFixture.id,
  stepId: planStepFixture.id,
  role: 'user',
  source: 'voice',
  content: 'Ich möchte ein Kaffee.',
  language: 'de',
  corrections: attemptFixture.corrections,
  audioPath: null,
  durationMs: 2400,
  createdAt: NOW,
};

const placementTurnFixture: PlacementTurn = {
  id: 'turn-1',
  sessionId: 'placement-1',
  order: 0,
  question: 'Wie heißt du?',
  questionLanguage: 'de',
  targetLevel: 'A1',
  skill: 'speaking',
  answer: 'Ich heiße Max.',
  source: 'text',
  score: 1,
  feedback: 'Верно.',
  estimatedLevel: 'A1',
  askedAt: EARLIER,
  answeredAt: NOW,
};

const placementSessionFixture: PlacementSession = {
  id: 'placement-1',
  status: 'completed',
  learningLanguage: 'de',
  explanationLanguage: 'ru',
  maxTurns: 8,
  turns: [placementTurnFixture],
  result: {
    level: 'A2',
    confidence: 0.7,
    rationale: 'Уверенно отвечает на бытовые вопросы, ошибается в падежах.',
    strengths: ['лексика по теме еды'],
    weaknesses: ['артикли'],
    recommendedGoals: ['заказать кофе'],
    turnsEvaluated: 8,
    accuracy: 0.75,
  },
  startedAt: EARLIER,
  completedAt: NOW,
  createdAt: EARLIER,
  updatedAt: NOW,
};

const vocabularyFixture: VocabularyItem = {
  id: 'vocabulary-1',
  term: 'Kaffee',
  translation: 'кофе',
  language: 'de',
  translationLanguage: 'ru',
  partOfSpeech: 'noun',
  transcription: null,
  example: 'Ich möchte einen Kaffee.',
  level: 'A1',
  status: 'learning',
  timesSeen: 3,
  timesCorrect: 2,
  lessonId: lessonFixture.id,
  materialId: materialFixture.id,
  firstSeenAt: EARLIER,
  lastSeenAt: NOW,
  createdAt: EARLIER,
  updatedAt: NOW,
};

const errorLogFixture: ErrorLogEntry = {
  id: 'error-1',
  category: 'grammar',
  severity: 'major',
  original: 'ein Kaffee',
  corrected: 'einen Kaffee',
  explanation: 'После möchte нужен винительный падеж: einen Kaffee.',
  targetItem: 'einen',
  language: 'de',
  lessonId: lessonFixture.id,
  stepId: planStepFixture.id,
  exerciseId: exerciseFixture.id,
  messageId: messageFixture.id,
  occurredAt: NOW,
  createdAt: NOW,
};

const levelHistoryFixture: LevelHistoryEntry = {
  id: 'level-1',
  fromLevel: 'A1',
  toLevel: 'A2',
  direction: 'up',
  source: 'progress',
  confidence: 0.8,
  reason: 'Три урока подряд с точностью 0.9 при пороге 0.85.',
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

/** Заполняет базу связным графом сущностей: родители раньше детей. */
function seedGraph(db: Db): void {
  insertRow(db, 'materials', materialToRow(materialFixture, { filePath: 'data/uploads/cafe.pdf' }));
  insertRow(db, 'material_chunks', materialChunkToRow(chunkFixture));
  insertRow(db, 'placement_sessions', placementSessionToRow(placementSessionFixture));
  insertRow(db, 'placement_turns', placementTurnToRow(placementTurnFixture));
  insertRow(db, 'lessons', lessonToRow(lessonFixture));
  insertRow(db, 'lesson_plan_steps', lessonPlanStepToRow(planStepFixture));
  for (const row of lessonMaterialsToRows(lessonFixture.id, lessonFixture.materialIds, NOW)) {
    insertRow(db, 'lesson_materials', row);
  }
  insertRow(db, 'lesson_messages', lessonMessageToRow(messageFixture));
  insertRow(db, 'exercises', exerciseToRow(exerciseFixture));
  insertRow(db, 'exercise_attempts', exerciseAttemptToRow(attemptFixture));
  insertRow(db, 'vocabulary_items', vocabularyItemToRow(vocabularyFixture));
  insertRow(db, 'error_log', errorLogEntryToRow(errorLogFixture));
  insertRow(db, 'level_history', levelHistoryEntryToRow(levelHistoryFixture));
}

describe('мапперы: домен → строка → домен', () => {
  let db: Db;

  beforeAll(() => {
    db = createMigratedDb();
    seedGraph(db);
  });

  afterAll(() => {
    db.close();
  });

  it('материал', () => {
    const material = rowToMaterial(selectById<MaterialRow>(db, 'materials', materialFixture.id));

    expect(material).toEqual(materialFixture);
    expect(materialSchema.parse(material)).toEqual(materialFixture);
  });

  it('фрагмент материала', () => {
    const chunk = rowToMaterialChunk(
      selectById<MaterialChunkRow>(db, 'material_chunks', chunkFixture.id),
    );

    expect(chunk).toEqual(chunkFixture);
    expect(materialChunkSchema.parse(chunk)).toEqual(chunkFixture);
  });

  it('сессия определения уровня вместе с вопросами', () => {
    const turn = rowToPlacementTurn(
      selectById<PlacementTurnRow>(db, 'placement_turns', placementTurnFixture.id),
    );
    const session = rowToPlacementSession(
      selectById<PlacementSessionRow>(db, 'placement_sessions', placementSessionFixture.id),
      [turn],
    );

    expect(session).toEqual(placementSessionFixture);
    expect(placementSessionSchema.parse(session)).toEqual(placementSessionFixture);
  });

  it('урок вместе с планом и материалами', () => {
    const plan = (
      db
        .prepare(`SELECT * FROM lesson_plan_steps WHERE lesson_id = ? ORDER BY "order"`)
        .all(lessonFixture.id) as LessonPlanStepRow[]
    ).map(rowToLessonPlanStep);
    const materialIds = (
      db
        .prepare(`SELECT material_id FROM lesson_materials WHERE lesson_id = ? ORDER BY "order"`)
        .all(lessonFixture.id) as { material_id: string }[]
    ).map((row) => row.material_id);
    const lesson = rowToLesson(selectById<LessonRow>(db, 'lessons', lessonFixture.id), {
      materialIds,
      plan,
    });

    expect(lesson).toEqual(lessonFixture);
    expect(lessonSchema.parse(lesson)).toEqual(lessonFixture);
  });

  it('реплика урока', () => {
    const message = rowToLessonMessage(
      selectById<LessonMessageRow>(db, 'lesson_messages', messageFixture.id),
    );

    expect(message).toEqual(messageFixture);
    expect(lessonMessageSchema.parse(message)).toEqual(messageFixture);
    // A10: аудио не хранится.
    expect(message.audioPath).toBeNull();
  });

  it('задание и попытка', () => {
    const exercise = rowToExercise(selectById<ExerciseRow>(db, 'exercises', exerciseFixture.id));
    const attempt = rowToExerciseAttempt(
      selectById<ExerciseAttemptRow>(db, 'exercise_attempts', attemptFixture.id),
    );

    expect(exercise).toEqual(exerciseFixture);
    expect(exerciseSchema.parse(exercise)).toEqual(exerciseFixture);
    expect(attempt).toEqual(attemptFixture);
    expect(exerciseAttemptSchema.parse(attempt)).toEqual(attemptFixture);
  });

  it('слово словаря и его лемма', () => {
    const row = selectById<VocabularyItemRow>(db, 'vocabulary_items', vocabularyFixture.id);
    const item = rowToVocabularyItem(row);

    expect(row.lemma).toBe('kaffee');
    expect(item).toEqual(vocabularyFixture);
    expect(vocabularyItemSchema.parse(item)).toEqual(vocabularyFixture);
  });

  it('не допускает два слова с одной леммой в одном языке', () => {
    expect(() =>
      insertRow(
        db,
        'vocabulary_items',
        vocabularyItemToRow({ ...vocabularyFixture, id: 'vocabulary-2', term: ' kaffee ' }),
      ),
    ).toThrow();
  });

  it('запись журнала ошибок', () => {
    const entry = rowToErrorLogEntry(selectById<ErrorLogRow>(db, 'error_log', errorLogFixture.id));

    expect(entry).toEqual(errorLogFixture);
    expect(errorLogEntrySchema.parse(entry)).toEqual(errorLogFixture);
  });

  it('запись истории уровня с обоснованием и метрикой (A13)', () => {
    const entry = rowToLevelHistoryEntry(
      selectById<LevelHistoryRow>(db, 'level_history', levelHistoryFixture.id),
    );

    expect(entry).toEqual(levelHistoryFixture);
    expect(levelHistoryEntrySchema.parse(entry)).toEqual(levelHistoryFixture);
  });
});
