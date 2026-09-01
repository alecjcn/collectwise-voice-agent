import type { Repository } from './db/repository.ts';
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
  /** Set by lookupAccount once an account is located. */
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
