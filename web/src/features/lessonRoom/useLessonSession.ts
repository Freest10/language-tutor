/**
 * Состояние комнаты урока: лента реплик, шаг плана, задания и итог.
 *
 * Урок — общий для всего приложения ресурс, поэтому источник правды по нему
 * остаётся чужим кэшем `lessonsQueryKeys.detail(id)` в форме `GetLessonResponse`:
 * каждая мутация комнаты кладёт туда свежий урок вместе с новыми заданиями
 * и попытками, иначе план в комнате и список уроков разъезжаются.
 *
 * Лента реплик — свой кэш `['lessonRoom', 'messages', id]`: после перезагрузки
 * она восстанавливается запросом `GET /api/lessons/:id/messages`, а ответы
 * на реплики и переходы по шагам просто дописываются в тот же массив.
 *
 * Реплика ученика не теряется при отказе модели: до ответа сервера она живёт
 * в состоянии как «отправляется», при отказе остаётся в ленте с пометкой
 * и кнопкой повтора, и только успешный ответ заменяет её сохранённой репликой.
 *
 * Голос: распознанный текст не уходит на сервер сам — он попадает в поле ввода
 * (`useVoiceDraft`), ученик правит его и отправляет; вместе с текстом уходят
 * `source: 'voice'` и длительность записи.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';

import type {
  AdvanceLessonStepResponse,
  CompleteLessonResponse,
  CreateExerciseAttemptResponse,
  Exercise,
  ExerciseAttempt,
  GetLessonResponse,
  Lesson,
  LessonMessage,
  LessonPlanStep,
  LessonTurnResponse,
  MessageSource,
  StartLessonResponse,
} from '@lt/shared';

import { ApiError, isApiError } from '../../api/client';
import {
  advanceLessonStep,
  completeLesson,
  createExerciseAttempt,
  LESSON_MESSAGES_PAGE_SIZE,
  listLessonMessages,
  startLesson,
  submitLessonTurn,
  type ExerciseAttemptInput,
  type LessonTurnInput,
} from '../../api/lessonSession';
import { lessonErrorReason } from '../../api/lessons';
import { useT } from '../../i18n/useT';
import { LESSON_ROOM_AUTO_SPEAK_KEY, readStoredValue, writeStoredValue } from '../../lib/storage';
import {
  lessonsQueryKeys,
  sortLessonPlan,
  useLesson,
  useLessonErrorMessage,
} from '../lessons/useLessons';
import type { VoiceInputResult } from '../voice/useVoiceInput';

/** Корень ключей запросов комнаты урока. */
export const LESSON_ROOM_QUERY_KEY = ['lessonRoom'] as const;

/** Ключи запросов комнаты урока. */
export const lessonRoomQueryKeys = {
  /** Вся комната целиком. */
  all: LESSON_ROOM_QUERY_KEY,
  /** Лента реплик конкретного урока. */
  messages: (lessonId: string) => [...LESSON_ROOM_QUERY_KEY, 'messages', lessonId] as const,
};

/** Ключ localStorage с тумблером автоозвучки ответов тьютора. */
export { LESSON_ROOM_AUTO_SPEAK_KEY };

/** Обращение к серверу, которое может отказать; по нему `retry()` понимает, что повторять. */
export type LessonSessionAction = 'start' | 'turn' | 'advance' | 'attempt' | 'complete' | 'restore';

/** Отказ сервера вместе с действием, которое его вызвало. */
export interface LessonSessionFailure {
  action: LessonSessionAction;
  error: ApiError;
}

/** Как получена реплика или ответ на задание. */
export interface LessonAnswerOptions {
  /** Набрано руками или надиктовано; по умолчанию `text`. */
  source?: MessageSource;
  /** Длительность записи, миллисекунды. */
  durationMs?: number;
}

/** Реплика ученика, которая ещё не подтверждена сервером. */
export interface PendingTurn {
  /** Реплика для ленты: живёт только на клиенте, пока сервер не ответил. */
  message: LessonMessage;
  /** Отправляется прямо сейчас или отказала и ждёт повтора. */
  state: 'sending' | 'failed';
}

