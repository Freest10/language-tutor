/**
 * Состояние мастера определения уровня: интро → диалог → результат.
 *
 * Источник правды — кэш TanStack Query по ключу `['placement', 'session', id]`
 * в форме `{ session, nextTurn }`: и ответ сервера на создание сессии, и ответ
 * на ход, и восстановление после перезагрузки кладут туда одну и ту же
 * структуру, поэтому компонентам всё равно, откуда пришли данные.
 *
 * Идентификатор сессии хранится в localStorage: незавершённый тест переживает
 * перезагрузку страницы, а история подтягивается через
 * `GET /api/placement/sessions/:id`.
 *
 * Отказ языковой модели (501 `not_configured`, 502 `upstream_error`,
 * 503 `upstream_unavailable`) не теряет прогресс: сессия остаётся на сервере,
 * поэтому ошибка держится в отдельном состоянии вместе с действием, которое
 * её вызвало, и `retry()` повторяет ровно это действие.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import {
  PLACEMENT_DEFAULT_MAX_TURNS,
  type CreatePlacementSessionResponse,
  type FinishPlacementSessionResponse,
  type MessageSource,
  type PlacementResult,
  type PlacementSession,
  type PlacementTurn,
  type SubmitPlacementTurnResponse,
} from '@lt/shared';

import { ApiError, isApiError } from '../../api/client';
import {
  createPlacementSession,
  finishPlacementSession,
  getPlacementSession,
  submitPlacementTurn,
  type PlacementAnswerInput,
} from '../../api/placement';
import { useApiErrorMessage, useT } from '../../i18n/useT';
import {
  PLACEMENT_SESSION_STORAGE_KEY,
  readStoredValue,
  removeStoredValue,
  writeStoredValue,
} from '../../lib/storage';
import { profileQueryKeys } from '../profile/useProfile';

/** Ключ localStorage с идентификатором начатой сессии. */
export { PLACEMENT_SESSION_STORAGE_KEY };

/** Корень ключей запросов фичи: по нему инвалидируется весь мастер. */
export const PLACEMENT_QUERY_KEY = ['placement'] as const;

/** Ключи запросов определения уровня. */
export const placementQueryKeys = {
  /** Вся фича целиком. */
  all: PLACEMENT_QUERY_KEY,
  /** Конкретная сессия вместе с незаданным вопросом. */
  session: (sessionId: string) => [...PLACEMENT_QUERY_KEY, 'session', sessionId] as const,
};

/** Идентификатор начатой сессии; `null` — начатого теста нет. */
export function readStoredPlacementSessionId(): string | null {
  return readStoredValue(PLACEMENT_SESSION_STORAGE_KEY);
}

/** Запоминает сессию, чтобы тест пережил перезагрузку страницы. */
export function storePlacementSessionId(sessionId: string): void {
  writeStoredValue(PLACEMENT_SESSION_STORAGE_KEY, sessionId);
}

/** Забывает сессию: тест пройден заново или сервер её не знает. */
export function clearStoredPlacementSessionId(): void {
  removeStoredValue(PLACEMENT_SESSION_STORAGE_KEY);
}

/** Как получен ответ: сведения, которые уходят вместе с ним на сервер. */
export interface PlacementAnswerOptions {
  /** Набран руками или распознан из речи; по умолчанию `text`. */
  source?: MessageSource;
  /** Сколько времени ушло на ответ, миллисекунды. */
  durationMs?: number;
}

/** Шаг мастера: объяснение, диалог с вопросами, итоговый уровень. */
export type PlacementStage = 'intro' | 'chat' | 'result';

/** Действие, которое обращается к серверу; по нему `retry()` понимает, что повторять. */
export type PlacementAction = 'start' | 'answer' | 'finish' | 'restore';

/** Отказ сервера вместе с действием, которое его вызвало. */
export interface PlacementFailure {
  action: PlacementAction;
  error: ApiError;
}

