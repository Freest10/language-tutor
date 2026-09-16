/**
 * Данные раздела материалов: список, просмотр с ленивой догрузкой фрагментов,
 * загрузка и удаление.
 *
 * Хуки и ключи запросов вынесены сюда отдельно от компонентов, чтобы выбор
 * материалов для урока (пакет уроков) переиспользовал ровно те же данные
 * и попадал в тот же кэш.
 *
 * Соглашение о ключах: первый элемент — namespace фичи (`['materials', ...]`),
 * поэтому инвалидация по `MATERIALS_QUERY_KEY` задевает и список, и просмотр.
 *
 * Обработка сканов идёт на сервере в фоне и занимает минуты, поэтому список и
 * открытый просмотр опрашиваются, пока среди материалов есть необработанные.
 * Опрос выключается сам, как только таких материалов не осталось: постоянный
 * фоновый запрос на открытой вкладке жёг бы батарею впустую.
 */
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import {
  DEFAULT_PAGE_SIZE,
  isMaterialErrorStatus,
  MAX_MATERIAL_TEXT_LENGTH,
  MAX_MATERIAL_UPLOAD_BYTES,
  type CreateTextMaterialRequest,
  type Material,
  type MaterialChunk,
} from '@lt/shared';

import {
  createTextMaterial,
  deleteMaterial,
  getMaterial,
  listMaterials,
  uploadMaterial,
  type ListMaterialsParams,
  type UploadMaterialInput,
} from '../../api/materials';
import { ApiError } from '../../api/client';
import { useCapabilities } from '../../context/CapabilitiesProvider';
import { useLocale, useT } from '../../i18n/useT';
import { formatDate, formatDateTime } from '../../lib/format';

/** Корень ключей запросов фичи: по нему инвалидируется весь раздел. */
export const MATERIALS_QUERY_KEY = ['materials'] as const;

/** Ключи запросов материалов. */
export const materialsQueryKeys = {
  /** Весь раздел целиком. */
  all: MATERIALS_QUERY_KEY,
  /** Страница списка с конкретным набором фильтров. */
  list: (params: ListMaterialsParams) => [...MATERIALS_QUERY_KEY, 'list', params] as const,
  /** Материал вместе с его фрагментами. */
  detail: (materialId: string, pageSize: number) =>
    [...MATERIALS_QUERY_KEY, 'detail', materialId, pageSize] as const,
};

/** Сколько фрагментов материала подгружается за один раз. */
export const MATERIAL_CHUNK_PAGE_SIZE = 3;

/**
 * Как часто перезапрашивать материалы, пока сервер их обрабатывает, мс.
 *
 * Три секунды: прогресс сервера меняется постранично (десятые доли секунды на
 * странице у локального распознавания, десятки секунд у зрячей модели), и чаще
 * спрашивать незачем — пользователь всё равно не читает счётчик быстрее.
 */
export const MATERIALS_POLL_INTERVAL_MS = 3_000;

/** Идёт ли обработка материала на сервере прямо сейчас. */
export function isMaterialProcessing(material: Material): boolean {
  return material.status === 'pending' || material.status === 'processing';
}

/** Есть ли в наборе материалы, состояние которых сервер ещё изменит. */
export function hasProcessingMaterials(materials: readonly Material[]): boolean {
  return materials.some(isMaterialProcessing);
}

/** Интервал опроса для набора материалов; `false` — опрашивать больше нечего. */
export function materialsPollInterval(materials: readonly Material[]): number | false {
  return hasProcessingMaterials(materials) ? MATERIALS_POLL_INTERVAL_MS : false;
}

/** Параметры списка материалов. */
export interface UseMaterialsOptions extends ListMaterialsParams {
  /** Не ходить на сервер, пока значение `false`. */
  enabled?: boolean;
}

/** Список материалов и состояние его загрузки. */
export interface UseMaterialsResult {
  materials: Material[];
  /** Сколько материалов всего на сервере при текущих фильтрах. */
  total: number;
  /** Есть ли материалы за пределами полученной страницы. */
  hasMore: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: ApiError | null;
  refetch: () => void;
}

