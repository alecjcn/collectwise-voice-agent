import type { DatabaseSync } from 'node:sqlite';
import { normalizeAccountNumber, normalizePhone } from '../policy.ts';

export type AccountStatus = 'delinquent' | 'in_dispute' | 'settled' | 'paid' | 'closed';

export type CallOutcome =
  | 'promise_to_pay_full'
  | 'payment_plan_agreed'
  | 'settlement_agreed'
  | 'wrong_person'
  | 'verification_failed'
  | 'account_not_found'
  | 'dispute'
  | 'escalated'
  | 'callback_requested'
  | 'no_agreement'
  | 'no_balance_due'
  | 'incomplete';

export type PlanType = 'pay_in_full' | 'installments' | 'settlement';

export interface Account {
  id: number;
  accountNumber: string;
  debtorName: string;
  phoneNumber: string;
  last4Ssn: string;
  balanceCents: number;
  status: AccountStatus;
  clientName: string;
}

export interface PaymentPlan {
  id: number;
  accountId: number;
  callId: string;
  planType: PlanType;
  totalCents: number;
  numInstallments: number;
  installmentCents: number;
  status: 'accepted' | 'cancelled';
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToAccount(row: any): Account {
  return {
    id: Number(row.id),
    accountNumber: String(row.account_number),
    debtorName: String(row.debtor_name),
    phoneNumber: String(row.phone_number),
    last4Ssn: String(row.last4_ssn),
    balanceCents: Number(row.balance_cents),
    status: row.status as AccountStatus,
    clientName: String(row.client_name),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The single data-access layer. Every method takes validated inputs, uses
 * parameterized SQL only, and returns plain typed objects — tools and tests
 * never touch SQL directly. One instance wraps the process-wide connection
 * in production; tests construct one per case over `:memory:`.
 */
export class Repository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Find an account by its number. Account numbers are all-digit, so the
   * comparison is on the digits alone - separators, stray words, and spoken
   * punctuation are ignored ("300 103" and "number 300103." match "300103").
   */
  findAccountByNumber(accountNumber: string): Account | undefined {
    const digits = normalizeAccountNumber(accountNumber);
    if (!digits) return undefined;
    const accounts = this.db.prepare('SELECT * FROM accounts').all().map(rowToAccount);
    return accounts.find((a) => normalizeAccountNumber(a.accountNumber) === digits);
  }

  /**
   * Find an account by the phone number on file, comparing the last ten
   * digits so stored and spoken formats ("+1 (555) 010-4821") match.
   *
   * @param phone - Any phone-number format; inputs under ten digits never match.
   */
  findAccountByPhone(phone: string): Account | undefined {
    const digits = normalizePhone(phone);
    if (digits.length < 10) return undefined;
    for (const row of this.db.prepare('SELECT * FROM accounts').all()) {
      const account = rowToAccount(row);
      if (normalizePhone(account.phoneNumber) === digits) return account;
    }
    return undefined;
  }

  getAccountById(id: number): Account | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    return row ? rowToAccount(row) : undefined;
  }

  /**
   * Append one row to the identity-check audit. Written by `verifyIdentity`
   * before the in-call attempt counter changes, so an infrastructure failure
   * can never leave an uncounted, unaudited attempt.
   */
  recordVerificationAttempt(input: { callId: string; accountId: number; success: boolean }): void {
    this.db
      .prepare('INSERT INTO verification_attempts (call_id, account_id, success) VALUES (?, ?, ?)')
      .run(input.callId, input.accountId, input.success ? 1 : 0);
  }

  /**
   * Persist a committed resolution. Called only by `finalizeAgreement` after
   * policy validation; the schema's CHECK constraints re-assert the limits.
   *
   * @returns The stored plan, with its generated id and `accepted` status.
   */
  createPaymentPlan(input: {
    accountId: number;
    callId: string;
    planType: PlanType;
    totalCents: number;
    numInstallments: number;
    installmentCents: number;
  }): PaymentPlan {
    const result = this.db
      .prepare(
        `INSERT INTO payment_plans (account_id, call_id, plan_type, total_cents, num_installments, installment_cents)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.accountId,
        input.callId,
        input.planType,
        input.totalCents,
        input.numInstallments,
        input.installmentCents,
      );
    return { id: Number(result.lastInsertRowid), status: 'accepted', ...input };
  }

  /** Set an account's status (e.g. `in_dispute` when a dispute is recorded). */
  updateAccountStatus(accountId: number, status: AccountStatus): void {
    this.db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, accountId);
  }

  /**
   * Record a call's terminal disposition. Callers (the outcome tools and the
   * shutdown fallback) guard the one-outcome-per-call invariant via
   * `CallState.outcomeRecorded`.
   */
  recordOutcome(input: {
    callId: string;
    accountId?: number | undefined;
    outcome: CallOutcome;
    notes?: string | undefined;
  }): void {
    this.db
      .prepare(
        'INSERT INTO call_outcomes (call_id, account_id, outcome, notes) VALUES (?, ?, ?, ?)',
      )
      .run(input.callId, input.accountId ?? null, input.outcome, input.notes ?? null);
  }

  /** Whether any disposition has been recorded for the call. */
  hasOutcome(callId: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM call_outcomes WHERE call_id = ?').get(callId) !== undefined
    );
  }

  /**
   * Queue a human follow-up work item. Distinct from an outcome: a call has
   * exactly one disposition but may create any number of escalations, each
   * carrying what the specialist needs for the promised callback.
   */
  recordEscalation(input: {
    callId: string;
    accountId?: number | undefined;
    reason: string;
    details?: string | undefined;
  }): void {
    this.db
      .prepare('INSERT INTO escalations (call_id, account_id, reason, details) VALUES (?, ?, ?, ?)')
      .run(input.callId, input.accountId ?? null, input.reason, input.details ?? null);
  }

  /* eslint-disable @typescript-eslint/no-explicit-any -- raw SQLite rows */
  listPaymentPlans(accountId: number): PaymentPlan[] {
    return this.db
      .prepare('SELECT * FROM payment_plans WHERE account_id = ?')
      .all(accountId)
      .map((row: any) => ({
        id: Number(row.id),
        accountId: Number(row.account_id),
        callId: String(row.call_id),
        planType: row.plan_type as PlanType,
        totalCents: Number(row.total_cents),
        numInstallments: Number(row.num_installments),
        installmentCents: Number(row.installment_cents),
        status: row.status as 'accepted' | 'cancelled',
      }));
  }

  listOutcomes(callId: string): { outcome: CallOutcome; notes: string | null }[] {
    return this.db
      .prepare('SELECT outcome, notes FROM call_outcomes WHERE call_id = ?')
      .all(callId)
      .map((row: any) => ({
        outcome: row.outcome as CallOutcome,
        notes: row.notes === null ? null : String(row.notes),
      }));
  }

  listEscalations(callId: string): { reason: string; details: string | null }[] {
    return this.db
      .prepare('SELECT reason, details FROM escalations WHERE call_id = ?')
      .all(callId)
      .map((row: any) => ({
        reason: String(row.reason),
        details: row.details === null ? null : String(row.details),
      }));
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /** Number of accounts on file; used by seeding to detect an empty database. */
  countAccounts(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number };
    return Number(row.n);
  }

  /** Insert one account (seed data only). @returns The row with its generated id. */
  insertAccount(input: Omit<Account, 'id'>): Account {
    const result = this.db
      .prepare(
        `INSERT INTO accounts (account_number, debtor_name, phone_number, last4_ssn, balance_cents, status, client_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.accountNumber,
        input.debtorName,
        input.phoneNumber,
        input.last4Ssn,
        input.balanceCents,
        input.status,
        input.clientName,
      );
    return { id: Number(result.lastInsertRowid), ...input };
  }
}
