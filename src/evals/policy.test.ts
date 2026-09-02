import { describe, expect, it } from 'vitest';
import {
  MAX_PLAN_MONTHS,
  MAX_VERIFICATION_ATTEMPTS,
  MIN_SETTLEMENT_RATIO,
  computeInstallmentPlan,
  firstNameOf,
  formatCents,
  maskPhone,
  minSettlementCents,
  namesMatch,
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

describe('namesMatch', () => {
  it('matches exact names case-insensitively', () => {
    expect(namesMatch('maria gonzalez', 'Maria Gonzalez')).toBe(true);
  });

  it('tolerates middle names and extra whitespace', () => {
    expect(namesMatch('Maria  Elena Gonzalez', 'Maria Gonzalez')).toBe(true);
    expect(namesMatch('Maria Gonzalez', 'Maria Elena Gonzalez')).toBe(true);
  });

  it('rejects different people', () => {
    expect(namesMatch('Mario Gonzalez', 'Maria Gonzalez')).toBe(false);
    expect(namesMatch('Maria Chen', 'Maria Gonzalez')).toBe(false);
    expect(namesMatch('David Chen', 'Maria Gonzalez')).toBe(false);
  });

  it('rejects a bare first name', () => {
    expect(namesMatch('Maria', 'Maria Gonzalez')).toBe(false);
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

describe('firstNameOf', () => {
  it('returns the first token of a full name', () => {
    expect(firstNameOf('Maria Gonzalez')).toBe('Maria');
    expect(firstNameOf('  Sarah  Jane  Whitmore ')).toBe('Sarah');
  });
});

describe('formatCents', () => {
  it('formats cents as dollars', () => {
    expect(formatCents(248975)).toBe('$2,489.75');
    expect(formatCents(80000)).toBe('$800.00');
    expect(formatCents(5)).toBe('$0.05');
  });
});
