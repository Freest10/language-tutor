/**
 * Данные раздела уроков: список, урок целиком, генерация и пересборка плана,
 * а также материалы, которые можно взять в урок.
 *
 * Хуки и ключи запросов вынесены сюда отдельно от компонентов, чтобы комната
 * урока (соседний пакет) переиспользовала ровно те же данные и попадала в тот же
 * кэш: `useLesson(id)` — источник правды по уроку на всех экранах.
 *
 * Соглашение о ключах: первый элемент — namespace фичи (`['lessons', ...]`),
 * поэтому инвалидация по `LESSONS_QUERY_KEY` задевает и список, и просмотр.
 * Мутации инвалидируют именно `lessonsQueryKeys.lists()`: корень накрыл бы и
 * кэш урока, который они только что заполнили ответом сервера.
 * Материалы читаются под тем же корнем (`['lessons', 'materials', ...]`):
 * раздел материалов — соседний пакет со своим кэшем, пересекаться с ним нельзя.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import {
  DEFAULT_PAGE_SIZE,
  isMaterialErrorStatus,
  type CreateLessonRequest,
  type Exercise,
  type ExerciseAttempt,
  type GetLessonResponse,
  type Lesson,
  type LessonPlanStep,
  type LessonStatus,
  type LessonStepStatus,
  type LessonStepType,
  type Material,
  type RegenerateLessonPlanRequest,
} from '@lt/shared';

import { ApiError, isApiError } from '../../api/client';
import {
  createLesson,
  getLesson,
  lessonErrorReason,
  listLessonMaterials,
  listLessons,
  regenerateLessonPlan,
  type ListLessonMaterialsParams,
  type ListLessonsParams,
} from '../../api/lessons';
import { useCapabilities } from '../../context/CapabilitiesProvider';
import { useApiErrorMessage, useLocale, useT } from '../../i18n/useT';
import { formatDate, formatDateTime } from '../../lib/format';

/** Корень ключей запросов фичи: по нему инвалидируется весь раздел. */
export const LESSONS_QUERY_KEY = ['lessons'] as const;

/** Ключи запросов уроков. */
export const lessonsQueryKeys = {
  /** Весь раздел целиком. */
  all: LESSONS_QUERY_KEY,
  /** Все страницы списка: по этому префиксу список перечитывается целиком. */
  lists: () => [...LESSONS_QUERY_KEY, 'list'] as const,
  /** Страница списка с конкретным набором фильтров. */
  list: (params: ListLessonsParams) => [...LESSONS_QUERY_KEY, 'list', params] as const,
  /** Урок вместе с заданиями и попытками. */
  detail: (lessonId: string) => [...LESSONS_QUERY_KEY, 'detail', lessonId] as const,
  /** Материалы, доступные для выбора в урок. */
  materials: (params: ListLessonMaterialsParams) =>
    [...LESSONS_QUERY_KEY, 'materials', params] as const,
};

/** Размер страницы списка уроков. */
export const LESSONS_PAGE_SIZE = DEFAULT_PAGE_SIZE;

/** Размер страницы списка материалов в выборе материалов. */
export const LESSON_MATERIALS_PAGE_SIZE = DEFAULT_PAGE_SIZE;

/** Сколько материалов допускает контракт создания урока. */
export const MAX_LESSON_MATERIALS = 20;

/** Длительности урока на выбор, минуты. */
export const LESSON_DURATION_OPTIONS = [15, 30, 45] as const;

/** Длительность урока из предложенных. */
export type LessonDuration = (typeof LESSON_DURATION_OPTIONS)[number];

/** Значение фильтра по статусу: `all` — без фильтра. */
export type LessonStatusFilter = LessonStatus | 'all';

/** Параметры списка уроков. */
export interface UseLessonsOptions extends ListLessonsParams {
  /** Не ходить на сервер, пока значение `false`. */
  enabled?: boolean;
}

/** Список уроков и состояние его загрузки. */
export interface UseLessonsResult {
  lessons: Lesson[];
  /** Сколько уроков всего на сервере при текущих фильтрах. */
  total: number;
  /** Есть ли уроки за пределами полученной страницы. */
  hasMore: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: ApiError | null;
  refetch: () => void;
}