/** Данные сессии в кэше: ответ сервера на создание, ход или восстановление. */
type PlacementSnapshot = CreatePlacementSessionResponse;

/** Состояние и действия мастера определения уровня. */
export interface UsePlacementResult {
  /** Шаг мастера, который нужно показать. */
  stage: PlacementStage;
  /** Сессия с сервера; `null` — тест ещё не начат или история не загружена. */
  session: PlacementSession | null;
  /** Заданные вопросы вместе с ответами — лента диалога без текущего вопроса. */
  history: PlacementTurn[];
  /** Вопрос, на который ждут ответа; `null` — вопросы кончились. */
  currentTurn: PlacementTurn | null;
  /** Итог теста; `null` — тест ещё идёт. */
  result: PlacementResult | null;
  /** Номер текущего вопроса, с единицы. */
  questionNumber: number;
  /** Сколько вопросов планировалось задать. */
  maxTurns: number;
  /** Сколько вопросов уже отвечено. */
  answeredCount: number;
  /** Уровень записан в профиль ответом `/finish`. */
  appliedToProfile: boolean;
  /** Идёт загрузка истории начатого теста. */
  isRestoring: boolean;
  isStarting: boolean;
  isAnswering: boolean;
  isFinishing: boolean;
  /** Любое обращение к серверу в процессе: ввод и кнопки блокируются. */
  isBusy: boolean;
  /** Последний отказ сервера вместе с действием; `null` — ошибки нет. */
  failure: PlacementFailure | null;
  /** Начинает новый тест. */
  start: () => void;
  /** Отправляет ответ на текущий вопрос. */
  answer: (text: string, options?: PlacementAnswerOptions) => void;
  /** Завершает тест и записывает уровень в профиль; он же повтор записи. */
  finish: () => void;
  /** Забывает сессию и возвращает мастер к интро. */
  restart: () => void;
  /** Повторяет последнее неудавшееся действие. */
  retry: () => void;
}

/** Ход уже отвечен: у него есть текст ответа. */
function isAnswered(turn: PlacementTurn): boolean {
  return typeof turn.answer === 'string' && turn.answer.length > 0;
}

/**
 * Добавляет оценённый ход в сессию.
 *
 * Сервер и так возвращает сессию целиком, но если в её `turns` не оказалось
 * последнего хода, лента диалога потеряла бы ответ прямо на глазах у ученика.
 */
function withEvaluatedTurn(session: PlacementSession, evaluated: PlacementTurn): PlacementSession {
  const turns = session.turns.some((turn) => turn.id === evaluated.id)
    ? session.turns.map((turn) => (turn.id === evaluated.id ? evaluated : turn))
    : [...session.turns, evaluated];

  return { ...session, turns: [...turns].sort((left, right) => left.order - right.order) };
}

/** Данные мастера после отправки ответа. */
function snapshotFromTurn(response: SubmitPlacementTurnResponse): PlacementSnapshot {
  return {
    session: withEvaluatedTurn(response.session, response.evaluatedTurn),
    nextTurn: response.nextTurn ?? null,
  };
}

/** Данные мастера после завершения теста: итог кладётся прямо в сессию. */
function snapshotFromFinish(response: FinishPlacementSessionResponse): PlacementSnapshot {
  return {
    session: { ...response.session, result: response.session.result ?? response.result },
    nextTurn: null,
  };
}

/**
 * Мастер определения уровня: данные сессии, шаг мастера и действия над ним.
 *
 * Хук сам решает, что показывать: пока в localStorage лежит начатая сессия,
 * мастер открывается на диалоге и подгружает историю, а не начинает заново.
 */
