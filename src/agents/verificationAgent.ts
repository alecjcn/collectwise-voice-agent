import { llm, voice } from '@livekit/agents';
import { z } from 'zod';
import { MAX_VERIFICATION_ATTEMPTS, normalizeAccountNumber } from '../policy.ts';
import { VERIFICATION_INSTRUCTIONS, VOICE_RULES, callerLocatedContext } from '../prompts.ts';
import type { CallState } from '../state.ts';
import { createEndCall, escalateToHuman, recordCallOutcome, traced } from '../tools/shared.ts';
import { createNegotiationAgent } from './negotiationAgent.ts';

const lookupAccount = llm.tool({
  name: 'lookupAccount',
  description:
    'Locate a consumer account by account number or by the phone number on file. Returns only the name on file so you can confirm you are speaking with the right person. Never returns balances or other details.',
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
    // Guard against non-identifiers (a name, SSN digits): reject without
    // burning one of the two not-found strikes on model confusion.
    if (accountNumber && !/\d{4}/.test(normalizeAccountNumber(accountNumber))) {
      return 'That is not an account number. lookupAccount only takes an account number (like ATL-1001) or a phone number - never a name or SSN digits. Ask the caller for one of those.';
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
    return `Account located. The name on file is ${account.debtorName}. If the caller already introduced themselves by this name (first name is enough), do not re-confirm it. If they already spoke their SSN last four, call verifyIdentity with those digits right now; otherwise ask for them once.`;
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
      return 'No account has been located yet. Ask for the account number or the phone number on file and call lookupAccount - but remember the SSN digits the caller just gave, and verify with them immediately once the account is found instead of asking again.';
    }
    if (state.verified) {
      return 'Identity is already verified.';
    }
    if (state.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS) {
      return 'No verification attempts remain. Tell the caller you cannot discuss the account today and end the call politely.';
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
    tools: [lookupAccount, verifyIdentity, escalateToHuman, recordCallOutcome, createEndCall()],
  });
}