/** Список уроков пользователя. */
export function useLessons(options: UseLessonsOptions = {}): UseLessonsResult {
  const { enabled = true, ...params } = options;
  const { data, error, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: lessonsQueryKeys.list(params),
    queryFn: ({ signal }) => listLessons(params, signal),
    enabled,
  });

  const refresh = useCallback((): void => {
    void refetch();
  }, [refetch]);

  return {
    lessons: data?.items ?? [],
    total: data?.total ?? 0,
    hasMore: data?.hasMore ?? false,
    isLoading,
    isFetching,
    isError,
    error: error ? ApiError.from(error) : null,
    refetch: refresh,
  };
}

/** Урок вместе с заданиями и попытками. */
export interface UseLessonResult {
  lesson: Lesson | null;
  /** Шаги плана в порядке `order`. */
  plan: LessonPlanStep[];
  exercises: Exercise[];
  attempts: ExerciseAttempt[];
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: ApiError | null;
  refetch: () => void;
}

/** Шаги плана в порядке `order`: сервер не обязан присылать их отсортированными. */
export function sortLessonPlan(plan: readonly LessonPlanStep[]): LessonPlanStep[] {
  return [...plan].sort((left, right) => left.order - right.order);
}

/**
 * Урок целиком.
 *
 * @param lessonId идентификатор урока; пустая строка или `null` — запрос не отправляется.
 */
export function useLesson(lessonId: string | null): UseLessonResult {
  const enabled = typeof lessonId === 'string' && lessonId.length > 0;
  const { data, error, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: lessonsQueryKeys.detail(lessonId ?? ''),
    queryFn: ({ signal }) => getLesson(lessonId ?? '', signal),
    enabled,
  });

  const refresh = useCallback((): void => {
    void refetch();
  }, [refetch]);

  const plan = useMemo(() => sortLessonPlan(data?.lesson.plan ?? []), [data?.lesson.plan]);

  return {
    lesson: data?.lesson ?? null,
    plan,
    exercises: data?.exercises ?? [],
    attempts: data?.attempts ?? [],
    isLoading: enabled && isLoading,
    isFetching,
    isError,
    error: error ? ApiError.from(error) : null,
    refetch: refresh,
  };
}

/** Генерация урока с планом; после успеха список уроков перечитывается. */
export function useCreateLesson(): UseMutationResult<Lesson, Error, CreateLessonRequest> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: CreateLessonRequest) => createLesson(body),
    onSuccess: (created) => {
      // Урок уже известен целиком: страница плана открывается без лишнего запроса.
      queryClient.setQueryData(lessonsQueryKeys.detail(created.id), {
        lesson: created,
        exercises: [],
        attempts: [],
      } satisfies GetLessonResponse);
      // Именно список, а не весь namespace: префикс `['lessons']` накрыл бы
      // и только что положенный `['lessons', 'detail', id]`, и запрос ушёл бы
      // снова — ровно тот, которого мы избегали.
      void queryClient.invalidateQueries({ queryKey: lessonsQueryKeys.lists() });
    },
  });
}

/**
 * Пересборка плана урока с учётом пожелания.
 *
 * Ответ кладётся в кэш урока сразу, не дожидаясь перечитывания: план на экране
 * меняется в тот же момент, когда модель вернула его.
 */
export function useRegenerateLessonPlan(
  lessonId: string,
): UseMutationResult<Lesson, Error, RegenerateLessonPlanRequest> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: RegenerateLessonPlanRequest) => regenerateLessonPlan(lessonId, body),
    onSuccess: (updated) => {
      queryClient.setQueryData<GetLessonResponse>(
        lessonsQueryKeys.detail(lessonId),
        (previous) => ({
          lesson: updated,
          exercises: previous?.exercises ?? [],
          attempts: previous?.attempts ?? [],
        }),
      );
      // Только список: инвалидация всего namespace выбросила бы свежий план
      // из кэша урока и заставила бы перечитать его с сервера.
      void queryClient.invalidateQueries({ queryKey: lessonsQueryKeys.lists() });
    },
  });
}

