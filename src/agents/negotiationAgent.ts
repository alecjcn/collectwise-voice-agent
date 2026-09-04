import { llm, voice } from '@livekit/agents';
import { z } from 'zod';
import type { Account } from '../db/repository.ts';
import { interruptionAwareLlmNode } from '../interruptions.ts';
import {
  type InstallmentPlan,
  computeInstallmentPlan,
  computePlanForBudget,
  formatCents,
  validateSettlementOffer,
} from '../policy.ts';
import { NEGOTIATION_INSTRUCTIONS, VOICE_RULES } from '../prompts.ts';
import type { CallState } from '../state.ts';
import { createEndCall, escalateToHuman, recordCallOutcome, traced } from '../tools/shared.ts';
import { createVerificationAgent } from './verificationAgent.ts';

const STATUS_DESCRIPTIONS: Record<string, string> = {
  delinquent: 'past due and placed for collection',
  in_dispute: 'under dispute review; collection is paused',
  settled: 'settled',
  paid: 'paid in full',
  closed: 'closed',
};

function describeAccount(account: Account): string {
  const statusText = STATUS_DESCRIPTIONS[account.status] ?? account.status;
  if (account.balanceCents <= 0) {
    return `Account ${account.accountNumber} for ${account.debtorName} has a zero balance and is ${statusText}. No payment is due; do not attempt to collect. Before ending this call, record the outcome no_balance_due with recordCallOutcome.`;
  }
  const base = `Account ${account.accountNumber} for ${account.debtorName}, originally with ${account.clientName}. Current balance: ${formatCents(account.balanceCents)}. Status: ${statusText}.`;
  if (account.status === 'in_dispute') {
    return `${base} Collection is paused while the dispute is reviewed: do not request payment or offer plans or settlements. Answer questions, offer a specialist follow-up if needed, and before ending this call record the outcome dispute with recordCallOutcome.`;
  }
  // Precompute the standard opening offer so the first counter-proposal
  // needs no tool round-trip and the model never invents plan numbers.
  if (account.status === 'delinquent') {
    const anchor = computeInstallmentPlan(account.balanceCents, 3);
    return `${base} Standard opening payment plan (offer these exact amounts if the caller cannot pay in full): 3 months - 2 monthly payments of ${formatCents(anchor.monthlyCents)}, then a final payment of ${formatCents(anchor.finalCents)}.`;
  }
  return base;
}

/**
 * Deterministic guardrail: an unverified session must never be answered by this
 * agent. Hand control back to the verification agent, which cannot disclose
 * account details, instead of trusting the model to relay a refusal.
 */
function handoffToVerification(state: CallState) {
  state.trace.event('state_transition', {
    from: 'negotiation',
    to: 'verification',
    reason: 'session not verified',
  });
  return llm.handoff({
    agent: createVerificationAgent(
      state.account ? { locatedName: state.account.debtorName } : undefined,
    ),
    returns:
      'NOT ALLOWED: identity is not verified, so no account information exists to share. Respond with exactly this sentence and nothing else: "Before I can share any account information, I need to verify your identity. Could I have the last four digits of your social security number?"',
  });
}

/**
 * Collection tools must refuse while an account is under dispute review -
 * in code, not just in the prompt, so a confused model cannot book a plan
 * on a disputed account.
 */
function refuseIfDisputed(account: Account): string | undefined {
  if (account.status === 'in_dispute') {
    return 'This account is under dispute review and collection is paused. Do not propose or finalize any payment. Confirm the dispute is being reviewed and offer a specialist follow-up for questions.';
  }
  return undefined;
}

/** Returns the verified account, an unverified marker, or an error string. */
function requireVerifiedAccount(state: CallState) {
  if (!state.verified || !state.account) {
    return { unverified: true as const };
  }
  // Re-read from the database so mid-call changes (e.g. a dispute) are seen.
  const account = state.repo.getAccountById(state.account.id);
  if (!account) {
    return { error: 'The account could not be loaded. Offer to escalate to a specialist.' };
  }
  return { account };
}

const getAccountDetails = llm.tool({
  name: 'getAccountDetails',
  description:
    "Look up the verified caller's account details: balance, status, and creditor. Only works after identity verification.",
  execute: traced('getAccountDetails', async (_, { ctx }) => {
    const state = ctx.userData;
    const result = requireVerifiedAccount(state);
    if ('unverified' in result) return handoffToVerification(state);
    if ('error' in result) return result.error;
    return describeAccount(result.account);
  }),
});

