/**
 * Правила определения исходного уровня: короткий адаптивный диалог и его итог.
 *
 * Как устроен тест:
 * - сессия создаётся под язык профиля и сохраняется ДО первого обращения к модели:
 *   отказ провайдера не должен стоить ученику начатого теста, поэтому в ответе
 *   об ошибке уходит `details.sessionId`, по которому тест читается и продолжается;
 * - каждый ответ ученика оценивается одним обращением к модели, которое заодно
 *   приносит следующий вопрос; сложность следующего вопроса считает сервер
 *   (`nextPlacementLevel()`), а не модель — иначе адаптация была бы непроверяемой;
 * - жёсткий предел `maxTurns` важнее мнения модели: тест завершается принудительно,
 *   даже если модель просит продолжать;
 * - оценка ученику по ходу теста не показывается: `score`, `feedback` и
 *   `estimatedLevel` живут в отдельных полях, а в вопросе их быть не должно
 *   (запрет — в системном промпте `prompts/placement.ts`).
 *
 * Итог (`/finish`) пишет уровень в профиль, ставит `placementCompletedAt` и
 * `levelConfidence` по уверенности модели и добавляет запись в историю уровня
 * с `source: 'placement'`; `reason` и `metrics` обязательны (допущение A13).
 */
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_CEFR_LEVEL,
  PLACEMENT_DEFAULT_MAX_TURNS,
  PLACEMENT_SKILLS,
  type CefrLevel,
  type CreatePlacementSessionRequest,
  type CreatePlacementSessionResponse,
  type FinishPlacementSessionRequest,
  type FinishPlacementSessionResponse,
  type Id,
  type LanguageCode,
  type LearnerProfile,
  type LevelHistoryEntry,
  type PlacementResult,
  type PlacementSession,
  type PlacementSkill,
  type PlacementTurn,
  type SubmitPlacementTurnRequest,
  type SubmitPlacementTurnResponse,
} from '@lt/shared';

import { learnerProfileToRow, nowIso } from '../db/mappers.js';
import { AppError, conflict, notFound } from '../lib/httpErrors.js';
import { assertSupportedLanguages } from '../lib/languages.js';
import {
  buildEvaluationMessages,
  buildFirstQuestionMessages,
  buildSummaryMessages,
  nextPlacementLevel,
  placementEvaluationSchema,
  placementQuestionSchema,
  placementSummarySchema,
  type PlacementEvaluationReply,
  type PlacementPromptContext,
  type PlacementQuestionReply,
  type PlacementSummaryReply,
} from '../prompts/placement.js';
import { requestStructuredJson } from '../providers/structuredJson.js';
import { providerErrorToAppError, type ProviderLogger } from '../providers/types.js';
import {
  findPlacementSessionById,
  insertPlacementSession,
  insertPlacementTurn,
  savePlacementProgress,
  updatePlacementSession,
} from '../repositories/placementRepository.js';
import { saveProfileRow } from '../repositories/profileRepository.js';

import { buildLevelHistoryEntry } from './levelHistory.js';
import { getProfile, getProfileForPrompt } from './profileService.js';

/** Температура генерации: тест должен быть предсказуемым, а не разнообразным. */
const PLACEMENT_TEMPERATURE = 0.3;

/** Предел длины обоснования в истории уровня (`levelHistoryEntrySchema`). */
const MAX_REASON_LENGTH = 1000;

/** Поля запроса, которые содержат код языка. */
const LANGUAGE_FIELDS = ['learningLanguage', 'explanationLanguage'] as const;

/** Общие параметры обращения к сервису. */
export interface PlacementServiceOptions {
  /** Логгер запроса: провайдер пишет в него повторы и тайминги. */
  logger?: ProviderLogger | undefined;
}

/**
 * Отказ модели, дополненный идентификатором сессии: сессия уже сохранена, и клиент
 * по этому идентификатору возвращается к тесту, а не начинает его заново.
 */