/** Список материалов пользователя. */
export function useMaterials(options: UseMaterialsOptions = {}): UseMaterialsResult {
  const { enabled = true, ...params } = options;
  const query = useQuery({
    queryKey: materialsQueryKeys.list(params),
    queryFn: ({ signal }) => listMaterials(params, signal),
    enabled,
    // Предыдущая страница держится, пока едет следующая: ни «показать ещё»,
    // ни опрос обработки не должны схлопывать список под курсором.
    placeholderData: keepPreviousData,
    // Пока есть необработанные материалы — перезапрашиваем, потом останавливаемся.
    refetchInterval: ({ state }) => materialsPollInterval(state.data?.items ?? []),
    // В фоновой вкладке опрос не нужен: пользователь его всё равно не видит.
    refetchIntervalInBackground: false,
    // Зато вернувшийся на вкладку сразу видит актуальное состояние обработки.
    // Для готового списка остаётся общее правило приложения — не перезапрашивать.
    refetchOnWindowFocus: ({ state }) =>
      hasProcessingMaterials(state.data?.items ?? []) ? 'always' : false,
  });
  const { data, error, isLoading, isFetching, isError, refetch } = query;

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

/** Материал и загруженные страницы его фрагментов. */
export interface UseMaterialPreviewResult {
  material: Material | null;
  chunks: MaterialChunk[];
  /** Сколько фрагментов у материала всего. */
  total: number;
  /** Остались ли незагруженные фрагменты. */
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  isError: boolean;
  error: ApiError | null;
  /** Догружает следующую страницу фрагментов. */
  loadMore: () => void;
  refetch: () => void;
}

/**
 * Материал с ленивой догрузкой фрагментов постранично.
 *
 * @param materialId идентификатор материала; `null` — запрос не отправляется.
 * @param pageSize сколько фрагментов брать за раз.
 */
export function useMaterialPreview(
  materialId: string | null,
  pageSize: number = MATERIAL_CHUNK_PAGE_SIZE,
): UseMaterialPreviewResult {
  const query = useInfiniteQuery({
    queryKey: materialsQueryKeys.detail(materialId ?? '', pageSize),
    queryFn: ({ pageParam, signal }) =>
      getMaterial(materialId ?? '', { limit: pageSize, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.chunks.hasMore ? lastPage.chunks.offset + lastPage.chunks.items.length : undefined,
    enabled: materialId !== null,
    // Открытый просмотр обрабатываемого материала обновляется сам: страница
    // с прогрессом не должна устаревать, пока пользователь на неё смотрит.
    refetchInterval: ({ state }) => {
      const material = state.data?.pages.at(-1)?.material;

      return material ? materialsPollInterval([material]) : false;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: ({ state }) => {
      const material = state.data?.pages.at(-1)?.material;

      return material !== undefined && isMaterialProcessing(material) ? 'always' : false;
    },
  });
  const {
    data,
    error,
    isLoading,
    isError,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = query;

  const loadMore = useCallback((): void => {
    void fetchNextPage();
  }, [fetchNextPage]);

  const refresh = useCallback((): void => {
    void refetch();
  }, [refetch]);

  const pages = data?.pages ?? [];
  const lastPage = pages.at(-1);

  return {
    // Материал берём из последнего ответа: он самый свежий по статусу обработки.
    material: lastPage?.material ?? null,
    chunks: pages.flatMap((page) => page.chunks.items),
    total: lastPage?.chunks.total ?? 0,
    hasMore: hasNextPage,
    isLoading,
    isLoadingMore: isFetchingNextPage,
    isError,
    error: error ? ApiError.from(error) : null,
    loadMore,
    refetch: refresh,
  };
}

/** Загрузка файла материала; после успеха список перечитывается. */
export function useUploadMaterial(): UseMutationResult<Material, Error, UploadMaterialInput> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UploadMaterialInput) => uploadMaterial(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MATERIALS_QUERY_KEY });
    },
  });
}