/** Разбор последнего ответа на задание. */
export interface ExerciseFeedback {
  attempt: ExerciseAttempt;
  exercise: Exercise;
  /** Следующее задание шага; `null` — задания кончились. */
  nextExercise: Exercise | null;
}

/** Состояние и действия комнаты урока. */
export interface UseLessonSessionResult {
  lesson: Lesson | null;
  /** Шаги плана в порядке `order`. */
  plan: LessonPlanStep[];
  /** Шаг, на котором урок сейчас находится; `null` — урок не начат или пройден. */
  currentStep: LessonPlanStep | null;
  /** Лента реплик от старых к новым, без неподтверждённой реплики. */
  messages: LessonMessage[];
  /** Реплика ученика, которую сервер ещё не подтвердил; `null` — такой нет. */
  pendingTurn: PendingTurn | null;
  /** Последняя реплика тьютора — её озвучивает автоозвучка. */
  lastTutorMessage: LessonMessage | null;
  /** Часть ленты осталась за пределами страницы: показаны последние реплики. */
  hasOlderMessages: boolean;
  /** Задания урока в порядке `order`. */
  exercises: Exercise[];
  /** Задание, которое ученик выполняет сейчас; `null` — заданий нет. */
  activeExercise: Exercise | null;
  /** Разбор последнего ответа; `null` — ответа ещё не было. */
  feedback: ExerciseFeedback | null;
  /** Итог завершённого урока вместе с изменением уровня; `null` — урок не завершён. */
  completion: CompleteLessonResponse | null;
  isRestoring: boolean;
  isStarting: boolean;
  isSending: boolean;
  isAdvancing: boolean;
  isAnswering: boolean;
  isCompleting: boolean;
  /** Модель думает над ответом: повторная отправка запрещена. */
  isThinking: boolean;
  /** Урок не удалось прочитать. */
  isError: boolean;
  /** Отказ чтения урока; `null` — урок прочитан. */
  loadError: ApiError | null;
  /** Отказ последнего обращения к серверу; `null` — отказа не было. */
  failure: LessonSessionFailure | null;
  /** Запускает урок: статус меняется на `in_progress`. */
  start: () => void;
  /** Отправляет реплику ученика. */
  sendTurn: (text: string, options?: LessonAnswerOptions) => void;
  /** Закрывает шаг плана и переходит к следующему. */
  advanceStep: (stepId: string, status?: 'completed' | 'skipped') => void;
  /** Отправляет ответ на задание. */
  answerExercise: (exerciseId: string, answer: string, options?: LessonAnswerOptions) => void;
  /** Переходит к следующему заданию и убирает разбор предыдущего. */
  goToNextExercise: () => void;
  /** Завершает урок и запрашивает итог. */
  complete: () => void;
  /** Повторяет последнее неудавшееся обращение к серверу. */
  retry: () => void;
  /** Перечитывает урок и ленту реплик. */
  refresh: () => void;
}

/** Объединяет списки по `id`: новые записи заменяют одноимённые старые. */
function mergeById<Item extends { id: string }>(
  previous: readonly Item[],
  next: readonly Item[],
): Item[] {
  if (next.length === 0) {
    return [...previous];
  }

  const byId = new Map(previous.map((item) => [item.id, item]));

  for (const item of next) {
    byId.set(item.id, item);
  }

  return [...byId.values()];
}

/** Лента в порядке появления: сервер отдаёт реплики по времени создания. */
function sortMessages(messages: readonly LessonMessage[]): LessonMessage[] {
  return [...messages].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
}

/** Задания в порядке `order`: сервер не обязан присылать их отсортированными. */
function sortExercises(exercises: readonly Exercise[]): Exercise[] {
  return [...exercises].sort((left, right) => left.order - right.order);
}

/** Отвечено ли задание верно: повторять такое не нужно. */
function isSolved(exercise: Exercise, attempts: readonly ExerciseAttempt[]): boolean {
  return attempts.some((attempt) => attempt.exerciseId === exercise.id && attempt.isCorrect);
}

/**
 * Задание, которое стоит показать: первое нерешённое текущего шага,
 * а если таких нет — первое нерешённое во всём уроке.
 */