function llmFailure(error: unknown, sessionId: Id): AppError {
  const appError = providerErrorToAppError(error, 'llm');
  const details = appError.details;
  const base = typeof details === 'object' && details !== null ? details : {};

  return new AppError(appError.code, appError.message, {
    details: { ...base, sessionId },
    cause: appError,
  });
}

/** Сведения о сессии для промптов. */
function promptContext(session: PlacementSession, profile: LearnerProfile): PlacementPromptContext {
  return {
    learningLanguage: session.learningLanguage,
    explanationLanguage: session.explanationLanguage,
    maxTurns: session.maxTurns,
    profileSummary: getProfileForPrompt(profile),
  };
}

/** Отвечен ли вопрос. */
function isAnswered(turn: PlacementTurn): boolean {
  return turn.answeredAt !== null && turn.answeredAt !== undefined;
}

/** Заданный, но ещё не отвеченный вопрос активной сессии. */
function pendingTurn(session: PlacementSession): PlacementTurn | undefined {
  return session.status === 'in_progress'
    ? session.turns.find((turn) => !isAnswered(turn))
    : undefined;
}

/** Навык вопроса, если модель его не назвала: навыки перебираются по кругу. */
function fallbackSkill(order: number): PlacementSkill {
  return PLACEMENT_SKILLS[order % PLACEMENT_SKILLS.length] ?? 'grammar';
}

/** Доля верных ответов по выставленным оценкам, 0..1. */
function averageScore(turns: readonly PlacementTurn[]): number {
  if (turns.length === 0) {
    return 0;
  }

  const total = turns.reduce((sum, turn) => sum + (turn.score ?? 0), 0);

  return Math.min(1, Math.max(0, total / turns.length));
}

/**
 * Уровень первого вопроса: значение из профиля — лишь стартовая догадка.
 * Для языка, которого в профиле нет, догадываться не о чем — начинаем с A1.
 */
function startingLevel(profile: LearnerProfile, learningLanguage: LanguageCode): CefrLevel {
  return learningLanguage === profile.learningLanguage ? profile.level : DEFAULT_CEFR_LEVEL;
}

/** Черновик нового вопроса: всё, чего нет в самой сессии. */
interface TurnDraft {
  order: number;
  question: string;
  skill: PlacementSkill;
  targetLevel: CefrLevel;
  askedAt: string;
}

/** Собирает вопрос сессии; ответ и оценка появляются позже. */
function buildTurn(session: PlacementSession, draft: TurnDraft): PlacementTurn {
  return {
    id: randomUUID(),
    sessionId: session.id,
    order: draft.order,
    question: draft.question,
    questionLanguage: session.learningLanguage,
    targetLevel: draft.targetLevel,
    skill: draft.skill,
    answer: null,
    source: null,
    score: null,
    feedback: null,
    estimatedLevel: null,
    askedAt: draft.askedAt,
    answeredAt: null,
  };
}

/** Сессия по идентификатору; 404, если её нет. */
function requireSession(id: Id): PlacementSession {
  const session = findPlacementSessionById(id);

  if (session === undefined) {
    throw notFound('Сессия определения уровня не найдена', {
      details: { reason: 'placement_session_not_found', sessionId: id },
    });
  }

  return session;
}

/** Сессия, которую ещё можно продолжать; 409, если тест уже закрыт. */
function requireActiveSession(id: Id): PlacementSession {
  const session = requireSession(id);

  if (session.status !== 'in_progress') {
    throw conflict('Сессия определения уровня уже завершена', {
      details: {
        reason: 'placement_session_not_active',
        sessionId: id,
        status: session.status,
      },
    });
  }

  return session;
}

