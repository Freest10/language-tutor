/**
 * Бюджет реплик шага: сколько раз ученик может ответить на шаге, прежде чем
 * сервер закроет его сам. Проверяются границы: короткий шаг не схлопывается в
 * один вопрос, длинный не растягивается на десятки реплик по кругу.
 */
import { describe, expect, it } from 'vitest';

import {
  isBudgetSpent,
  MAX_STEP_TURNS,
  MIN_STEP_TURNS,
  MINUTES_PER_EXCHANGE,
  stepTurnBudget,
  turnsLeft,
} from '../src/lib/stepBudget.js';

describe('stepTurnBudget', () => {
  it('отводит шагу по реплике ученика на каждый обмен репликами', () => {
    expect(stepTurnBudget(5 * MINUTES_PER_EXCHANGE)).toBe(5);
    expect(stepTurnBudget(6 * MINUTES_PER_EXCHANGE)).toBe(6);
  });

  it('не опускается ниже нижней границы на коротком шаге', () => {
    // Даже за две минуты тьютор должен успеть спросить, уточнить и подвести итог.
    expect(stepTurnBudget(1)).toBe(MIN_STEP_TURNS);
    expect(stepTurnBudget(MINUTES_PER_EXCHANGE)).toBe(MIN_STEP_TURNS);
  });

  it('не поднимается выше верхней границы на длинном шаге', () => {
    // Тема исчерпывается раньше времени: добирать минуты вопросами по кругу хуже.
    expect(stepTurnBudget(120)).toBe(MAX_STEP_TURNS);
  });
});

describe('turnsLeft и isBudgetSpent', () => {
  it('считает оставшиеся реплики после текущей', () => {
    expect(turnsLeft({ learnerTurns: 1, budget: 3 })).toBe(2);
    expect(isBudgetSpent({ learnerTurns: 1, budget: 3 })).toBe(false);
  });

  it('считает бюджет исчерпанным на последней отведённой реплике и после неё', () => {
    expect(isBudgetSpent({ learnerTurns: 3, budget: 3 })).toBe(true);
    expect(isBudgetSpent({ learnerTurns: 7, budget: 3 })).toBe(true);
  });
});
