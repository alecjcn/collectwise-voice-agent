import type { Account, Repository } from './db/repository.ts';
import { maskPhone } from './policy.ts';
import type { Tracer } from './trace.ts';

/**
 * Mutable per-call session state, carried as the `AgentSession`'s typed
 * `userData`.
 *
 * `userData` is process memory the LLM never sees, so holding the full
 * {@link Account} row here leaks nothing: account details reach a prompt only
 * where code explicitly injects them (the post-verification agent factory).
 * The `verified` flag is set exclusively by the `verifyIdentity` tool, and
 * every detail-revealing tool re-checks it.
 */
export interface CallState {
  readonly callId: string;
  readonly repo: Repository;
  readonly trace: Tracer;
  /** Caller's number: `sip.phoneNumber` on telephony calls, `INCOMING_NUMBER` mock otherwise. */
  incomingNumber?: string;
  /** Account located for this call (caller ID or the lookupAccount tool). */
  account?: Account;
  /** True only after a successful `verifyIdentity` call. */
  verified: boolean;
  verificationAttempts: number;
  lookupFailures: number;
  escalated: boolean;
  outcomeRecorded: boolean;
}

/** Create the initial (unverified) state for a new call. */
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
 * accounts on file and, on a match, attach the account to the call state
 * (pre-verification prompts surface only the name, for right-party confirmation).
 *
 * Lives here rather than in the repository because it is session policy, not
 * data access: what a caller-ID match may attach to the call, and what gets
 * traced (the number is masked in logs).
 *
 * @returns The matched account, or undefined when the number is unknown.
 */
export function locateCallerByPhone(state: CallState, phoneNumber: string): Account | undefined {
  state.incomingNumber = phoneNumber;
  const account = state.repo.findAccountByPhone(phoneNumber);
  state.trace.event('caller_lookup', {
    incomingNumber: maskPhone(phoneNumber),
    matched: account !== undefined,
  });
  if (account) state.account = account;
  return account;
}
