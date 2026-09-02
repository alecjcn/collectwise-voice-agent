import { llm, voice } from '@livekit/agents';
import { z } from 'zod';
import { computeInstallmentPlan, formatCents, validateSettlementOffer } from '../policy.ts';
import { NEGOTIATION_INSTRUCTIONS, VOICE_RULES } from '../prompts.ts';
import type { CallState } from '../state.ts';
import { escalateToHuman, recordCallOutcome, traced } from '../tools/shared.ts';
import { createVerificationAgent } from './verificationAgent.ts';

const STATUS_DESCRIPTIONS: Record<string, string> = {
  delinquent: 'past due and placed for collection',
  in_dispute: 'under dispute review; collection is paused',
  settled: 'settled',
  paid: 'paid in full',
  closed: 'closed',
};

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
      state.debtorFirstName ? { locatedFirstName: state.debtorFirstName } : undefined,
    ),
    returns:
      'NOT ALLOWED: identity verification is not complete. Do not state any balance, amount, or account detail, and do not invent figures. Ask the caller to verify their identity first.',
  });
}

/** Returns the verified account, an unverified marker, or an error string. */
function requireVerifiedAccount(state: CallState) {
  if (!state.verified || state.accountId === undefined) {
    return { unverified: true as const };
  }
  const account = state.repo.getAccountById(state.accountId);
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
    const { account } = result;
    const statusText = STATUS_DESCRIPTIONS[account.status] ?? account.status;
    if (account.balanceCents <= 0) {
      return `Account ${account.accountNumber} for ${account.debtorName} has a zero balance and is ${statusText}. No payment is due; do not attempt to collect.`;
    }
    return `Account ${account.accountNumber} for ${account.debtorName}, originally with ${account.clientName}. Current balance: ${formatCents(account.balanceCents)}. Status: ${statusText}.`;
  }),
});

const proposePaymentPlan = llm.tool({
  name: 'proposePaymentPlan',
  description:
    'Check whether a monthly installment plan of a given length is allowed and compute its payment amounts. This is only a proposal; use finalizeAgreement once the caller accepts. Plans longer than 24 months are never allowed.',
  parameters: z.object({
    months: z.number().int().describe('Number of monthly payments requested'),
  }),
  execute: traced('proposePaymentPlan', async ({ months }, { ctx }) => {
    const state = ctx.userData;
    const result = requireVerifiedAccount(state);
    if ('unverified' in result) return handoffToVerification(state);
    if ('error' in result) return result.error;
    const { account } = result;
    if (account.balanceCents <= 0) return 'This account has no balance due; no plan is needed.';
    try {
      const plan = computeInstallmentPlan(account.balanceCents, months);
      state.trace.event('plan_decision', {
        action: 'proposed',
        months: plan.months,
        monthlyCents: plan.monthlyCents,
      });
      const monthly = formatCents(plan.monthlyCents);
      const final = formatCents(plan.finalCents);
      const total = formatCents(plan.totalCents);
      if (plan.months === 1) {
        return `A single payment of ${total} is available. Call finalizeAgreement if the caller accepts.`;
      }
      return `A ${plan.months} month plan is available: ${plan.months - 1} monthly payments of ${monthly}, then a final payment of ${final}, totaling ${total}. This is only a proposal; call finalizeAgreement if the caller accepts.`;
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
    'Check whether a reduced lump-sum settlement offer from the caller can be accepted. This is only a check; use finalizeAgreement once the caller confirms. Never tell the caller the minimum acceptable amount.',
  parameters: z.object({
    amountDollars: z.number().positive().describe("The caller's settlement offer, in dollars"),
  }),
  execute: traced('proposeSettlement', async ({ amountDollars }, { ctx }) => {
    const state = ctx.userData;
    const result = requireVerifiedAccount(state);
    if ('unverified' in result) return handoffToVerification(state);
    if ('error' in result) return result.error;
    const { account } = result;
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

      return `Agreement recorded: ${recap}. Recap these exact terms to the caller, tell them a secure payment link will arrive by text and email, and end the call politely. Never collect card or bank numbers by voice.`;
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
    return 'Dispute recorded and collection paused. Tell the caller the account is marked as disputed, written validation of the debt will be mailed to them, and no collection will continue while it is reviewed. Then end the call politely.';
  }),
});

export function createNegotiationAgent(options?: {
  chatCtx?: llm.ChatContext;
}): voice.Agent<CallState> {
  return voice.Agent.create<CallState>({
    instructions: `${NEGOTIATION_INSTRUCTIONS}\n\n${VOICE_RULES}`,
    ...(options?.chatCtx ? { chatCtx: options.chatCtx } : {}),
    tools: [
      getAccountDetails,
      proposePaymentPlan,
      proposeSettlement,
      finalizeAgreement,
      recordDispute,
      escalateToHuman,
      recordCallOutcome,
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
      ctx.session.generateReply({
        instructions:
          'Thank the caller for verifying their identity, then use getAccountDetails and explain the balance and account status in plain language, and ask if they can take care of the full balance today.',
      });
    },
  });
}