/** Вопрос, на который ждут ответа; 404 — чужой вопрос, 409 — ответ уже принят. */
function requirePendingTurn(session: PlacementSession, turnId: Id): PlacementTurn {
  const turn = session.turns.find((item) => item.id === turnId);

  if (turn === undefined) {
    throw notFound('Вопрос не принадлежит этой сессии определения уровня', {
      details: { reason: 'placement_turn_not_found', sessionId: session.id, turnId },
    });
  }

  if (isAnswered(turn)) {
    throw conflict('На этот вопрос уже отвечали', {
      details: { reason: 'placement_turn_already_answered', sessionId: session.id, turnId },
    });
  }

  return turn;
}

/** Первый вопрос сессии от модели. */
async function askFirstQuestion(
  session: PlacementSession,
  profile: LearnerProfile,
  targetLevel: CefrLevel,
  options: PlacementServiceOptions,
): Promise<PlacementQuestionReply> {
  try {
    const { data } = await requestStructuredJson({
      schema: placementQuestionSchema,
      messages: buildFirstQuestionMessages(promptContext(session, profile), { targetLevel }),
      schemaName: 'placement_question',
      temperature: PLACEMENT_TEMPERATURE,
      logger: options.logger,
    });

    return data;
  } catch (error) {
    throw llmFailure(error, session.id);
  }
}

/** Оценка ответа и следующий вопрос одним обращением к модели. */
async function evaluateAnswer(
  session: PlacementSession,
  profile: LearnerProfile,
  input: { turn: PlacementTurn; answer: string; questionsLeft: number },
  options: PlacementServiceOptions,
): Promise<PlacementEvaluationReply> {
  try {
    const { data } = await requestStructuredJson({
      schema: placementEvaluationSchema,
      messages: buildEvaluationMessages(promptContext(session, profile), {
        previousTurns: session.turns.filter((turn) => turn.id !== input.turn.id),
        currentTurn: input.turn,
        answer: input.answer,
        questionsLeft: input.questionsLeft,
      }),
      schemaName: 'placement_evaluation',
      temperature: PLACEMENT_TEMPERATURE,
      logger: options.logger,
    });

    return data;
  } catch (error) {
    throw llmFailure(error, session.id);
  }
}

/** Итоговое резюме теста от модели. */
async function summarize(
  session: PlacementSession,
  profile: LearnerProfile,
  answered: readonly PlacementTurn[],
  accuracy: number,
  options: PlacementServiceOptions,
): Promise<PlacementSummaryReply> {
  try {
    const { data } = await requestStructuredJson({
      schema: placementSummarySchema,
      messages: buildSummaryMessages(promptContext(session, profile), {
        turns: answered,
        accuracy,
      }),
      schemaName: 'placement_result',
      temperature: PLACEMENT_TEMPERATURE,
      logger: options.logger,
    });

    return data;
  } catch (error) {
    throw llmFailure(error, session.id);
  }
}

