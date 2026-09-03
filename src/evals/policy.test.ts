import { describe, expect, it } from 'vitest';
import {
  MAX_PLAN_MONTHS,
  MAX_VERIFICATION_ATTEMPTS,
  MIN_SETTLEMENT_RATIO,
  computeInstallmentPlan,
  computePlanForBudget,
  formatCents,
  maskPhone,
  minSettlementCents,
  normalizePhone,
  validateSettlementOffer,
} from '../policy.ts';

describe('policy constants', () => {
  it('matches the assignment limits', () => {
    expect(MAX_PLAN_MONTHS).toBe(24);
    expect(MIN_SETTLEMENT_RATIO).toBe(0.8);
    expect(MAX_VERIFICATION_ATTEMPTS).toBe(3);
  });
});

describe('computeInstallmentPlan', () => {
  it('splits a balance into equal installments with the remainder in the last payment', () => {
    const plan = computeInstallmentPlan(248975, 3);
    expect(plan.months).toBe(3);
    expect(plan.monthlyCents).toBe(82992);
    expect(plan.finalCents).toBe(82991);
    expect(plan.monthlyCents * 2 + plan.finalCents).toBe(248975);
  });

  it('handles balances that divide evenly', () => {
    const plan = computeInstallmentPlan(120000, 12);
    expect(plan.monthlyCents).toBe(10000);
    expect(plan.finalCents).toBe(10000);
  });

  it('accepts the 24 month maximum', () => {
    expect(() => computeInstallmentPlan(100000, 24)).not.toThrow();
  });

  it('rejects plans longer than 24 months', () => {
    expect(() => computeInstallmentPlan(100000, 25)).toThrow(/24/);
    expect(() => computeInstallmentPlan(100000, 36)).toThrow(/24/);
  });

  it('rejects non-positive or fractional months', () => {
    expect(() => computeInstallmentPlan(100000, 0)).toThrow();
    expect(() => computeInstallmentPlan(100000, -3)).toThrow();
    expect(() => computeInstallmentPlan(100000, 2.5)).toThrow();
  });

  it('rejects a non-positive balance', () => {
    expect(() => computeInstallmentPlan(0, 3)).toThrow();
  });
});

describe('computePlanForBudget', () => {
  // Seed balance for Maria Gonzalez: $2,489.75.
  const BALANCE = 248975;

  it('picks the shortest plan whose monthly payment fits the budget', () => {
    const result = computePlanForBudget(BALANCE, 15000); // $150/month
    expect(result.withinBudget).toBe(true);
    expect(result.plan.months).toBe(17);
    expect(result.plan.monthlyCents).toBe(14646); // $146.46 <= $150
    // One month shorter would exceed the budget; this is the shortest fit.
    expect(computeInstallmentPlan(BALANCE, 16).monthlyCents).toBeGreaterThan(15000);
  });

  it('fits exactly at the boundary budget for the 24 month maximum', () => {
    const result = computePlanForBudget(BALANCE, 10374); // $103.74
    expect(result.withinBudget).toBe(true);
    expect(result.plan.months).toBe(24);
    expect(result.plan.monthlyCents).toBe(10374);
  });

  it('clamps to 24 months when the budget is one cent too low', () => {
    const result = computePlanForBudget(BALANCE, 10373); // $103.73 needs 25 months
    expect(result.withinBudget).toBe(false);
    expect(result.plan.months).toBe(MAX_PLAN_MONTHS);
    expect(result.plan.monthlyCents).toBe(10374); // the closest allowed payment
  });

  it('clamps a far-too-low budget to the 24 month maximum', () => {
    const result = computePlanForBudget(BALANCE, 1000); // $10/month
    expect(result.withinBudget).toBe(false);
    expect(result.plan.months).toBe(MAX_PLAN_MONTHS);
  });

  it('collapses to a single payment when the budget covers the balance', () => {
    const result = computePlanForBudget(BALANCE, 300000);
    expect(result.withinBudget).toBe(true);
    expect(result.plan.months).toBe(1);
    expect(result.plan.monthlyCents).toBe(BALANCE);
  });

  it('always sums the plan exactly to the balance', () => {
    for (const budget of [1000, 5000, 10373, 10374, 15000, 99999, 300000]) {
      const { plan } = computePlanForBudget(BALANCE, budget);
      expect(plan.monthlyCents * (plan.months - 1) + plan.finalCents).toBe(BALANCE);
    }
  });

  it('rejects a non-positive or fractional budget', () => {
    expect(() => computePlanForBudget(BALANCE, 0)).toThrow();
    expect(() => computePlanForBudget(BALANCE, -5000)).toThrow();
    expect(() => computePlanForBudget(BALANCE, 100.5)).toThrow();
  });
});

describe('settlement floor', () => {
  it('computes the 80% minimum, rounding up', () => {
    expect(minSettlementCents(100000)).toBe(80000);
    expect(minSettlementCents(248975)).toBe(199180);
  });

  it('accepts offers at or above the floor', () => {
    expect(validateSettlementOffer(100000, 80000).acceptable).toBe(true);
    expect(validateSettlementOffer(100000, 95000).acceptable).toBe(true);
  });

  it('rejects offers below the floor and reports the minimum', () => {
    const result = validateSettlementOffer(100000, 79999);
    expect(result.acceptable).toBe(false);
    expect(result.minCents).toBe(80000);
  });

  it('rejects offers above the balance (that is a payment, not a settlement)', () => {
    expect(validateSettlementOffer(100000, 120000).acceptable).toBe(false);
  });
});

describe('normalizePhone', () => {
  it('reduces any format to the last 10 digits', () => {
    expect(normalizePhone('+1 (555) 010-4821')).toBe('5550104821');
    expect(normalizePhone('555-010-4821')).toBe('5550104821');
    expect(normalizePhone('15550104821')).toBe('5550104821');
  });
});

describe('maskPhone', () => {
  it('keeps only the last four digits', () => {
    expect(maskPhone('+15550104821')).toBe('+*******4821');
    expect(maskPhone('555-010-4821')).toBe('***-***-4821');
  });
});

describe('formatCents', () => {
  it('formats cents as dollars', () => {
    expect(formatCents(248975)).toBe('$2,489.75');
    expect(formatCents(80000)).toBe('$800.00');
    expect(formatCents(5)).toBe('$0.05');
  });
});