/** Сохранение вставленного текста; после успеха список перечитывается. */
export function useCreateTextMaterial(): UseMutationResult<
  Material,
  Error,
  CreateTextMaterialRequest
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: CreateTextMaterialRequest) => createTextMaterial(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MATERIALS_QUERY_KEY });
    },
  });
}

/** Удаление материала; после успеха список и просмотр перечитываются. */
export function useDeleteMaterial(): UseMutationResult<{ ok: true }, Error, string> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (materialId: string) => deleteMaterial(materialId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MATERIALS_QUERY_KEY });
    },
  });
}

/** Ограничения материалов, о которых сервер сообщил в `GET /api/config`. */
export interface MaterialLimits {
  /** Предел размера загружаемого файла, байты. */
  maxUploadBytes: number;
  /** Предел длины вставленного текста, символы. */
  maxTextLength: number;
}

/** Ограничения материалов: значения сервера, а пока их нет — значения схемы. */
export function useMaterialLimits(): MaterialLimits {
  const { config } = useCapabilities();

  return useMemo(
    () => ({
      maxUploadBytes: config?.limits.maxMaterialUploadBytes ?? MAX_MATERIAL_UPLOAD_BYTES,
      maxTextLength: config?.limits.maxMaterialTextLength ?? MAX_MATERIAL_TEXT_LENGTH,
    }),
    [config],
  );
}

/** Размер в байтах, килобайтах или мегабайтах — по величине значения. */
export function formatBytes(bytes: number, locale: string): string {
  const units: ReadonlyArray<[limit: number, unit: string, factor: number]> = [
    [1024, 'byte', 1],
    [1024 * 1024, 'kilobyte', 1024],
    [Number.POSITIVE_INFINITY, 'megabyte', 1024 * 1024],
  ];
  const safeBytes = Math.max(0, bytes);
  const [, unit, factor] = units.find(([limit]) => safeBytes < limit) ?? units[units.length - 1]!;

  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: unit === 'byte' ? 0 : 1,
  }).format(safeBytes / factor);
}

/** Форматирование размеров и дат по языку интерфейса. */
export interface MaterialFormatters {
  formatSize: (bytes: number) => string;
  /** Только дата. */
  formatDate: (isoDate: string) => string;
  /** Дата и время: у загруженного материала важен и час. */
  formatDateTime: (isoDate: string) => string;
}

/** Форматирование размеров и дат по текущему языку интерфейса. */
export function useMaterialFormatters(): MaterialFormatters {
  const { locale } = useLocale();

  return useMemo(
    () => ({
      formatSize: (bytes: number) => formatBytes(bytes, locale),
      formatDate: (isoDate: string) => formatDate(isoDate, locale),
      formatDateTime: (isoDate: string) => formatDateTime(isoDate, locale),
    }),
    [locale],
  );
}

/** Подписи статуса материала для пользователя. */
export interface MaterialStatusText {
  /** Короткая подпись для бейджа. */
  label: string;
  /** Что это значит и что делать дальше; у каждого `error_*` свой текст (A16). */
  hint: string;
  /** Пояснение сервера, если оно пришло. */
  serverMessage: string | null;
  /** Материал непригоден к использованию. */
  isError: boolean;
  /** Обработка ещё идёт. */
  isPending: boolean;
  /** Материал обработан и годится для урока. */
  isSelectable: boolean;
}

/** Переводит статус материала в подписи интерфейса. */
export function useMaterialStatusText(): (material: Material) => MaterialStatusText {
  const t = useT('materials');

  return useCallback(
    (material: Material): MaterialStatusText => {
      const serverMessage = material.statusMessage?.trim();

      return {
        label: t(`status.${material.status}.label`),
        hint: t(`status.${material.status}.hint`),
        serverMessage: serverMessage ? serverMessage : null,
        isError: isMaterialErrorStatus(material.status),
        isPending: isMaterialProcessing(material),
        isSelectable: material.status === 'ready',
      };
    },
    [t],
  );
}

/** Размер страницы списка материалов по умолчанию. */
export const MATERIALS_PAGE_SIZE = DEFAULT_PAGE_SIZE;
