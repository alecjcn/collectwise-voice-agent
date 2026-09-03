import { llm, voice } from '@livekit/agents';
import { z } from 'zod';
import { MAX_VERIFICATION_ATTEMPTS, firstNameOf } from '../policy.ts';
import { VERIFICATION_INSTRUCTIONS, VOICE_RULES, callerLocatedContext } from '../prompts.ts';
import type { CallState } from '../state.ts';
import { createEndCall, escalateToHuman, recordCallOutcome, traced } from '../tools/shared.ts';
import { createNegotiationAgent } from './negotiationAgent.ts';

const lookupAccount = llm.tool({
  name: 'lookupAccount',
  description:
    'Locate a consumer account by account number or by the phone number on file. Returns only the first name on file so you can confirm you are speaking with the right person. Never returns balances or other details.',
  parameters: z.object({
    accountNumber: z
      .string()
      .optional()
      .describe('The account number the caller provided, e.g. ATL-1001'),
    phoneNumber: z
      .string()
      .optional()
      .describe('The phone number the caller says is on the account'),
  }),
  execute: traced('lookupAccount', async ({ accountNumber, phoneNumber }, { ctx }) => {
    const state = ctx.userData;
    if (!accountNumber && !phoneNumber) {
      return 'Provide an account number or phone number to look up.';
    }
    let account = accountNumber ? state.repo.findAccountByNumber(accountNumber) : undefined;
    if (!account && phoneNumber) {
      account = state.repo.findAccountByPhone(phoneNumber);
    }
    if (!account) {
      state.lookupFailures += 1;
      if (state.lookupFailures >= 2) {
        return 'No matching account was found again. Offer to have a specialist follow up: use escalateToHuman with reason account_not_found, then recordCallOutcome with outcome account_not_found, and end the call politely.';
      }
      return 'No matching account was found. Ask the caller to double-check the number and try once more.';
    }
    state.account = account;
    const firstName = firstNameOf(account.debtorName);
    return `Account located. The first name on file is ${firstName}. Confirm you are speaking with ${firstName}, then verify their identity before discussing anything about the account.`;
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
      return 'No account has been located yet. Use lookupAccount first.';
    }
    if (state.verified) {
      return 'Identity is already verified.';
    }
    if (state.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS) {
      return 'No verification attempts remain. Tell the caller you cannot discuss the account today and end the call politely.';
    }

    state.verificationAttempts += 1;
    // The comparison happens here, in code: the stored digits never reach the
    // model, so it can only ever relay match / no match. Names are deliberately
    // not compared - STT garbles surnames, and the right party was already
    // confirmed by first name.
    const success = last4Ssn === account.last4Ssn;
    state.repo.recordVerificationAttempt({ callId: state.callId, accountId: account.id, success });
    state.trace.event('verification', { attempt: state.verificationAttempts, success });

    if (success) {
      state.verified = true;
      state.trace.event('state_transition', { from: 'unverified', to: 'verified' });
      return llm.handoff({
        agent: createNegotiationAgent({ chatCtx: ctx.session.chatCtx, account }),
        returns: 'Identity verified successfully.',
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
      return 'The details do not match and no attempts remain. The outcome has been recorded. Tell the caller you are unable to discuss the account today, suggest calling back with correct information, and end the call politely. Do not reveal which detail was wrong.';
    }
    return `The details do not match our records. Attempts remaining: ${remaining}. Let the caller try again. Do not reveal which detail was wrong.`;
  }),
});

/**
 * Agent for the unverified phase of a call: locate the account and verify the
 * caller's identity. Its tools cannot return account details, so nothing in
 * this phase can disclose them.
 *
 * @param options.locatedFirstName - Set when caller-ID lookup already matched
 * an account; skips the account-number ask and opens with right-party
 * confirmation.
 */
export function createVerificationAgent(options?: {
  locatedFirstName?: string;
}): voice.Agent<CallState> {
  const context = options?.locatedFirstName
    ? `\n\n${callerLocatedContext(options.locatedFirstName)}`
    : '';
  return voice.Agent.create<CallState>({
    id: 'verification',
    instructions: `${VERIFICATION_INSTRUCTIONS}${context}\n\n${VOICE_RULES}`,
    tools: [lookupAccount, verifyIdentity, escalateToHuman, recordCallOutcome, createEndCall()],
  });
}