function pickActiveExercise(
  exercises: readonly Exercise[],
  attempts: readonly ExerciseAttempt[],
  currentStepId: string | null,
): Exercise | null {
  const unsolved = exercises.filter((exercise) => !isSolved(exercise, attempts));

  if (currentStepId !== null) {
    const ofStep = unsolved.find((exercise) => exercise.stepId === currentStepId);

    if (ofStep) {
      return ofStep;
    }
  }

  return unsolved[0] ?? null;
}

/** Тумблер автоозвучки ответов тьютора: выбор переживает перезагрузку страницы. */
export function useAutoSpeak(): [boolean, (value: boolean) => void] {
  // Значения нет — озвучиваем: тумблер включён по умолчанию.
  const [enabled, setEnabled] = useState<boolean>(
    () => readStoredValue(LESSON_ROOM_AUTO_SPEAK_KEY) !== 'off',
  );

  const update = useCallback((value: boolean): void => {
    setEnabled(value);
    writeStoredValue(LESSON_ROOM_AUTO_SPEAK_KEY, value ? 'on' : 'off');
  }, []);

  return [enabled, update];
}

/** Черновик реплики: набранный текст и сведения о распознавании. */
export interface VoiceDraft {
  /** Текущий текст поля ввода. */
  text: string;
  /** Правка текста учеником; распознанное остаётся помеченным как голос. */
  setText: (value: string) => void;
  /** Откуда взялся текст: набран руками или надиктован. */
  source: MessageSource;
  /** Длительность записи, миллисекунды; `undefined` — текст набран руками. */
  durationMs: number | undefined;
  /** Расшифровка попала в поле: ученик правит её перед отправкой. */
  applyVoiceResult: (result: VoiceInputResult) => void;
  /** Очищает поле после отправки. */
  clear: () => void;
}

/**
 * Черновик реплики с распознаванием.
 *
 * Распознавание неидеально, поэтому расшифровка не уходит на сервер сама:
 * она дописывается в поле ввода, ученик правит её и отправляет сам. Пометка
 * `source: 'voice'` и длительность записи при правке сохраняются — реплика
 * всё равно была надиктована.
 */
export function useVoiceDraft(): VoiceDraft {
  const [text, setTextValue] = useState('');
  const [voice, setVoice] = useState<{ durationMs: number | undefined } | null>(null);

  const setText = useCallback((value: string): void => {
    setTextValue(value);

    if (value.trim().length === 0) {
      // Поле опустошили: следующая реплика будет набрана руками.
      setVoice(null);
    }
  }, []);

  const applyVoiceResult = useCallback((result: VoiceInputResult): void => {
    setTextValue((previous) => {
      const prefix = previous.trim();

      return prefix.length > 0 ? `${prefix} ${result.text}` : result.text;
    });
    setVoice({ durationMs: result.durationMs ?? undefined });
  }, []);

  const clear = useCallback((): void => {
    setTextValue('');
    setVoice(null);
  }, []);

  return {
    text,
    setText,
    source: voice ? 'voice' : 'text',
    durationMs: voice?.durationMs,
    applyVoiceResult,
    clear,
  };
}

/**
 * Сообщение об отказе для пользователя.
 *
 * Общие отказы модели (501, 502, 503) уже разобраны в `useLessonErrorMessage`;
 * здесь добавлены только причины, которые встречаются в ходе урока.
 */
export function useLessonSessionErrorMessage(): (error: unknown) => string {
  const t = useT('lessonRoom');
  const fallbackMessage = useLessonErrorMessage();

  return useCallback(
    (error: unknown): string => {
      if (!isApiError(error)) {
        return fallbackMessage(error);
      }

      switch (lessonErrorReason(error)) {
        case 'lesson_not_started':
          return t('errors.notStarted');
        case 'lesson_already_completed':
          return t('errors.alreadyCompleted');
        case 'step_not_found':
          return t('errors.stepNotFound');
        case 'exercise_not_found':
          return t('errors.exerciseNotFound');
        default:
          return fallbackMessage(error);
      }
    },
    [fallbackMessage, t],
  );
}