/** Параметры списка материалов для выбора в урок. */
export interface UseLessonMaterialsOptions extends ListLessonMaterialsParams {
  /** Не ходить на сервер, пока значение `false`. */
  enabled?: boolean;
}

/** Материалы, из которых собирается урок. */
export interface UseLessonMaterialsResult {
  materials: Material[];
  /** Сколько материалов всего на сервере. */
  total: number;
  /** Есть ли материалы за пределами полученной страницы. */
  hasMore: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: ApiError | null;
  refetch: () => void;
}

/**
 * Материалы для выбора в урок.
 *
 * Запрос свой, не из раздела материалов: пакеты не должны делить кэш, иначе
 * фильтры одного экрана начинают влиять на другой.
 */
export function useLessonMaterials(
  options: UseLessonMaterialsOptions = {},
): UseLessonMaterialsResult {
  const { enabled = true, ...params } = options;
  const { data, error, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: lessonsQueryKeys.materials(params),
    queryFn: ({ signal }) => listLessonMaterials(params, signal),
    enabled,
  });

  const refresh = useCallback((): void => {
    void refetch();
  }, [refetch]);

  return {
    materials: data?.items ?? [],
    total: data?.total ?? 0,
    hasMore: data?.hasMore ?? false,
    isLoading,
    isFetching,
    isError,
    error: error ? ApiError.from(error) : null,
    refetch: refresh,
  };
}

/** Готовность языковой модели: о ней предупреждают до запуска генерации. */
export interface LessonGenerationReadiness {
  /** Конфигурация сервера ещё не получена. */
  isChecking: boolean;
  /** Конфигурацию прочитать не удалось: генерацию всё же можно попробовать. */
  isUnknown: boolean;
  /** Модель настроена: план можно генерировать. */
  isAvailable: boolean;
  /** Пояснение сервера, почему модель недоступна. */
  reason: string | null;
  /** Имя модели, если она настроена. */
  model: string | null;
}

/** Готовность языковой модели к генерации плана. */
export function useLessonGenerationReadiness(): LessonGenerationReadiness {
  const { status, llm, llmModel } = useCapabilities();

  return useMemo(
    () => ({
      isChecking: status === 'loading',
      isUnknown: status === 'error',
      isAvailable: status === 'ready' && llm.available,
      reason: llm.reason ?? null,
      model: llmModel,
    }),
    [llm.available, llm.reason, llmModel, status],
  );
}

/**
 * Сообщение об отказе для пользователя.
 *
 * Отдельно от общего `useApiErrorMessage`, потому что отказы планировщика
 * читаются иначе: 501 `not_configured` означает ненастроенную модель (а не
 * «возможность не реализована»), 503 — что модель не отвечает, 502 — что она
 * вернула ответ, который не удалось прочитать. Отказы из-за материалов и
 * состояния урока сервер поясняет в `details.reason` — их тоже переводим.
 */
