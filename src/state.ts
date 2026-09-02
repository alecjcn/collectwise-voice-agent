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
 * Caller-ID lookup at call start: match the incoming phone number against the
 * accounts on file. On a match, prefill only the account id and first name —
 * never balances or other details, which stay behind the verified gate.
 * Returns the account, or undefined when the number is unknown.
 */
export function locateCallerByPhone(state: CallState, phoneNumber: string): Account | undefined {
  state.incomingNumber = phoneNumber;
  const account = state.repo.findAccountByPhone(phoneNumber);
  const masked = phoneNumber.replace(/\d(?=\d{4})/g, '*');
  if (!account) {
    state.trace.event('caller_lookup', { incomingNumber: masked, matched: false });
    return undefined;
  }
  state.accountId = account.id;
  state.debtorFirstName = account.debtorName.split(/\s+/)[0]!;
  state.trace.event('caller_lookup', { incomingNumber: masked, matched: true });
  return account;
}