export function usePlacement(): UsePlacementResult {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(() => readStoredPlacementSessionId());
  const [failure, setFailure] = useState<PlacementFailure | null>(null);
  const [lastAnswer, setLastAnswer] = useState<PlacementAnswerInput | null>(null);
  const [appliedToProfile, setAppliedToProfile] = useState(false);

  const sessionQuery = useQuery<PlacementSnapshot, ApiError>({
    queryKey: placementQueryKeys.session(sessionId ?? ''),
    queryFn: async ({ signal }) => {
      try {
        return await getPlacementSession(sessionId ?? '', signal);
      } catch (error) {
        // Сервер не знает такой сессии (её удалили или пересоздали базу):
        // запомненный идентификатор бесполезен, начинать придётся заново.
        if (isApiError(error) && error.isNotFound) {
          clearStoredPlacementSessionId();
        }

        throw error;
      }
    },
    enabled: sessionId !== null,
    // Сессию меняют только мутации этого хука: они же и обновляют кэш.
    staleTime: Number.POSITIVE_INFINITY,
  });

  /** Забытая сервером сессия равнозначна её отсутствию: мастер открывает интро. */
  const sessionMissing = isApiError(sessionQuery.error) && sessionQuery.error.isNotFound;
  const activeSessionId = sessionMissing ? null : sessionId;

  /** Кладёт свежие данные сессии в кэш и делает её текущей. */
  const applySnapshot = useCallback(
    (snapshot: PlacementSnapshot): void => {
      queryClient.setQueryData<PlacementSnapshot>(
        placementQueryKeys.session(snapshot.session.id),
        snapshot,
      );
      setSessionId(snapshot.session.id);
    },
    [queryClient],
  );

  const finishMutation = useMutation<FinishPlacementSessionResponse, ApiError, void>({
    mutationFn: () => finishPlacementSession(activeSessionId ?? '', { applyToProfile: true }),
    onMutate: () => {
      setFailure(null);
    },
    onSuccess: (response) => {
      applySnapshot(snapshotFromFinish(response));
      setAppliedToProfile(Boolean(response.profile));

      if (response.profile) {
        // Уровень в профиле изменился: страница профиля должна это увидеть.
        queryClient.setQueryData(profileQueryKeys.detail(), response.profile);
        void queryClient.invalidateQueries({ queryKey: profileQueryKeys.all });
      }
    },
    onError: (error) => {
      setFailure({ action: 'finish', error });
    },
  });

  const startMutation = useMutation<CreatePlacementSessionResponse, ApiError, void>({
    mutationFn: () => createPlacementSession(),
    onMutate: () => {
      setFailure(null);
    },
    onSuccess: (response) => {
      storePlacementSessionId(response.session.id);
      setAppliedToProfile(false);
      setLastAnswer(null);
      applySnapshot({ session: response.session, nextTurn: response.nextTurn ?? null });
    },
    onError: (error) => {
      setFailure({ action: 'start', error });
    },
  });

  const answerMutation = useMutation<SubmitPlacementTurnResponse, ApiError, PlacementAnswerInput>({
    mutationFn: (input) => submitPlacementTurn(activeSessionId ?? '', input),
    onMutate: (input) => {
      setLastAnswer(input);
      setFailure(null);
    },
    onSuccess: (response) => {
      applySnapshot(snapshotFromTurn(response));
      setLastAnswer(null);

      // Вопросы кончились: итог нужен сразу, отдельной кнопки ждать незачем.
      if (response.finished) {
        finishMutation.mutate();
      }
    },
    onError: (error) => {
      setFailure({ action: 'answer', error });
    },
  });

  const snapshot = activeSessionId === null ? undefined : sessionQuery.data;
  const session = snapshot?.session ?? null;

  const { history, currentTurn } = useMemo(() => {
    if (!session) {
      return { history: [] as PlacementTurn[], currentTurn: null };
    }

    const turns = [...session.turns].sort((left, right) => left.order - right.order);
    // Незаданный вопрос сервер может вернуть и в `nextTurn`, и уже внутри `turns`.
    const pending = snapshot?.nextTurn ?? turns.find((turn) => !isAnswered(turn)) ?? null;

    return {
      history: turns.filter((turn) => turn.id !== pending?.id),
      currentTurn: session.status === 'in_progress' ? pending : null,
    };
  }, [session, snapshot]);

  const result = session?.result ?? null;
  const answeredCount = history.filter(isAnswered).length;
  const maxTurns = session?.maxTurns ?? PLACEMENT_DEFAULT_MAX_TURNS;

  const start = useCallback((): void => {
    startMutation.mutate();
  }, [startMutation]);

  const answer = useCallback(
    (text: string, options: PlacementAnswerOptions = {}): void => {
      if (!currentTurn) {
        return;
      }

      answerMutation.mutate({
        turnId: currentTurn.id,
        answer: text,
        source: options.source ?? 'text',
        ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
      });
    },
    [answerMutation, currentTurn],
  );

  const finish = useCallback((): void => {
    if (activeSessionId === null) {
      return;
    }

    finishMutation.mutate();
  }, [activeSessionId, finishMutation]);

  const restart = useCallback((): void => {
    clearStoredPlacementSessionId();
    setSessionId(null);
    setFailure(null);
    setLastAnswer(null);
    setAppliedToProfile(false);
    startMutation.reset();
    answerMutation.reset();
    finishMutation.reset();
  }, [answerMutation, finishMutation, startMutation]);

  // Забытую сессию мастер не показывает как отказ: интро с чистого листа понятнее.
  const restoreFailure: PlacementFailure | null =
    !failure && !sessionMissing && isApiError(sessionQuery.error)
      ? { action: 'restore', error: sessionQuery.error }
      : null;
  const currentFailure = failure ?? restoreFailure;

  const retry = useCallback((): void => {
    switch (currentFailure?.action) {
      case 'start':
        startMutation.mutate();
        break;
      case 'answer':
        if (lastAnswer) {
          answerMutation.mutate(lastAnswer);
        }

        break;
      case 'finish':
        finishMutation.mutate();
        break;
      case 'restore':
        void sessionQuery.refetch();
        break;
      default:
        break;
    }
  }, [answerMutation, currentFailure, finishMutation, lastAnswer, sessionQuery, startMutation]);

  const stage: PlacementStage =
    activeSessionId === null
      ? 'intro'
      : result
        ? 'result'
        : session?.status === 'abandoned'
          ? 'intro'
          : 'chat';

  return {
    stage,
    session,
    history,
    currentTurn,
    result,
    questionNumber: currentTurn ? currentTurn.order + 1 : answeredCount,
    maxTurns,
    answeredCount,
    appliedToProfile,
    isRestoring: activeSessionId !== null && session === null && !sessionQuery.isError,
    isStarting: startMutation.isPending,
    isAnswering: answerMutation.isPending,
    isFinishing: finishMutation.isPending,
    isBusy: startMutation.isPending || answerMutation.isPending || finishMutation.isPending,
    failure: currentFailure,
    start,
    answer,
    finish,
    restart,
    retry,
  };
}

/**
 * Сообщение об отказе для пользователя.
 *
 * Отдельно от общего `useApiErrorMessage`, потому что у мастера три отказа
 * читаются иначе: 501 `not_configured` означает ненастроенную модель (а не
 * «возможность не реализована»), 502 и 503 — что ответы никуда не делись
 * и попытку можно повторить.
 */
export function usePlacementErrorMessage(): (error: unknown) => string {
  const t = useT('placement');
  const fallbackMessage = useApiErrorMessage();

  return useCallback(
    (error: unknown): string => {
      if (!isApiError(error)) {
        return fallbackMessage(error);
      }

      if (error.isNotConfigured) {
        return t('errors.notConfigured');
      }

      // Обрыв связи и таймаут приходят с тем же кодом, но им есть общий текст.
      if (error.isTimeout || error.isNetworkError) {
        return fallbackMessage(error);
      }

      if (error.code === 'upstream_unavailable') {
        return t('errors.upstreamUnavailable');
      }

      if (error.code === 'upstream_error') {
        return t('errors.upstreamError');
      }

      return fallbackMessage(error);
    },
    [fallbackMessage, t],
  );
}