/** Speakable summary of a computed plan, shared by both proposal paths. */
function describePlan(plan: InstallmentPlan): string {
  if (plan.months === 1) {
    return `a single payment of ${formatCents(plan.totalCents)}`;
  }
  return `a ${plan.months} month plan: ${plan.months - 1} monthly payments of ${formatCents(plan.monthlyCents)}, then a final payment of ${formatCents(plan.finalCents)}, totaling ${formatCents(plan.totalCents)}`;
}

const proposePaymentPlan = llm.tool({
  name: 'proposePaymentPlan',
  description:
    'Compute an installment plan from what the caller asked for: pass months when they named a plan length, or monthlyAmountDollars when they named what they can pay per month (pass exactly one). The tool does all plan arithmetic - never convert a monthly amount into months yourself. This is only a proposal; use finalizeAgreement once the caller accepts. Plans longer than 24 months are never allowed.',
  parameters: z.object({
    months: z.number().int().optional().describe('The plan length the caller asked for, in months'),
    monthlyAmountDollars: z
      .number()
      .positive()
      .optional()
      .describe('The monthly amount the caller said they can pay, in dollars'),
  }),
  execute: traced('proposePaymentPlan', async ({ months, monthlyAmountDollars }, { ctx }) => {
    const state = ctx.userData;
    const result = requireVerifiedAccount(state);
    if ('unverified' in result) return handoffToVerification(state);
    if ('error' in result) return result.error;
    const { account } = result;
    const disputed = refuseIfDisputed(account);
    if (disputed) return disputed;
    if (account.balanceCents <= 0) return 'This account has no balance due; no plan is needed.';
    if ((months === undefined) === (monthlyAmountDollars === undefined)) {
      return 'Pass exactly one of months or monthlyAmountDollars.';
    }

    // Caller stated a monthly budget: code picks the shortest affordable
    // plan, or the closest allowed payment when nothing fits under the cap.
    if (monthlyAmountDollars !== undefined) {
      const budgetCents = Math.round(monthlyAmountDollars * 100);
      if (budgetCents <= 0) return 'The monthly amount must be positive.';
      const { plan, withinBudget } = computePlanForBudget(account.balanceCents, budgetCents);
      state.trace.event('plan_decision', {
        action: withinBudget ? 'proposed' : 'proposed_over_budget',
        budgetCents,
        months: plan.months,
        monthlyCents: plan.monthlyCents,
      });
      if (!withinBudget) {
        return `${formatCents(budgetCents)} per month would take more than the 24 month maximum. The closest allowed plan is ${describePlan(plan)} - slightly above their number. Offer that plan and ask if it is manageable; never promise more than 24 months or a lower payment.`;
      }
      return `The shortest plan within ${formatCents(budgetCents)} per month is ${describePlan(plan)}. This is only a proposal; call finalizeAgreement if the caller accepts.`;
    }

    // Caller asked for a plan length directly.
    try {
      const plan = computeInstallmentPlan(account.balanceCents, months!);
      state.trace.event('plan_decision', {
        action: 'proposed',
        months: plan.months,
        monthlyCents: plan.monthlyCents,
      });
      return `Available: ${describePlan(plan)}. This is only a proposal; call finalizeAgreement if the caller accepts.`;
    } catch (error) {
      state.trace.event('plan_decision', {
        action: 'rejected',
        months,
        reason: (error as Error).message,
      });
      return `Cannot offer this plan: ${(error as Error).message} Offer an allowed alternative instead.`;
    }
  }),
});

