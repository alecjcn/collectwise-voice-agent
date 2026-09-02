import type { Account, Repository } from './db/repository.ts';
import type { Tracer } from './trace.ts';

/**
 * Per-call session state, stored as the AgentSession's typed userData.
 * Tools read and mutate it; the verified flag is only ever set by the
 * verifyIdentity tool, and detail-revealing tools check it server-side.
 */
export interface CallState {
  callId: string;
  repo: Repository;
  trace: Tracer;
  /** Caller's phone number: sip.phoneNumber on real calls, INCOMING_NUMBER mock otherwise. */
  incomingNumber?: string;
  /** Set by caller-ID lookup at call start, or by the lookupAccount tool. */
  accountId?: number;
  /**
   * Full account row, loaded once at lookup time. Lives only in process
   * memory: the LLM never sees userData directly, so holding it here leaks
   * nothing. It reaches a prompt in exactly one place — injected into the
   * NegotiationAgent's instructions when that agent is created after a
   * successful verifyIdentity call.
   */
  account?: Account;
  /** First name on file, used to confirm the right party without disclosure. */
  debtorFirstName?: string;
  /** Only set to true by a successful verifyIdentity call. */
  verified: boolean;
  verificationAttempts: number;
  lookupFailures: number;
  escalated: boolean;
  outcomeRecorded: boolean;
}

export function createCallState(input: {
  callId: string;
  repo: Repository;
  trace: Tracer;
}): CallState {
  return {
    callId: input.callId,
    repo: input.repo,
    trace: input.trace,
    verified: false,
    verificationAttempts: 0,
    lookupFailures: 0,
    escalated: false,
    outcomeRecorded: false,
  };
}

/**
 * Record a located account on the call state. The full row is cached in
 * process memory, but only the first name is ever surfaced pre-verification.
 */
export function attachLocatedAccount(state: CallState, account: Account): void {
  state.accountId = account.id;
  state.account = account;
  state.debtorFirstName = account.debtorName.split(/\s+/)[0]!;
}

/**
 * Caller-ID lookup at call start: match the incoming phone number against the
 * accounts on file (via the repository) and attach the result to the call
 * state. This lives here rather than in the repository because it is session
 * policy, not data access: what a caller-ID match is allowed to prefill, and
 * what gets traced. Returns the account, or undefined when unknown.
 */
export function locateCallerByPhone(state: CallState, phoneNumber: string): Account | undefined {
  state.incomingNumber = phoneNumber;
  const account = state.repo.findAccountByPhone(phoneNumber);
  const masked = phoneNumber.replace(/\d(?=\d{4})/g, '*');
  state.trace.event('caller_lookup', { incomingNumber: masked, matched: account !== undefined });
  if (!account) return undefined;
  attachLocatedAccount(state, account);
  return account;
}