/** Человекочитаемое обоснование записи истории уровня (A13). */
function levelChangeReason(result: PlacementResult): string {
  const text =
    `Определение уровня: ${result.level} по ${String(result.turnsEvaluated)} ответам ` +
    `(доля верных ${result.accuracy.toFixed(2)}). ${result.rationale}`;

  return text.length <= MAX_REASON_LENGTH ? text : `${text.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

/**
 * Запись истории уровня по итогу теста. Первичная установка (`direction: 'initial'`,
 * `fromLevel: null`) — забота общего сборщика `buildLevelHistoryEntry()`. Если
 * уровень лишь подтверждён, истории изменений писать нечего — так же поступает
 * ручное обновление профиля.
 */
function buildLevelChange(
  session: PlacementSession,
  result: PlacementResult,
  fromLevel: CefrLevel,
  changedAt: string,
): LevelHistoryEntry | undefined {
  const entry = buildLevelHistoryEntry({
    fromLevel,
    toLevel: result.level,
    source: 'placement',
    confidence: result.confidence,
    reason: levelChangeReason(result),
    metrics: {
      // Уроков за этой оценкой не стоит: измерение целиком — ответы теста.
      accuracy: result.accuracy,
      lessonsConsidered: 0,
      lessonsSinceLastChange: 0,
      exercisesEvaluated: result.turnsEvaluated,
      windowFrom: session.startedAt,
      windowTo: changedAt,
    },
    changedAt,
  });

  return entry.direction !== 'initial' && fromLevel === result.level ? undefined : entry;
}

/**
 * Итог теста применим к профилю, только если тест шёл на изучаемом языке профиля:
 * уровень немецкого нельзя записать в профиль, где учат английский. Проверка идёт
 * до завершения сессии, чтобы отказ можно было исправить (`applyToProfile: false`)
 * и повторить.
 */
function assertProfileMatchesSession(session: PlacementSession, profile: LearnerProfile): void {
  if (session.learningLanguage !== profile.learningLanguage) {
    throw conflict('Тест проходил не на том языке, который изучается по профилю', {
      details: {
        reason: 'placement_language_mismatch',
        sessionId: session.id,
        sessionLanguage: session.learningLanguage,
        profileLanguage: profile.learningLanguage,
      },
    });
  }
}

/**
 * Переносит итог теста в профиль: уровень, уверенность и момент прохождения.
 * Профиль и история уровня пишутся одной транзакцией (`saveProfileRow`).
 */
function applyResultToProfile(
  session: PlacementSession,
  result: PlacementResult,
  current: LearnerProfile,
  completedAt: string,
): LearnerProfile {
  const next: LearnerProfile = {
    ...current,
    level: result.level,
    levelConfidence: result.confidence,
    placementCompletedAt: completedAt,
    updatedAt: completedAt,
  };
  const levelChange = buildLevelChange(session, result, current.level, completedAt);

  // Пройденный тест означает и завершённый онбординг: уровень больше не догадка.
  saveProfileRow(learnerProfileToRow(next, { onboardingCompleted: true }), { levelChange });

  return next;
}

/**
 * Создаёт сессию и задаёт первый вопрос.
 *
 * Языки и число вопросов по умолчанию берутся из профиля; сессия сохраняется до
 * обращения к модели, поэтому её не теряет даже отказ провайдера.
 */
export async function createPlacementSession(
  input: CreatePlacementSessionRequest,
  options: PlacementServiceOptions = {},
): Promise<CreatePlacementSessionResponse> {
  assertSupportedLanguages(input, LANGUAGE_FIELDS);

  const profile = getProfile();
  const startedAt = nowIso();
  const session: PlacementSession = {
    id: randomUUID(),
    status: 'in_progress',
    learningLanguage: input.learningLanguage ?? profile.learningLanguage,
    explanationLanguage: input.explanationLanguage ?? profile.explanationLanguage,
    maxTurns: input.maxTurns ?? PLACEMENT_DEFAULT_MAX_TURNS,
    turns: [],
    result: null,
    startedAt,
    completedAt: null,
    createdAt: startedAt,
    updatedAt: startedAt,
  };

  insertPlacementSession(session);

  const targetLevel = startingLevel(profile, session.learningLanguage);
  const reply = await askFirstQuestion(session, profile, targetLevel, options);
  const askedAt = nowIso();
  const turn = buildTurn(session, {
    order: 0,
    question: reply.assistantMessage,
    skill: reply.skill,
    targetLevel,
    askedAt,
  });
  const updated: PlacementSession = { ...session, turns: [turn], updatedAt: askedAt };

  insertPlacementTurn(updated, turn);

  return { session: updated, nextTurn: turn };
}

/**
 * Сессия целиком — для восстановления незавершённого теста после перезагрузки.
 * Отдельной DTO у чтения нет, поэтому используется форма ответа на создание:
 * `session` содержит все ходы, `nextTurn` — вопрос, на который ждут ответа.
 */
export function getPlacementSession(id: Id): CreatePlacementSessionResponse {
  const session = requireSession(id);

  return { session, nextTurn: pendingTurn(session) ?? null };
}

/**
 * Принимает ответ ученика, оценивает его и задаёт следующий вопрос.
 *
 * Тест завершается (`finished: true`), когда модель считает уровень ясным,
 * когда исчерпан лимит вопросов или когда модель не прислала следующий вопрос.
 */
export async function submitPlacementTurn(
  id: Id,
  input: SubmitPlacementTurnRequest,
  options: PlacementServiceOptions = {},
): Promise<SubmitPlacementTurnResponse> {
  const session = requireActiveSession(id);
  const turn = requirePendingTurn(session, input.turnId);
  const profile = getProfile();
  const answeredCount = session.turns.filter(isAnswered).length + 1;
  const questionsLeft = Math.max(0, session.maxTurns - answeredCount);
  const evaluation = await evaluateAnswer(
    session,
    profile,
    { turn, answer: input.answer, questionsLeft },
    options,
  );
  const answeredAt = nowIso();
  const evaluatedTurn: PlacementTurn = {
    ...turn,
    answer: input.answer,
    source: input.source,
    score: evaluation.score,
    feedback: evaluation.feedback,
    estimatedLevel: evaluation.estimatedLevel,
    answeredAt,
  };
  const question = evaluation.assistantMessage?.trim() ?? '';
  // Лимит вопросов сильнее мнения модели: иначе тест длится сколько угодно.
  const finished = evaluation.shouldFinish || questionsLeft === 0 || question.length === 0;
  const nextTurn = finished
    ? undefined
    : buildTurn(session, {
        order: session.turns.length,
        question,
        skill: evaluation.skill ?? fallbackSkill(session.turns.length),
        targetLevel: nextPlacementLevel(turn.targetLevel, evaluation.score),
        askedAt: answeredAt,
      });
  const turns = session.turns.map((item) => (item.id === evaluatedTurn.id ? evaluatedTurn : item));
  const updated: PlacementSession = {
    ...session,
    turns: nextTurn === undefined ? turns : [...turns, nextTurn],
    updatedAt: answeredAt,
  };

  savePlacementProgress(updated, evaluatedTurn, nextTurn);

  return { session: updated, evaluatedTurn, nextTurn: nextTurn ?? null, finished };
}

/**
 * Завершает тест: сохраняет итог в сессии и, если не запрещено, переносит его
 * в профиль вместе с записью истории уровня (`source: 'placement'`).
 */
export async function finishPlacementSession(
  id: Id,
  input: FinishPlacementSessionRequest,
  options: PlacementServiceOptions = {},
): Promise<FinishPlacementSessionResponse> {
  const session = requireActiveSession(id);
  const answered = session.turns.filter(isAnswered);

  if (answered.length === 0) {
    throw conflict('Тест нельзя завершить, пока нет ни одного ответа', {
      details: { reason: 'placement_no_answers', sessionId: id },
    });
  }

  const profile = getProfile();

  if (input.applyToProfile) {
    assertProfileMatchesSession(session, profile);
  }

  const accuracy = averageScore(answered);
  const summary = await summarize(session, profile, answered, accuracy, options);
  const completedAt = nowIso();
  const result: PlacementResult = {
    level: summary.level,
    confidence: summary.confidence,
    rationale: summary.rationale,
    strengths: summary.strengths,
    weaknesses: summary.weaknesses,
    recommendedGoals: summary.recommendedGoals,
    turnsEvaluated: answered.length,
    accuracy,
  };
  const completed: PlacementSession = {
    ...session,
    status: 'completed',
    result,
    completedAt,
    updatedAt: completedAt,
  };

  updatePlacementSession(completed);

  return {
    session: completed,
    result,
    profile: input.applyToProfile
      ? applyResultToProfile(completed, result, profile, completedAt)
      : null,
  };
}