const proposeSettlement = llm.tool({
  name: 'proposeSettlement',
  description:
    'Check whether a reduced lump-sum settlement offer from the caller can be accepted. This is only a check; use finalizeAgreement once the caller confirms. Do not volunteer the minimum acceptable amount; the tool result says when disclosing it is permitted.',
  parameters: z.object({
    amountDollars: z.number().positive().describe("The caller's settlement offer, in dollars"),
  }),
  execute: traced('proposeSettlement', async ({ amountDollars }, { ctx }) => {
    const state = ctx.userData;
    const result = requireVerifiedAccount(state);
    if ('unverified' in result) return handoffToVerification(state);
    if ('error' in result) return result.error;
    const { account } = result;
    const disputed = refuseIfDisputed(account);
    if (disputed) return disputed;
    if (account.balanceCents <= 0)
      return 'This account has no balance due; no settlement is needed.';
    const offerCents = Math.round(amountDollars * 100);
    const validation = validateSettlementOffer(account.balanceCents, offerCents);
    state.trace.event('plan_decision', {
      action: validation.acceptable ? 'settlement_acceptable' : 'settlement_rejected',
      offerCents,
    });
    if (!validation.acceptable) {
      if (offerCents > account.balanceCents) {
        return 'The offer is more than the balance; the caller should simply pay the balance in full instead.';
      }
      // Progressive disclosure: conceal the floor at first so the caller leads,
      // but after two below-floor offers end the guessing game by naming it.
      state.settlementRejections += 1;
      if (state.settlementRejections >= 2) {
        return `An offer of ${formatCents(offerCents)} cannot be accepted. The caller has now made ${state.settlementRejections} offers below the minimum, so you may disclose it: tell them the lowest settlement you can accept is ${formatCents(validation.minCents)}, and ask if they can do that amount.`;
      }
      return `An offer of ${formatCents(offerCents)} cannot be accepted. Do NOT reveal any minimum amount. Tell the caller you are unable to accept that and ask if they can do a higher amount, or return to payment plan options.`;
    }
    return `A settlement of ${formatCents(offerCents)} CAN be accepted as a one-time payment resolving the account. Call finalizeAgreement with this amount if the caller confirms.`;
  }),
});

const finalizeAgreement = llm.tool({
  name: 'finalizeAgreement',
  description:
    'Commit the resolution the caller has clearly agreed to, and record the call outcome. Use planType pay_in_full for full payment, installments with months for a monthly plan, or settlement with settlementAmountDollars for an agreed reduced lump sum.',
  parameters: z.object({
    planType: z.enum(['pay_in_full', 'installments', 'settlement']),
    months: z
      .number()
      .int()
      .optional()
      .describe('Required for installments: the agreed number of monthly payments'),
    settlementAmountDollars: z
      .number()
      .positive()
      .optional()
      .describe('Required for settlement: the agreed lump-sum amount in dollars'),
  }),
  execute: traced(
    'finalizeAgreement',
    async ({ planType, months, settlementAmountDollars }, { ctx }) => {
      const state = ctx.userData;
      const result = requireVerifiedAccount(state);
      if ('unverified' in result) return handoffToVerification(state);
      if ('error' in result) return result.error;
      const { account } = result;
      const disputed = refuseIfDisputed(account);
      if (disputed) return disputed;
      if (account.balanceCents <= 0) return 'This account has no balance due; nothing to finalize.';
      if (state.outcomeRecorded) {
        return 'An outcome has already been recorded for this call. End the call politely.';
      }

      let totalCents: number;
      let numInstallments: number;
      let installmentCents: number;
      let outcome: 'promise_to_pay_full' | 'payment_plan_agreed' | 'settlement_agreed';
      let recap: string;

      if (planType === 'pay_in_full') {
        totalCents = account.balanceCents;
        numInstallments = 1;
        installmentCents = totalCents;
        outcome = 'promise_to_pay_full';
        recap = `payment in full of ${formatCents(totalCents)}`;
      } else if (planType === 'installments') {
        if (months === undefined) return 'months is required for an installment plan.';
        let plan;
        try {
          plan = computeInstallmentPlan(account.balanceCents, months);
        } catch (error) {
          return `Cannot finalize this plan: ${(error as Error).message}`;
        }
        totalCents = plan.totalCents;
        numInstallments = plan.months;
        installmentCents = plan.monthlyCents;
        outcome = 'payment_plan_agreed';
        recap = `a ${plan.months} month plan of ${formatCents(plan.monthlyCents)} per month (final payment ${formatCents(plan.finalCents)}), totaling ${formatCents(totalCents)}`;
      } else {
        if (settlementAmountDollars === undefined) {
          return 'settlementAmountDollars is required for a settlement.';
        }
        const offerCents = Math.round(settlementAmountDollars * 100);
        const validation = validateSettlementOffer(account.balanceCents, offerCents);
        if (!validation.acceptable) {
          return 'This settlement amount is not allowed and cannot be finalized. Do not reveal any minimum; continue negotiating.';
        }
        totalCents = offerCents;
        numInstallments = 1;
        installmentCents = offerCents;
        outcome = 'settlement_agreed';
        recap = `a one-time settlement of ${formatCents(offerCents)} resolving the account`;
      }

      state.repo.createPaymentPlan({
        accountId: account.id,
        callId: state.callId,
        planType,
        totalCents,
        numInstallments,
        installmentCents,
      });
      state.repo.recordOutcome({ callId: state.callId, accountId: account.id, outcome });
      state.outcomeRecorded = true;
      state.trace.event('plan_decision', {
        action: 'finalized',
        planType,
        totalCents,
        numInstallments,
      });
      state.trace.event('outcome', { outcome });

      return `Agreement recorded: ${recap}. Recap these exact terms to the caller ONCE and tell them a secure payment link will arrive by text and email. Do NOT call end_call in this turn - let the caller respond to the recap first; once they acknowledge, call end_call (it says the goodbye for you). If the caller interrupts or acknowledges, NEVER repeat the terms or amounts again: reply with at most one short sentence like 'You are all set - the secure payment link is on its way by text and email', then call end_call. Never collect card or bank numbers by voice.`;
    },
  ),
});

