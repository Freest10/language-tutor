/**
 * Публичный API пакета `@lt/shared`: доменные типы, Zod-схемы и DTO HTTP-эндпоинтов.
 * Это единственный вход пакета — server и web импортируют только `@lt/shared`.
 *
 * Соглашения: `*Schema` — Zod-схема, одноимённый PascalCase — выведенный из неё тип,
 * `SCREAMING_SNAKE` — кортеж допустимых значений или константа.
 * Относительные импорты внутри пакета — всегда с расширением `.js` (ESM/NodeNext).
 */

// Общие константы приложения.
export { API_PREFIX, APP_NAME, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './constants.js';

// Health-check.
export type { HealthResponse } from './health.js';

// Примитивы HTTP-слоя: идентификаторы, даты, конверт ошибки, пагинация.
export {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  apiErrorCodeSchema,
  apiErrorResponseSchema,
  apiErrorSchema,
  idParamSchema,
  idSchema,
  isoDateSchema,
  isoDateTimeSchema,
  okResponseSchema,
  paginatedResponseSchema,
  paginationQuerySchema,
  SORT_ORDERS,
  sortOrderSchema,
} from './api/common.js';
export type {
  ApiError,
  ApiErrorCode,
  ApiErrorResponse,
  Id,
  IdParam,
  OkResponse,
  Paginated,
  PaginationQuery,
  SortOrder,
} from './api/common.js';

// Языки и уровни CEFR.
export {
  CEFR_LEVELS,
  cefrLevelSchema,
  DEFAULT_CEFR_LEVEL,
  DEFAULT_LANGUAGE_CODE,
  KNOWN_LANGUAGE_CODES,
  LANGUAGE_CODE_PATTERN,
  LANGUAGE_LABELS,
  languageCodeSchema,
  languageOptionSchema,
  levelConfidenceSchema,
} from './domain/language.js';
export type {
  CefrLevel,
  KnownLanguageCode,
  LanguageCode,
  LanguageOption,
} from './domain/language.js';

// Профиль ученика (A12: три независимых языка).
export {
  dailyMinutesSchema,
  DEFAULT_DAILY_MINUTES,
  learnerGoalSchema,
  learnerInterestSchema,
  learnerProfileSchema,
  MAX_DAILY_MINUTES,
  MAX_LEARNER_GOALS,
  MAX_LEARNER_INTERESTS,
  MIN_DAILY_MINUTES,
} from './domain/profile.js';
export type { LearnerProfile } from './domain/profile.js';

// Материалы и извлечение текста (A16: статусы ошибок).
export {
  isMaterialErrorStatus,
  MATERIAL_ERROR_STATUSES,
  MATERIAL_SOURCE_TYPES,
  MATERIAL_STATUSES,
  MATERIAL_SUPPORTED_MIME_TYPES,
  materialChunkSchema,
  materialSchema,
  materialSourceTypeSchema,
  materialStatusSchema,
  MAX_MATERIAL_TEXT_LENGTH,
  MAX_MATERIAL_UPLOAD_BYTES,
} from './domain/material.js';
export type {
  Material,
  MaterialChunk,
  MaterialErrorStatus,
  MaterialSourceType,
  MaterialStatus,
} from './domain/material.js';

// Урок, план, реплики (A10: аудио не хранится).
export {
  LESSON_MESSAGE_ROLES,
  LESSON_STATUSES,
  LESSON_STEP_STATUSES,
  LESSON_STEP_TYPES,
  lessonMessageRoleSchema,
  lessonMessageSchema,
  lessonPlanStepSchema,
  lessonSchema,
  lessonStatusSchema,
  lessonStepStatusSchema,
  lessonStepTypeSchema,
  lessonSummarySchema,
  MESSAGE_SOURCES,
  messageSourceSchema,
} from './domain/lesson.js';
export type {
  Lesson,
  LessonMessage,
  LessonMessageRole,
  LessonPlanStep,
  LessonStatus,
  LessonStepStatus,
  LessonStepType,
  LessonSummary,
  MessageSource,
} from './domain/lesson.js';

// Задания и попытки.
export {
  EXERCISE_TYPES,
  exerciseAttemptSchema,
  exerciseSchema,
  exerciseTypeSchema,
} from './domain/exercise.js';
export type { Exercise, ExerciseAttempt, ExerciseType } from './domain/exercise.js';

// Словарь, ошибки, история уровня (A13: правила пересчёта).
export {
  correctionSchema,
  ERROR_CATEGORIES,
  ERROR_SEVERITIES,
  errorCategorySchema,
  errorLogEntrySchema,
  errorSeveritySchema,
  LEVEL_CHANGE_DIRECTIONS,
  LEVEL_CHANGE_POLICY,
  LEVEL_CHANGE_SOURCES,
  levelChangeDirectionSchema,
  levelChangeMetricsSchema,
  levelChangeSourceSchema,
  levelHistoryEntrySchema,
  VOCABULARY_STATUSES,
  vocabularyItemSchema,
  vocabularyStatusSchema,
} from './domain/progress.js';
export type {
  Correction,
  ErrorCategory,
  ErrorLogEntry,
  ErrorSeverity,
  LevelChangeDirection,
  LevelChangeMetrics,
  LevelChangeSource,
  LevelHistoryEntry,
  VocabularyItem,
  VocabularyStatus,
} from './domain/progress.js';

// Определение исходного уровня.
export {
  PLACEMENT_DEFAULT_MAX_TURNS,
  PLACEMENT_MAX_TURNS_LIMIT,
  PLACEMENT_SESSION_STATUSES,
  PLACEMENT_SKILLS,
  placementResultSchema,
  placementSessionSchema,
  placementSessionStatusSchema,
  placementSkillSchema,
  placementTurnSchema,
} from './domain/placement.js';
export type {
  PlacementResult,
  PlacementSession,
  PlacementSessionStatus,
  PlacementSkill,
  PlacementTurn,
} from './domain/placement.js';

// GET /api/config.
export {
  appConfigSchema,
  configDefaultsSchema,
  configLimitsSchema,
  getConfigResponseSchema,
  llmCapabilitySchema,
  sttCapabilitySchema,
  ttsCapabilitySchema,
} from './api/config.js';
export type {
  AppConfig,
  ConfigDefaults,
  ConfigLimits,
  GetConfigResponse,
  LlmCapability,
  SttCapability,
  TtsCapability,
} from './api/config.js';

// GET|PUT /api/profile.
export {
  getProfileResponseSchema,
  updateProfileRequestSchema,
  updateProfileResponseSchema,
} from './api/profile.js';
export type {
  GetProfileResponse,
  UpdateProfileRequest,
  UpdateProfileResponse,
} from './api/profile.js';

// POST /api/placement/sessions[/:id/turns|/finish].
export {
  createPlacementSessionRequestSchema,
  createPlacementSessionResponseSchema,
  finishPlacementSessionRequestSchema,
  finishPlacementSessionResponseSchema,
  placementSessionParamsSchema,
  submitPlacementTurnRequestSchema,
  submitPlacementTurnResponseSchema,
} from './api/placement.js';
export type {
  CreatePlacementSessionRequest,
  CreatePlacementSessionResponse,
  FinishPlacementSessionRequest,
  FinishPlacementSessionResponse,
  PlacementSessionParams,
  SubmitPlacementTurnRequest,
  SubmitPlacementTurnResponse,
} from './api/placement.js';

// GET|POST /api/materials, GET|DELETE /api/materials/:id.
export {
  createMaterialResponseSchema,
  createTextMaterialRequestSchema,
  deleteMaterialResponseSchema,
  getMaterialQuerySchema,
  getMaterialResponseSchema,
  listMaterialsQuerySchema,
  listMaterialsResponseSchema,
  MATERIAL_FILE_FIELD_NAME,
  materialParamsSchema,
  uploadMaterialFieldsSchema,
} from './api/materials.js';
export type {
  CreateMaterialResponse,
  CreateTextMaterialRequest,
  DeleteMaterialResponse,
  GetMaterialQuery,
  GetMaterialResponse,
  ListMaterialsQuery,
  ListMaterialsResponse,
  MaterialParams,
  UploadMaterialFields,
} from './api/materials.js';

// GET|POST /api/lessons, GET /api/lessons/:id, план урока.
export {
  createLessonRequestSchema,
  createLessonResponseSchema,
  getLessonResponseSchema,
  lessonParamsSchema,
  listLessonsQuerySchema,
  listLessonsResponseSchema,
  regenerateLessonPlanRequestSchema,
  regenerateLessonPlanResponseSchema,
} from './api/lessons.js';
export type {
  CreateLessonRequest,
  CreateLessonResponse,
  GetLessonResponse,
  LessonParams,
  ListLessonsQuery,
  ListLessonsResponse,
  RegenerateLessonPlanRequest,
  RegenerateLessonPlanResponse,
} from './api/lessons.js';

// Ход урока: start, turns, steps, attempts, complete, messages.
export {
  advanceLessonStepRequestSchema,
  advanceLessonStepResponseSchema,
  completeLessonRequestSchema,
  completeLessonResponseSchema,
  createExerciseAttemptRequestSchema,
  createExerciseAttemptResponseSchema,
  lessonExerciseParamsSchema,
  lessonStepParamsSchema,
  lessonTurnRequestSchema,
  lessonTurnResponseSchema,
  listLessonMessagesQuerySchema,
  listLessonMessagesResponseSchema,
  startLessonRequestSchema,
  startLessonResponseSchema,
} from './api/lessonSession.js';
export type {
  AdvanceLessonStepRequest,
  AdvanceLessonStepResponse,
  CompleteLessonRequest,
  CompleteLessonResponse,
  CreateExerciseAttemptRequest,
  CreateExerciseAttemptResponse,
  LessonExerciseParams,
  LessonStepParams,
  LessonTurnRequest,
  LessonTurnResponse,
  ListLessonMessagesQuery,
  ListLessonMessagesResponse,
  StartLessonRequest,
  StartLessonResponse,
} from './api/lessonSession.js';

// GET /api/progress/*.
export {
  dailyActivitySchema,
  getProgressSummaryResponseSchema,
  levelEligibilitySchema,
  listErrorsQuerySchema,
  listErrorsResponseSchema,
  listLevelHistoryQuerySchema,
  listLevelHistoryResponseSchema,
  listVocabularyQuerySchema,
  listVocabularyResponseSchema,
  progressSummarySchema,
  VOCABULARY_SORT_FIELDS,
  vocabularySortFieldSchema,
  vocabularyStatsSchema,
} from './api/progress.js';
export type {
  DailyActivity,
  GetProgressSummaryResponse,
  LevelEligibility,
  ListErrorsQuery,
  ListErrorsResponse,
  ListLevelHistoryQuery,
  ListLevelHistoryResponse,
  ListVocabularyQuery,
  ListVocabularyResponse,
  ProgressSummary,
  VocabularySortField,
  VocabularyStats,
} from './api/progress.js';

// POST /api/voice/stt, POST /api/voice/tts.
export {
  AUDIO_FORMAT_CONTENT_TYPES,
  AUDIO_FORMATS,
  audioFormatSchema,
  DEFAULT_TTS_FORMAT,
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_TTS_TEXT_LENGTH,
  STT_AUDIO_FIELD_NAME,
  STT_SUPPORTED_MIME_TYPES,
  sttRequestFieldsSchema,
  sttResponseSchema,
  ttsRequestSchema,
  ttsResponseSchema,
  VOICE_PROVIDERS,
  voiceProviderSchema,
} from './api/voice.js';
export type {
  AudioFormat,
  SttRequestFields,
  SttResponse,
  TtsRequest,
  TtsResponse,
  VoiceProvider,
} from './api/voice.js';
