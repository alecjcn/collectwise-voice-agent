import { llm, voice } from '@livekit/agents';
import { z } from 'zod';
import { MAX_VERIFICATION_ATTEMPTS, namesMatch } from '../policy.ts';
import { VERIFICATION_INSTRUCTIONS, VOICE_RULES, callerLocatedContext } from '../prompts.ts';
import type { CallState } from '../state.ts';
import { attachLocatedAccount } from '../state.ts';
import { escalateToHuman, recordCallOutcome, traced } from '../tools/shared.ts';
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
    attachLocatedAccount(state, account);
    return `Account located. The first name on file is ${state.debtorFirstName}. Confirm you are speaking with ${state.debtorFirstName}, then verify their identity before discussing anything about the account.`;
  }),
});

const verifyIdentity = llm.tool({
  name: 'verifyIdentity',
  description:
    "Verify the caller's identity using their full name and the last four digits of their social security number. Only call after lookupAccount has located an account and the caller has confirmed they are the account holder. Three attempts are allowed in total.",
  parameters: z.object({
    fullName: z.string().describe('The full name the caller stated'),
    last4Ssn: z
      .string()
      .regex(/^\d{4}$/)
      .describe('The last four digits of the social security number, exactly four digits'),
  }),
  execute: traced('verifyIdentity', async ({ fullName, last4Ssn }, { ctx }) => {
    const state = ctx.userData;
    if (state.accountId === undefined) {
      return 'No account has been located yet. Use lookupAccount first.';
    }
    if (state.verified) {
      return 'Identity is already verified.';
    }
    if (state.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS) {
      return 'No verification attempts remain. Tell the caller you cannot discuss the account today and end the call politely.';
    }
    const account = state.repo.getAccountById(state.accountId);
    if (!account) {
      return 'The account could not be loaded. Offer to escalate to a specialist.';
    }

    state.verificationAttempts += 1;
    const success = namesMatch(fullName, account.debtorName) && last4Ssn === account.last4Ssn;
    state.repo.recordVerificationAttempt({
      callId: state.callId,
      accountId: account.id,
      providedName: fullName,
      success,
    });
    state.trace.event('verification', {
      attempt: state.verificationAttempts,
      success,
    });

    if (success) {
      state.verified = true;
      state.account = account;
      state.trace.event('state_transition', { from: 'unverified', to: 'verified' });
      // The caller is now verified, so the negotiation agent is created with
      // the account details injected into its instructions — the first
      // verified turn needs no getAccountDetails round-trip.
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
 * @param options.locatedFirstName - set when caller-ID lookup already matched
 * an account; skips the account-number ask and goes straight to right-party
 * confirmation + identity verification.
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
    tools: [lookupAccount, verifyIdentity, escalateToHuman, recordCallOutcome],
  });
}
