/**
 * Шкала CEFR: сдвиг уровня и направление изменения.
 *
 * Обе операции нужны и промптам (сложность следующего вопроса теста), и сервисам
 * (автокоррекция уровня, запись истории), поэтому живут одним модулем: две копии
 * «сдвига на ступень» разошлись бы незаметно, а уровень — то, вокруг чего
 * построено всё занятие.
 */
import { CEFR_LEVELS, type CefrLevel, type LevelChangeDirection } from '@lt/shared';

/** Сдвигает уровень по шкале CEFR, не выходя за её границы. */
export function shiftLevel(level: CefrLevel, steps: number): CefrLevel {
  const index = CEFR_LEVELS.indexOf(level);
  const shifted = Math.min(CEFR_LEVELS.length - 1, Math.max(0, index + steps));

  return CEFR_LEVELS[shifted] ?? level;
}

/**
 * Направление изменения уровня по шкале CEFR. Вызывается только для разных
 * уровней: совпадающие уровни изменением не считаются и в историю не пишутся
 * (см. `services/levelHistory.ts`).
 */
export function levelDirection(fromLevel: CefrLevel, toLevel: CefrLevel): LevelChangeDirection {
  return CEFR_LEVELS.indexOf(toLevel) > CEFR_LEVELS.indexOf(fromLevel) ? 'up' : 'down';
}