const recordDispute = llm.tool({
  name: 'recordDispute',
  description:
    'Record that the caller disputes this debt (says it is not theirs, already paid, or the amount is wrong). This pauses all collection on the account. Stop discussing payment after calling this.',
  parameters: z.object({
    reason: z.string().describe("The caller's stated reason for the dispute"),
  }),
  execute: traced('recordDispute', async ({ reason }, { ctx }) => {
    const state = ctx.userData;
    const result = requireVerifiedAccount(state);
    if ('unverified' in result) return handoffToVerification(state);
    if ('error' in result) return result.error;
    const { account } = result;
    state.repo.updateAccountStatus(account.id, 'in_dispute');
    if (!state.outcomeRecorded) {
      state.repo.recordOutcome({
        callId: state.callId,
        accountId: account.id,
        outcome: 'dispute',
        notes: reason,
      });
      state.outcomeRecorded = true;
    }
    state.trace.event('outcome', { outcome: 'dispute', reason });
    return 'Dispute recorded and collection paused. Confirm this to the caller in ONE brief statement: the account is marked as disputed, written validation will be mailed, and no collection continues while it is reviewed - but never repeat any of those points you already told them. Then call end_call when they are done.';
  }),
});

/**
 * @param options.account - the verified caller's account, injected into this
 * agent's instructions so the first verified turn needs no tool round-trip.
 * Only pass it when verification has succeeded: this factory is the single
 * place account details ever enter a prompt, and its two production call
 * sites (verifyIdentity's handoff, and tests) both sit behind that check.
 */
export function createNegotiationAgent(options?: {
  chatCtx?: llm.ChatContext;
  account?: Account;
}): voice.Agent<CallState> {
  const accountContext = options?.account
    ? `\n\n# Account on file (verified caller)\n\n${describeAccount(options.account)} Use these details when explaining the account; call getAccountDetails only if you need to re-check after something changes.`
    : '';
  return voice.Agent.create<CallState>({
    id: 'negotiation',
    instructions: `${NEGOTIATION_INSTRUCTIONS}${accountContext}\n\n${VOICE_RULES}`,
    llmNode: interruptionAwareLlmNode,
    ...(options?.chatCtx ? { chatCtx: options.chatCtx } : {}),
    tools: [
      getAccountDetails,
      proposePaymentPlan,
      proposeSettlement,
      finalizeAgreement,
      recordDispute,
      escalateToHuman,
      recordCallOutcome,
      createEndCall(),
    ],
    onEnter(ctx) {
      // Structural guardrail: this agent must never operate on an unverified
      // session. If mis-wired, hand control straight back to verification.
      const state = ctx.session.userData;
      if (!state.verified) {
        state.trace.event('state_transition', {
          from: 'negotiation',
          to: 'verification',
          reason: 'session not verified',
        });
        ctx.session.updateAgent(createVerificationAgent());
        return;
      }
      if (options?.account) {
        // The account is already in the instructions; no tool round-trip needed.
        ctx.session.generateReply({
          instructions:
            'Thank the caller for verifying their identity, then explain the balance and account status from the account on file in plain language, and ask if they can take care of the full balance today.',
          toolChoice: 'none',
        });
      } else {
        ctx.session.generateReply({
          instructions:
            'Thank the caller for verifying their identity, then use getAccountDetails and explain the balance and account status in plain language, and ask if they can take care of the full balance today.',
        });
      }
    },
  });
}
