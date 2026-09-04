import { llm, voice } from '@livekit/agents';
import { z } from 'zod';
import type { Account } from '../db/repository.ts';
import { interruptionAwareLlmNode } from '../interruptions.ts';
import {
  MAX_VERIFICATION_ATTEMPTS,
  checkAccountNumberInput,
  checkPhoneNumberInput,
} from '../policy.ts';
import { VERIFICATION_INSTRUCTIONS, VOICE_RULES, callerLocatedContext } from '../prompts.ts';
import type { CallState } from '../state.ts';
import { createEndCall, escalateToHuman, recordCallOutcome, traced } from '../tools/shared.ts';
import { createNegotiationAgent } from './negotiationAgent.ts';

/**
 * Shared found-path for both lookup tools: cache the account on the call
 * state and hand the model its next move.
 *
 * @param account - The matched row; only the name on file reaches the model.
 * @returns The tool result string steering right-party confirmation.
 */
function accountLocated(state: CallState, account: Account): string {
  state.account = account;
  return `Account located. The name on file is ${account.debtorName}. If the caller already introduced themselves by this name (first name is enough), do not re-confirm it. If they already spoke their SSN last four, call verifyIdentity with those digits right now; otherwise ask for them once.`;
}

/**
 * Shared miss-path for both lookup tools, reached only by a complete,
 * well-formed identifier that matched nothing - malformed input is re-asked
 * upstream and never touches this counter.
 *
 * @returns A retry prompt on the first miss; on the second, the
 * escalate-and-end instruction that closes the location attempt.
 */
function accountNotFound(state: CallState): string {
  state.lookupFailures += 1;
  if (state.lookupFailures >= 2) {
    return 'No matching account was found again. Tell the caller you could not locate their account and that a specialist will follow up: call escalateToHuman with reason account_not_found, then recordCallOutcome with outcome account_not_found, then end_call.';
  }
  return 'No matching account was found. Ask the caller to double-check the number and try once more.';
}

const lookupAccountByAccountNumber = llm.tool({
  name: 'lookupAccountByAccountNumber',
  description:
    "Locate a consumer account by the caller's six digit account number. Returns only the name on file so you can confirm you are speaking with the right person - never balances or other details. Only call with a complete six digit number: if the caller was cut off mid-number or gave a fragment, ask them to repeat the full number instead. Never pass a name or SSN digits.",
  parameters: z.object({
    accountNumber: z
      .string()
      .describe('The complete six digit account number the caller spoke, e.g. 300101'),
  }),
  execute: traced('lookupAccountByAccountNumber', async ({ accountNumber }, { ctx }) => {
    const state = ctx.userData;
    // Shape guards: malformed input is re-asked at no cost to the caller -
    // only a well-formed number that truly matches nothing burns a strike.
    const check = checkAccountNumberInput(accountNumber);
    if (check.kind === 'no_digits') {
      return 'That contains no digits, so it is not an account number. Ask the caller for their six digit account number.';
    }
    if (check.kind === 'ssn_shaped') {
      return 'Four digits is the shape of an SSN, not an account number. Never pass SSN digits here; ask the caller for their six digit account number.';
    }
    if (check.kind === 'wrong_length') {
      return `That has ${check.digitCount} digits, but account numbers have six. The transcript may have cut the caller off - ask them to repeat the complete six digit account number.`;
    }
    const account = state.repo.findAccountByNumber(check.digits);
    return account ? accountLocated(state, account) : accountNotFound(state);
  }),
});

const lookupAccountByPhoneNumber = llm.tool({
  name: 'lookupAccountByPhoneNumber',
  description:
    'Locate a consumer account by the full ten digit phone number on file. Returns only the name on file so you can confirm you are speaking with the right person - never balances or other details. Only call with a complete ten digit number: if the caller was cut off mid-number or gave a fragment, ask them to repeat the full number instead. Never pass a name or a description like "my phone".',
  parameters: z.object({
    phoneNumber: z
      .string()
      .describe('The complete ten digit phone number the caller spoke, e.g. 555 010 4821'),
  }),
  execute: traced('lookupAccountByPhoneNumber', async ({ phoneNumber }, { ctx }) => {
    const state = ctx.userData;
    // Shape guard: fragments are re-asked at no cost to the caller - only a
    // complete number that truly matches nothing burns a strike.
    const check = checkPhoneNumberInput(phoneNumber);
    if (check.kind === 'incomplete') {
      return `That has ${check.digitCount} digits, but a phone number has ten. The transcript may have cut the caller off - ask them to repeat the full ten digit phone number.`;
    }
    const account = state.repo.findAccountByPhone(check.digits);
    return account ? accountLocated(state, account) : accountNotFound(state);
  }),
});

