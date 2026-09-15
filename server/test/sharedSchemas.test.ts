import { describe, expect, it } from 'vitest';

import {
  apiErrorResponseSchema,
  createExerciseAttemptRequestSchema,
  cefrLevelSchema,
  exerciseAttemptSchema,
  getConfigResponseSchema,
  isMaterialErrorStatus,
  languageCodeSchema,
  learnerProfileSchema,
  lessonMessageSchema,
  lessonPlanStepSchema,
  levelHistoryEntrySchema,
  materialSchema,
  paginationQuerySchema,
  sttRequestFieldsSchema,
  sttResponseSchema,
  ttsRequestSchema,
  ttsResponseSchema,
  updateProfileRequestSchema,
  type LearnerProfile,
} from '@lt/shared';

const NOW = '2026-09-15T10:20:30.000Z';

const validProfile = {
  id: 'profile-1',
  learningLanguage: 'de',
  interfaceLanguage: 'ru',
  explanationLanguage: 'ru',
  level: 'A2',
  levelConfidence: 0.6,
  goals: ['заказать кофе'],
  interests: ['музыка'],
  dailyMinutes: 20,
  placementCompletedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

const validPlanStep = {
  id: 'step-1',
  lessonId: 'lesson-1',
  order: 0,
  type: 'grammar',
  title: 'Порядок слов в вопросе',
  objectives: ['строить вопросы в present simple'],
  targetItems: ['do you', 'does he'],
  instructions: 'Объясни правило на языке объяснений и дай три примера.',
  estimatedMinutes: 7,
  status: 'pending',
};

const validAttempt = {
  id: 'attempt-1',
  exerciseId: 'exercise-1',
  lessonId: 'lesson-1',
  stepId: 'step-1',
  answer: 'Do you like coffee?',
  source: 'voice',
  isCorrect: true,
  score: 1,
  feedback: 'Всё верно.',
  createdAt: NOW,
};

describe('профиль ученика', () => {
  it('разбирает профиль с тремя языками (A12)', () => {
    const profile: LearnerProfile = learnerProfileSchema.parse(validProfile);

    expect(profile.learningLanguage).toBe('de');
    expect(profile.interfaceLanguage).toBe('ru');
    expect(profile.explanationLanguage).toBe('ru');
    expect(profile.interests).toEqual(['музыка']);
  });

  it('подставляет пустой список интересов', () => {
    const { interests: _interests, ...withoutInterests } = validProfile;

    expect(learnerProfileSchema.parse(withoutInterests).interests).toEqual([]);
  });

  it('отклоняет несуществующий уровень CEFR', () => {
    const result = learnerProfileSchema.safeParse({ ...validProfile, level: 'B3' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['level']);
  });

  it('отклоняет профиль без целей', () => {
    const result = learnerProfileSchema.safeParse({ ...validProfile, goals: [] });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['goals']);
  });

  it('отклоняет explanationLanguage с недопустимым кодом', () => {
    expect(
      learnerProfileSchema.safeParse({ ...validProfile, explanationLanguage: 'ru_RU' }).success,
    ).toBe(false);
  });

  it('требует хотя бы одно поле в PUT /api/profile', () => {
    expect(updateProfileRequestSchema.safeParse({}).success).toBe(false);
    expect(updateProfileRequestSchema.safeParse({ dailyMinutes: 30 }).success).toBe(true);
  });

  it('отклоняет пустой список целей в PUT /api/profile', () => {
    expect(updateProfileRequestSchema.safeParse({ goals: [] }).success).toBe(false);
  });
});

describe('план урока', () => {
  it('разбирает шаг плана и подставляет пустые коллекции', () => {
    const step = lessonPlanStepSchema.parse(validPlanStep);

    expect(step.type).toBe('grammar');
    expect(step.exerciseIds).toEqual([]);
    expect(step.materialChunkIds).toEqual([]);
    expect(step.startedAt).toBeUndefined();
  });

  it('отклоняет неизвестный вид шага', () => {
    const result = lessonPlanStepSchema.safeParse({ ...validPlanStep, type: 'singing' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['type']);
  });

  it('отклоняет шаг без инструкции тьютору', () => {
    const result = lessonPlanStepSchema.safeParse({ ...validPlanStep, instructions: '' });

    expect(result.success).toBe(false);
  });

  it('отклоняет отрицательный порядковый номер шага', () => {
    expect(lessonPlanStepSchema.safeParse({ ...validPlanStep, order: -1 }).success).toBe(false);
  });
});

describe('попытка ответа на задание', () => {
  it('разбирает сохранённую попытку', () => {
    const attempt = exerciseAttemptSchema.parse(validAttempt);

    expect(attempt.isCorrect).toBe(true);
    expect(attempt.corrections).toEqual([]);
  });

  it('разбирает попытку с исправлениями и подставляет тяжесть ошибки', () => {
    const attempt = exerciseAttemptSchema.parse({
      ...validAttempt,
      isCorrect: false,
      score: 0.4,
      corrections: [
        {
          category: 'grammar',
          original: 'You like coffee?',
          corrected: 'Do you like coffee?',
          explanation: 'В вопросе нужен вспомогательный глагол do.',
        },
      ],
    });

    expect(attempt.corrections[0]?.severity).toBe('minor');
  });

  it('отклоняет оценку вне диапазона 0..1', () => {
    const result = exerciseAttemptSchema.safeParse({ ...validAttempt, score: 1.5 });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['score']);
  });

  it('отклоняет неизвестную категорию исправления', () => {
    const result = exerciseAttemptSchema.safeParse({
      ...validAttempt,
      corrections: [{ category: 'style', original: 'a', explanation: 'b' }],
    });

    expect(result.success).toBe(false);
  });

  it('разбирает тело запроса попытки и подставляет источник ответа', () => {
    const body = createExerciseAttemptRequestSchema.parse({ answer: 'Do you like coffee?' });

    expect(body.source).toBe('text');
  });

  it('отклоняет пустой ответ в теле запроса попытки', () => {
    expect(createExerciseAttemptRequestSchema.safeParse({ answer: '   ' }).success).toBe(false);
  });
});

describe('голосовые DTO', () => {
  it('разбирает поля запроса распознавания речи', () => {
    const fields = sttRequestFieldsSchema.parse({ language: 'de', lessonId: 'lesson-1' });

    expect(fields.language).toBe('de');
  });

  it('отклоняет поля запроса распознавания речи с некорректным языком', () => {
    expect(sttRequestFieldsSchema.safeParse({ language: 'deutsch!' }).success).toBe(false);
  });

  it('разбирает ответ распознавания речи, включая пустую расшифровку', () => {
    const response = sttResponseSchema.parse({ text: '', provider: 'openai', model: 'whisper-1' });

    expect(response.text).toBe('');
    expect(response.provider).toBe('openai');
  });

  it('отклоняет ответ распознавания речи с неизвестным провайдером', () => {
    expect(sttResponseSchema.safeParse({ text: 'hi', provider: 'vosk' }).success).toBe(false);
  });

  it('разбирает запрос синтеза речи и подставляет формат и скорость', () => {
    const request = ttsRequestSchema.parse({ text: 'Guten Morgen' });

    expect(request.format).toBe('mp3');
    expect(request.speed).toBe(1);
  });

  it('отклоняет пустой текст и слишком большую скорость синтеза', () => {
    expect(ttsRequestSchema.safeParse({ text: '' }).success).toBe(false);
    expect(ttsRequestSchema.safeParse({ text: 'Hallo', speed: 4 }).success).toBe(false);
  });

  it('разбирает ответ синтеза речи', () => {
    const response = ttsResponseSchema.parse({
      audioBase64: 'AAAA',
      contentType: 'audio/mpeg',
      format: 'mp3',
      provider: 'openai',
    });

    expect(response.format).toBe('mp3');
  });

  it('отклоняет ответ синтеза речи с неизвестным форматом', () => {
    const result = ttsResponseSchema.safeParse({
      audioBase64: 'AAAA',
      contentType: 'audio/flac',
      format: 'flac',
      provider: 'openai',
    });

    expect(result.success).toBe(false);
  });
});

describe('прочие контракты', () => {
  it('разбирает конверт ошибки API', () => {
    const parsed = apiErrorResponseSchema.parse({
      error: { code: 'not_configured', message: 'Синтез речи не настроен' },
    });

    expect(parsed.error.code).toBe('not_configured');
    expect(
      apiErrorResponseSchema.safeParse({ error: { code: 'oops', message: 'x' } }).success,
    ).toBe(false);
  });

  it('приводит строковые параметры пагинации к числам', () => {
    expect(paginationQuerySchema.parse({ limit: '50', offset: '10' })).toEqual({
      limit: 50,
      offset: 10,
    });
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 20, offset: 0 });
    expect(paginationQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });

  it('различает статусы ошибок материала (A16)', () => {
    const scan = materialSchema.parse({
      id: 'material-1',
      title: 'Скан учебника',
      sourceType: 'pdf',
      status: 'error_no_text_layer',
      statusMessage: 'В PDF нет текстового слоя: нужен файл с текстом, а не скан.',
      language: 'de',
      charCount: 0,
      chunkCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(isMaterialErrorStatus(scan.status)).toBe(true);
    expect(isMaterialErrorStatus('ready')).toBe(false);
    expect(materialSchema.safeParse({ ...scan, status: 'broken' }).success).toBe(false);
  });

  it('требует обоснование и метрику при изменении уровня (A13)', () => {
    const entry = {
      id: 'level-1',
      fromLevel: 'A2',
      toLevel: 'B1',
      direction: 'up',
      source: 'progress',
      confidence: 0.8,
      reason: 'Три урока подряд с точностью 0.9 при пороге 0.85.',
      metrics: {
        accuracy: 0.9,
        lessonsConsidered: 3,
        lessonsSinceLastChange: 4,
        exercisesEvaluated: 24,
      },
      changedAt: NOW,
      createdAt: NOW,
    };

    expect(levelHistoryEntrySchema.parse(entry).reason.length).toBeGreaterThan(0);

    const { reason: _reason, ...withoutReason } = entry;
    expect(levelHistoryEntrySchema.safeParse(withoutReason).success).toBe(false);

    const { metrics: _metrics, ...withoutMetrics } = entry;
    expect(levelHistoryEntrySchema.safeParse(withoutMetrics).success).toBe(false);
  });

  it('оставляет audioPath пустым (A10)', () => {
    const message = lessonMessageSchema.parse({
      id: 'message-1',
      lessonId: 'lesson-1',
      role: 'user',
      source: 'voice',
      content: 'Ich möchte einen Kaffee.',
      createdAt: NOW,
    });

    expect(message.audioPath).toBeUndefined();
    expect(message.corrections).toEqual([]);
  });

  it('разбирает конфигурацию с возможностями бэкенда', () => {
    const config = getConfigResponseSchema.parse({
      appName: 'language-tutor',
      apiPrefix: '/api',
      version: '0.1.0',
      llm: { available: false, model: null, reason: 'LLM_API_KEY не задан' },
      stt: { provider: 'browser', available: true, model: null, reason: null },
      tts: {
        provider: 'openai',
        available: true,
        model: 'tts-1',
        voice: 'alloy',
        formats: ['mp3'],
      },
      supportedLanguages: [{ code: 'en', nativeName: 'English', englishName: 'English' }],
      defaults: {
        learningLanguage: 'en',
        interfaceLanguage: 'ru',
        explanationLanguage: 'ru',
        level: 'A1',
        dailyMinutes: 20,
      },
      limits: {
        maxMaterialUploadBytes: 1024,
        maxMaterialTextLength: 1024,
        maxAudioUploadBytes: 1024,
        maxTtsTextLength: 2000,
        maxPageSize: 100,
      },
    });

    expect(config.stt.provider).toBe('browser');
    expect(config.llm.available).toBe(false);
  });

  it('проверяет коды языков и уровней', () => {
    expect(languageCodeSchema.parse('pt-BR')).toBe('pt-BR');
    expect(languageCodeSchema.safeParse('e').success).toBe(false);
    expect(cefrLevelSchema.safeParse('C2').success).toBe(true);
    expect(cefrLevelSchema.safeParse('c2').success).toBe(false);
  });
});
