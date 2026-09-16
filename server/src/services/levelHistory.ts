/**
 * Запись истории уровня: единственное место, где она собирается.
 *
 * Уровень меняют три источника — правка профиля вручную (`manual`), итог
 * определения уровня (`placement`) и автокоррекция по занятиям (`progress`), —
 * и отличаются они только `source`, уверенностью, обоснованием и метриками.
 *
 * Общее для всех трёх правило: **первая запись истории — первичная установка**
 * (`direction: 'initial'`, `fromLevel: null`). До неё уровень профиля был
 * значением заготовки, а не результатом измерения, и «повышением с A1» это
 * называть нельзя. Пока правило было переписано в каждом источнике заново,
 * автокоррекция его теряла: ученику, который не проходил тест и не правил
 * уровень руками, первой записью в истории доставалось `direction: 'up'`
 * с ненулевым `fromLevel`, чего два других источника никогда не создают,
 * а лента истории на клиенте рисуется именно по `direction`.
 */
import { randomUUID } from 'node:crypto';

import type {
  CefrLevel,
  LevelChangeMetrics,
  LevelChangeSource,
  LevelHistoryEntry,
} from '@lt/shared';

import { levelDirection } from '../lib/cefr.js';
import { findLatestLevelHistoryEntry } from '../repositories/profileRepository.js';

/** Из чего собирается запись истории уровня. */
export interface LevelHistoryEntryInput {
  /** Уровень профиля до изменения; в первой записи истории он не сохраняется. */
  fromLevel: CefrLevel;
  toLevel: CefrLevel;
  source: LevelChangeSource;
  /** Уверенность в новом уровне, 0..1. */
  confidence: number;
  /**
   * Человекочитаемое обоснование (A13). Функция получает признак первичной
   * установки: первой записи объяснять «изменение» нечего.
   */
  reason: string | ((isInitial: boolean) => string);
  metrics: LevelChangeMetrics;
  changedAt: string;
}

/** Первая ли это запись истории уровня. */
export function isInitialLevelChange(): boolean {
  return findLatestLevelHistoryEntry() === undefined;
}

/**
 * Собирает запись истории уровня. Первая запись в истории считается первичной
 * установкой: `direction: 'initial'` и `fromLevel: null`.
 */
export function buildLevelHistoryEntry(input: LevelHistoryEntryInput): LevelHistoryEntry {
  const isInitial = isInitialLevelChange();

  return {
    id: randomUUID(),
    fromLevel: isInitial ? null : input.fromLevel,
    toLevel: input.toLevel,
    direction: isInitial ? 'initial' : levelDirection(input.fromLevel, input.toLevel),
    source: input.source,
    confidence: input.confidence,
    reason: typeof input.reason === 'function' ? input.reason(isInitial) : input.reason,
    metrics: input.metrics,
    changedAt: input.changedAt,
    createdAt: input.changedAt,
  };
}