const verifyIdentity = llm.tool({
  name: 'verifyIdentity',
  description:
    "Verify the caller's identity using the last four digits of their social security number. Only call after an account has been located and the caller has confirmed they are the account holder. Three attempts are allowed in total.",
  parameters: z.object({
    last4Ssn: z
      .string()
      .regex(/^\d{4}$/)
      .describe('The last four digits of the social security number, exactly four digits'),
  }),
  execute: traced('verifyIdentity', async ({ last4Ssn }, { ctx }) => {
    const state = ctx.userData;
    const account = state.account;
    if (!account) {
      return 'No account has been located yet. Ask for the account number or the phone number on file and use the lookup tools - but remember the SSN digits the caller just gave, and verify with them immediately once the account is found instead of asking again.';
    }
    if (state.verified) {
      return 'Identity is already verified.';
    }
    if (state.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS) {
      return 'No verification attempts remain. Tell the caller you cannot discuss the account today, then call end_call.';
    }

    // The comparison happens here, in code: the stored digits never reach the
    // model, so it can only ever relay match / no match. Names are deliberately
    // not compared - STT garbles surnames, and the right party was already
    // confirmed by name.
    const success = last4Ssn === account.last4Ssn;
    // Audit before counting: an infrastructure failure must not burn one of
    // the caller's three attempts.
    state.repo.recordVerificationAttempt({ callId: state.callId, accountId: account.id, success });
    state.verificationAttempts += 1;
    state.trace.event('verification', { attempt: state.verificationAttempts, success });

    if (success) {
      state.verified = true;
      state.trace.event('state_transition', { from: 'unverified', to: 'verified' });
      // No `returns` value: a handoff return would make THIS agent generate a
      // reply too (the SDK replies to any tool output), doubling up with the
      // negotiation agent's onEnter greeting. onEnter is the single speaker.
      return llm.handoff({
        agent: createNegotiationAgent({ chatCtx: ctx.session.chatCtx, account }),
      });
    }

    const remaining = MAX_VERIFICATION_ATTEMPTS - state.verificationAttempts;
    if (remaining <= 0) {
      if (!state.outcomeRecorded) {
        state.repo.recordOutcome({
          callId: state.callId,
          accountId: account.id,
          outcome: 'verification_failed',
          notes: 'All verification attempts failed',
        });
        state.outcomeRecorded = true;
      }
      state.trace.event('outcome', { outcome: 'verification_failed' });
      return 'The details do not match and no attempts remain. The outcome has been recorded. Tell the caller you are unable to discuss the account today and suggest calling back with correct information, then call end_call - it says the goodbye and hangs up for you. Do not reveal which detail was wrong.';
    }
    return `The details do not match our records. Attempts remaining: ${remaining}. Let the caller try again. Do not reveal which detail was wrong.`;
  }),
});

/**
 * Agent for the unverified phase of a call: locate the account and verify the
 * caller's identity. Its tools cannot return account details, so nothing in
 * this phase can disclose them.
 *
 * @param options.locatedName - The name on file, set when caller-ID lookup
 * already matched an account; skips the account-number ask and opens with
 * right-party confirmation.
 */
export function createVerificationAgent(options?: {
  locatedName?: string;
}): voice.Agent<CallState> {
  const context = options?.locatedName ? `\n\n${callerLocatedContext(options.locatedName)}` : '';
  return voice.Agent.create<CallState>({
    id: 'verification',
    instructions: `${VERIFICATION_INSTRUCTIONS}${context}\n\n${VOICE_RULES}`,
    llmNode: interruptionAwareLlmNode,
    tools: [
      lookupAccountByAccountNumber,
      lookupAccountByPhoneNumber,
      verifyIdentity,
      escalateToHuman,
      recordCallOutcome,
      createEndCall(),
    ],
  });
}