export function useLessonErrorMessage(): (error: unknown) => string {
  const t = useT('lessons');
  const fallbackMessage = useApiErrorMessage();

  return useCallback(
    (error: unknown): string => {
      if (!isApiError(error)) {
        return fallbackMessage(error);
      }

      if (error.isNotConfigured) {
        return t('errors.notConfigured');
      }

      switch (lessonErrorReason(error)) {
        case 'materials_not_ready':
          return t('errors.materialsNotReady');
        case 'material_not_found':
          return t('errors.materialNotFound');
        case 'lesson_completed':
          return t('errors.lessonCompleted');
        case 'lesson_plan_full':
          return t('errors.lessonPlanFull');
        default:
          break;
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

/** Ключ подсказки в namespace `lessons`, которую стоит показать рядом с ошибкой. */
export type LlmHintKey = 'errors.setupHint' | 'errors.startHint' | 'errors.retryHint';

/**
 * Какая подсказка нужна рядом с отказом языковой модели.
 *
 * Раньше на все три случая показывалась одна подсказка «настройте .env», хотя
 * действия у них разные: при 501 модель действительно не настроена, при 503
 * настройки в порядке и модель просто не запущена, при 502 она запущена, но
 * вернула негодный ответ. Единая подсказка отправляла править конфигурацию
 * даже тогда, когда конфигурация ни при чём.
 */
export function llmHintKey(error: unknown): LlmHintKey | null {
  if (!isApiError(error) || error.isTimeout || error.isNetworkError) {
    return null;
  }

  if (error.isNotConfigured) {
    return 'errors.setupHint';
  }

  if (error.code === 'upstream_unavailable') {
    return 'errors.startHint';
  }

  if (error.code === 'upstream_error') {
    return 'errors.retryHint';
  }

  return null;
}

/** Оформление бейджа статуса урока. */
export type LessonStatusTone = 'ok' | 'warn' | 'muted';

/** Подписи статуса урока. */
export interface LessonStatusText {
  label: string;
  tone: LessonStatusTone;
}

/** Переводит статус урока в подпись и оформление бейджа. */
export function useLessonStatusText(): (status: LessonStatus) => LessonStatusText {
  const t = useT('lessons');

  return useCallback(
    (status: LessonStatus): LessonStatusText => ({
      label: t(`status.${status}`),
      tone: status === 'completed' ? 'ok' : status === 'in_progress' ? 'warn' : 'muted',
    }),
    [t],
  );
}

/** Подписи видов и состояний шагов плана. */
export interface LessonStepText {
  /** Название вида шага: разминка, лексика, грамматика и так далее. */
  typeLabel: (type: LessonStepType) => string;
  /** Что происходит на шаге этого вида. */
  typeHint: (type: LessonStepType) => string;
  /** Состояние шага: не начат, идёт, пройден, пропущен. */
  statusLabel: (status: LessonStepStatus) => string;
}

/** Подписи шагов плана для интерфейса. */
export function useLessonStepText(): LessonStepText {
  const t = useT('lessons');

  return useMemo(
    () => ({
      typeLabel: (type: LessonStepType) => t(`stepTypes.${type}.label`),
      typeHint: (type: LessonStepType) => t(`stepTypes.${type}.hint`),
      statusLabel: (status: LessonStepStatus) => t(`stepStatus.${status}`),
    }),
    [t],
  );
}

/** Подписи статуса материала: почему материал нельзя взять в урок. */
export interface LessonMaterialStatusText {
  label: string;
  hint: string;
  /** Пояснение сервера, если оно пришло. */
  serverMessage: string | null;
  /** Материал непригоден к использованию. */
  isError: boolean;
  /** Обработка ещё идёт. */
  isPending: boolean;
  /** Материал можно взять в урок. */
  isSelectable: boolean;
}

/**
 * Подписи статуса материала в выборе материалов.
 *
 * Тексты свои, а не из namespace соседнего пакета: подписи принадлежат разделу
 * материалов, и опираться на чужие ключи означало бы поломку при их переносе.
 */
export function useLessonMaterialStatusText(): (material: Material) => LessonMaterialStatusText {
  const t = useT('lessons');

  return useCallback(
    (material: Material): LessonMaterialStatusText => {
      const serverMessage = material.statusMessage?.trim();

      return {
        label: t(`materials.status.${material.status}.label`),
        hint: t(`materials.status.${material.status}.hint`),
        serverMessage: serverMessage ? serverMessage : null,
        isError: isMaterialErrorStatus(material.status),
        isPending: material.status === 'pending' || material.status === 'processing',
        isSelectable: material.status === 'ready',
      };
    },
    [t],
  );
}

/** Форматирование дат по языку интерфейса. */
export interface LessonFormatters {
  /** Только дата. */
  formatDate: (isoDate: string) => string;
  /** Дата и время: у урока важно, в котором часу он шёл. */
  formatDateTime: (isoDate: string) => string;
}

/** Форматирование дат по текущему языку интерфейса. */
export function useLessonFormatters(): LessonFormatters {
  const { locale } = useLocale();

  return useMemo(
    () => ({
      formatDate: (isoDate: string) => formatDate(isoDate, locale),
      formatDateTime: (isoDate: string) => formatDateTime(isoDate, locale),
    }),
    [locale],
  );
}
