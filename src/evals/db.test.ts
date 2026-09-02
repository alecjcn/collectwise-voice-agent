import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.ts';
import { Repository } from '../db/repository.ts';
import { SEED_ACCOUNTS, seedIfEmpty } from '../db/seed.ts';
import { locateCallerByPhone } from '../state.ts';
import { createTestState } from './helpers.ts';

function freshRepo(): Repository {
  const repo = new Repository(openDb(':memory:'));
  seedIfEmpty(repo);
  return repo;
}

describe('database', () => {
  it('seeds sample accounts exactly once', () => {
    const repo = freshRepo();
    expect(repo.countAccounts()).toBe(SEED_ACCOUNTS.length);
    expect(seedIfEmpty(repo)).toBe(0);
    expect(repo.countAccounts()).toBe(SEED_ACCOUNTS.length);
  });

  it('finds accounts by number, case-insensitively', () => {
    const repo = freshRepo();
    expect(repo.findAccountByNumber('atl-1001')?.debtorName).toBe('Maria Gonzalez');
    expect(repo.findAccountByNumber('ATL-9999')).toBeUndefined();
  });

  it('finds accounts by number in any spoken format', () => {
    const repo = freshRepo();
    // STT often drops the dash or inserts spaces.
    expect(repo.findAccountByNumber('ATL 1003')?.debtorName).toBe('Sarah Whitmore');
    expect(repo.findAccountByNumber('atl1003')?.debtorName).toBe('Sarah Whitmore');
    expect(repo.findAccountByNumber('A T L 1003')?.debtorName).toBe('Sarah Whitmore');
    // Digits only: match by unique suffix.
    expect(repo.findAccountByNumber('1003')?.debtorName).toBe('Sarah Whitmore');
    // Too short or unmatchable digits must not guess.
    expect(repo.findAccountByNumber('3')).toBeUndefined();
    expect(repo.findAccountByNumber('9999')).toBeUndefined();
  });

  it('finds accounts by phone in any spoken format', () => {
    const repo = freshRepo();
    expect(repo.findAccountByPhone('555-010-4821')?.debtorName).toBe('Maria Gonzalez');
    expect(repo.findAccountByPhone('(555) 010-3390')?.debtorName).toBe('David Chen');
    expect(repo.findAccountByPhone('555-000-0000')).toBeUndefined();
    expect(repo.findAccountByPhone('4821')).toBeUndefined();
  });

  it('stores money as integer cents', () => {
    const repo = freshRepo();
    const account = repo.findAccountByNumber('ATL-1001')!;
    expect(Number.isInteger(account.balanceCents)).toBe(true);
    expect(account.balanceCents).toBe(248975);
  });

  it('round-trips payment plans, outcomes, and escalations', () => {
    const repo = freshRepo();
    const account = repo.findAccountByNumber('ATL-1002')!;

    repo.createPaymentPlan({
      accountId: account.id,
      callId: 'call-1',
      planType: 'installments',
      totalCents: account.balanceCents,
      numInstallments: 6,
      installmentCents: 16009,
    });
    repo.recordOutcome({ callId: 'call-1', accountId: account.id, outcome: 'payment_plan_agreed' });
    repo.recordEscalation({ callId: 'call-1', accountId: account.id, reason: 'hardship' });

    const plans = repo.listPaymentPlans(account.id);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.numInstallments).toBe(6);
    expect(repo.listOutcomes('call-1').map((o) => o.outcome)).toEqual(['payment_plan_agreed']);
    expect(repo.listEscalations('call-1').map((e) => e.reason)).toEqual(['hardship']);
    expect(repo.hasOutcome('call-1')).toBe(true);
    expect(repo.hasOutcome('call-2')).toBe(false);
  });

  it('rejects invalid rows via CHECK constraints (last line of defense)', () => {
    const repo = freshRepo();
    const account = repo.findAccountByNumber('ATL-1001')!;
    expect(() =>
      repo.createPaymentPlan({
        accountId: account.id,
        callId: 'call-x',
        planType: 'installments',
        totalCents: account.balanceCents,
        numInstallments: 25,
        installmentCents: 1000,
      }),
    ).toThrow();
  });

  it('updates account status for disputes', () => {
    const repo = freshRepo();
    const account = repo.findAccountByNumber('ATL-1001')!;
    repo.updateAccountStatus(account.id, 'in_dispute');
    expect(repo.getAccountById(account.id)!.status).toBe('in_dispute');
  });
});

describe('caller-ID lookup (locateCallerByPhone)', () => {
  it('prefills account id and first name for a known incoming number', () => {
    const state = createTestState();
    const account = locateCallerByPhone(state, '555-010-4821');

    expect(account?.debtorName).toBe('Maria Gonzalez');
    expect(state.account?.id).toBe(account!.id);
    expect(state.incomingNumber).toBe('555-010-4821');
    // The full row is cached in process memory for the post-verification agent.
    expect(state.account?.balanceCents).toBe(248975);
    // Caller ID locates the account but never verifies identity.
    expect(state.verified).toBe(false);
  });

  it('leaves the state untouched for an unknown incoming number', () => {
    const state = createTestState();
    const account = locateCallerByPhone(state, '555-000-9999');

    expect(account).toBeUndefined();
    expect(state.account).toBeUndefined();
    expect(state.verified).toBe(false);
  });
});