/** Локальная реплика ученика: живёт в ленте, пока сервер не подтвердил её. */
function localUserMessage(
  lessonId: string,
  input: LessonTurnInput,
  language: Lesson['learningLanguage'] | null,
): LessonMessage {
  return {
    id: `local-${Date.now()}`,
    lessonId,
    stepId: input.stepId ?? null,
    role: 'user',
    source: input.source ?? 'text',
    content: input.text,
    language,
    corrections: [],
    audioPath: null,
    durationMs: input.durationMs ?? null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Комната урока: данные урока, лента реплик и действия над ними.
 *
 * @param lessonId идентификатор урока; пустая строка — запросы не отправляются.
 */
export function useLessonSession(lessonId: string): UseLessonSessionResult {
  const queryClient = useQueryClient();
  const enabled = lessonId.length > 0;
  const lessonQuery = useLesson(enabled ? lessonId : null);

  const [failure, setFailure] = useState<LessonSessionFailure | null>(null);
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null);
  const [feedback, setFeedback] = useState<ExerciseFeedback | null>(null);
  const [completion, setCompletion] = useState<CompleteLessonResponse | null>(null);
  const [selectedExerciseId, setSelectedExerciseId] = useState<string | null>(null);
  const [serverStep, setServerStep] = useState<LessonPlanStep | null>(null);

  // Что повторять по `retry()`: последнее обращение, закончившееся отказом.
  const lastTurnRef = useRef<LessonTurnInput | null>(null);
  const lastAdvanceRef = useRef<{ stepId: string; status: 'completed' | 'skipped' } | null>(null);
  const lastAttemptRef = useRef<{ exerciseId: string; input: ExerciseAttemptInput } | null>(null);

  const messagesQuery = useQuery<{ items: LessonMessage[]; hasMore: boolean }, ApiError>({
    queryKey: lessonRoomQueryKeys.messages(lessonId),
    queryFn: async ({ signal }) => {
      // Последние реплики важнее первых: читаем хвост ленты и разворачиваем его.
      const page = await listLessonMessages(
        lessonId,
        { limit: LESSON_MESSAGES_PAGE_SIZE, order: 'desc' },
        signal,
      );

      return { items: sortMessages(page.items), hasMore: page.hasMore };
    },
    enabled,
    // Ленту меняют только мутации этого хука: они же дописывают в неё реплики.
    staleTime: Number.POSITIVE_INFINITY,
  });

  /** Дописывает реплики в ленту, не дублируя уже известные. */
  const appendMessages = useCallback(
    (added: readonly LessonMessage[]): void => {
      if (added.length === 0) {
        return;
      }

      queryClient.setQueryData<{ items: LessonMessage[]; hasMore: boolean }>(
        lessonRoomQueryKeys.messages(lessonId),
        (previous) => ({
          items: sortMessages(mergeById(previous?.items ?? [], added)),
          hasMore: previous?.hasMore ?? false,
        }),
      );
    },
    [lessonId, queryClient],
  );

  /**
   * Кладёт свежий урок в общий кэш `['lessons', 'detail', id]`.
   *
   * Список уроков после этого перечитывается: статус урока и текущий шаг
   * видны и на соседних экранах.
   */
  const applyLesson = useCallback(
    (lesson: Lesson, added: readonly Exercise[] = [], attempt?: ExerciseAttempt): void => {
      queryClient.setQueryData<GetLessonResponse>(
        lessonsQueryKeys.detail(lessonId),
        (previous) => ({
          lesson,
          exercises: sortExercises(mergeById(previous?.exercises ?? [], added)),
          attempts: attempt
            ? mergeById(previous?.attempts ?? [], [attempt])
            : (previous?.attempts ?? []),
        }),
      );
      void queryClient.invalidateQueries({ queryKey: lessonsQueryKeys.lists() });
    },
    [lessonId, queryClient],
  );

  const startMutation = useMutation<StartLessonResponse, ApiError, void>({
    mutationFn: () => startLesson(lessonId),
    onMutate: () => {
      setFailure(null);
    },
    onSuccess: (response) => {
      applyLesson(response.lesson);
      appendMessages(response.messages);
      setServerStep(response.currentStep ?? null);
    },
    onError: (error) => {
      setFailure({ action: 'start', error });
    },
  });

  const turnMutation = useMutation<LessonTurnResponse, ApiError, LessonTurnInput>({
    mutationFn: (input) => submitLessonTurn(lessonId, input),
    onMutate: (input) => {
      lastTurnRef.current = input;
      setFailure(null);
      setPendingTurn({
        message: localUserMessage(lessonId, input, lessonQuery.lesson?.learningLanguage ?? null),
        state: 'sending',
      });
    },
    onSuccess: (response) => {
      // Сохранённая реплика приходит с сервера: локальная больше не нужна.
      setPendingTurn(null);
      lastTurnRef.current = null;
      appendMessages([response.userMessage, response.tutorMessage]);
      applyLesson(response.lesson, response.exercises);
      setServerStep(response.currentStep ?? null);

      if (response.exercises.length > 0) {
        setFeedback(null);
        setSelectedExerciseId(response.exercises[0]?.id ?? null);
      }
    },
    onError: (error) => {
      // Реплика остаётся в ленте: ученику не придётся набирать её заново.
      setPendingTurn((previous) => (previous ? { ...previous, state: 'failed' } : previous));
      setFailure({ action: 'turn', error });
    },
  });

  const advanceMutation = useMutation<
    AdvanceLessonStepResponse,
    ApiError,
    { stepId: string; status: 'completed' | 'skipped' }
  >({
    mutationFn: ({ stepId, status }) => advanceLessonStep(lessonId, stepId, { status }),
    onMutate: (variables) => {
      lastAdvanceRef.current = variables;
      setFailure(null);
    },
    onSuccess: (response) => {
      lastAdvanceRef.current = null;
      applyLesson(response.lesson, response.exercises);
      appendMessages(response.messages);
      setServerStep(response.currentStep ?? null);
      setFeedback(null);
      setSelectedExerciseId(response.exercises[0]?.id ?? null);
    },
    onError: (error) => {
      setFailure({ action: 'advance', error });
    },
  });

  const attemptMutation = useMutation<
    CreateExerciseAttemptResponse,
    ApiError,
    { exerciseId: string; input: ExerciseAttemptInput }
  >({
    mutationFn: ({ exerciseId, input }) => createExerciseAttempt(lessonId, exerciseId, input),
    onMutate: (variables) => {
      lastAttemptRef.current = variables;
      setFailure(null);
    },
    onSuccess: (response) => {
      lastAttemptRef.current = null;
      applyLesson(
        response.lesson,
        response.nextExercise ? [response.exercise, response.nextExercise] : [response.exercise],
        response.attempt,
      );
      appendMessages(response.messages);
      setFeedback({
        attempt: response.attempt,
        exercise: response.exercise,
        nextExercise: response.nextExercise ?? null,
      });
      setSelectedExerciseId(response.exercise.id);
    },
    onError: (error) => {
      setFailure({ action: 'attempt', error });
    },
  });

  const completeMutation = useMutation<CompleteLessonResponse, ApiError, void>({
    mutationFn: () => completeLesson(lessonId),
    onMutate: () => {
      setFailure(null);
    },
    onSuccess: (response) => {
      applyLesson(response.lesson);
      setCompletion(response);
      setServerStep(null);
    },
    onError: (error) => {
      setFailure({ action: 'complete', error });
    },
  });

  const lesson = lessonQuery.lesson;
  const plan = lessonQuery.plan;
  const exercises = useMemo(() => sortExercises(lessonQuery.exercises), [lessonQuery.exercises]);
  const attempts = lessonQuery.attempts;
  const currentStepId = lesson?.currentStepId ?? null;

  const currentStep = useMemo((): LessonPlanStep | null => {
    if (currentStepId === null) {
      return null;
    }

    const fromPlan = sortLessonPlan(plan).find((step) => step.id === currentStepId);

    // Шаг мог прийти ответом сервера раньше, чем урок перечитался целиком.
    return fromPlan ?? (serverStep?.id === currentStepId ? serverStep : null);
  }, [currentStepId, plan, serverStep]);

  const messages = useMemo(() => messagesQuery.data?.items ?? [], [messagesQuery.data?.items]);

  const lastTutorMessage = useMemo(
    () => [...messages].reverse().find((message) => message.role === 'tutor') ?? null,
    [messages],
  );

  const activeExercise = useMemo((): Exercise | null => {
    if (selectedExerciseId !== null) {
      const selected = exercises.find((exercise) => exercise.id === selectedExerciseId);

      if (selected) {
        return selected;
      }
    }

    return pickActiveExercise(exercises, attempts, currentStepId);
  }, [attempts, currentStepId, exercises, selectedExerciseId]);

  const start = useCallback((): void => {
    startMutation.mutate();
  }, [startMutation]);

  const sendTurn = useCallback(
    (text: string, options: LessonAnswerOptions = {}): void => {
      const trimmed = text.trim();

      if (trimmed.length === 0) {
        return;
      }

      turnMutation.mutate({
        text: trimmed,
        source: options.source ?? 'text',
        ...(currentStepId === null ? {} : { stepId: currentStepId }),
        ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
      });
    },
    [currentStepId, turnMutation],
  );

  const advanceStep = useCallback(
    (stepId: string, status: 'completed' | 'skipped' = 'completed'): void => {
      advanceMutation.mutate({ stepId, status });
    },
    [advanceMutation],
  );

  const answerExercise = useCallback(
    (exerciseId: string, answer: string, options: LessonAnswerOptions = {}): void => {
      const trimmed = answer.trim();

      if (trimmed.length === 0) {
        return;
      }

      attemptMutation.mutate({
        exerciseId,
        input: {
          answer: trimmed,
          source: options.source ?? 'text',
          ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
        },
      });
    },
    [attemptMutation],
  );

  const goToNextExercise = useCallback((): void => {
    setSelectedExerciseId(feedback?.nextExercise?.id ?? null);
    setFeedback(null);
  }, [feedback]);

  const complete = useCallback((): void => {
    completeMutation.mutate();
  }, [completeMutation]);

  const refresh = useCallback((): void => {
    lessonQuery.refetch();
    void messagesQuery.refetch();
  }, [lessonQuery, messagesQuery]);

  // Отказ чтения ленты показывается как отказ восстановления: сама комната жива.
  // Объявляется ДО retry: иначе повтор ветвится по пустому failure и ветка
  // 'restore' становится недостижимой — кнопка «Повторить» под баннером
  // молча ничего не делает.
  const restoreFailure: LessonSessionFailure | null =
    !failure && messagesQuery.error ? { action: 'restore', error: messagesQuery.error } : null;

  const activeFailure = failure ?? restoreFailure;

  const retry = useCallback((): void => {
    switch (activeFailure?.action) {
      case 'start':
        startMutation.mutate();
        break;
      case 'turn':
        if (lastTurnRef.current) {
          turnMutation.mutate(lastTurnRef.current);
        }

        break;
      case 'advance':
        if (lastAdvanceRef.current) {
          advanceMutation.mutate(lastAdvanceRef.current);
        }

        break;
      case 'attempt':
        if (lastAttemptRef.current) {
          attemptMutation.mutate(lastAttemptRef.current);
        }

        break;
      case 'complete':
        completeMutation.mutate();
        break;
      case 'restore':
        refresh();
        break;
      default:
        break;
    }
  }, [
    activeFailure,
    advanceMutation,
    attemptMutation,
    completeMutation,
    refresh,
    startMutation,
    turnMutation,
  ]);

  const isThinking =
    startMutation.isPending ||
    turnMutation.isPending ||
    advanceMutation.isPending ||
    attemptMutation.isPending ||
    completeMutation.isPending;

  return {
    lesson,
    plan,
    currentStep,
    messages,
    pendingTurn,
    lastTutorMessage,
    hasOlderMessages: messagesQuery.data?.hasMore ?? false,
    exercises,
    activeExercise,
    feedback,
    completion,
    isRestoring: lessonQuery.isLoading || (enabled && messagesQuery.isLoading),
    isStarting: startMutation.isPending,
    isSending: turnMutation.isPending,
    isAdvancing: advanceMutation.isPending,
    isAnswering: attemptMutation.isPending,
    isCompleting: completeMutation.isPending,
    isThinking,
    isError: lessonQuery.isError,
    loadError: lessonQuery.error,
    failure: activeFailure,
    start,
    sendTurn,
    advanceStep,
    answerExercise,
    goToNextExercise,
    complete,
    retry,
    refresh,
  };
}
