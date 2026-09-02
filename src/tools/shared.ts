import { llm } from '@livekit/agents';
import { z } from 'zod';
import type { CallState } from '../state.ts';

/**
 * Wrap a tool's execute function so every call, result, error, and handoff is
 * automatically written to the per-call trace.
 */
export function traced<A, R>(
  name: string,
  execute: (args: A, opts: llm.ToolOptions<CallState>) => Promise<R>,
): (args: A, opts: llm.ToolOptions<CallState>) => Promise<R> {
  return async (args, opts) => {
    const { trace } = opts.ctx.userData;
    trace.event('tool_call', { name, args });
    try {
      const result = await execute(args, opts);
      const isHandoff = typeof result === 'object' && result !== null && 'agent' in result;
      if (isHandoff) {
        const target = (result as { agent?: { id?: string } }).agent?.id;
        trace.event('handoff', { via: name, to: target });
      } else {
        trace.event('tool_result', { name, result });
      }
      return result;
    } catch (error) {
      trace.event('tool_error', { name, error: String(error) });
      throw error;
    }
  };
}

const escalationReasons = [
  'caller_requested',
  'hardship',
  'dispute',
  'account_not_found',
  'verification_issues',
  'unable_to_proceed',
  'other',
] as const;

export const escalateToHuman = llm.tool({
  name: 'escalateToHuman',
  description:
    'Escalate this call to a human specialist. Use when the caller asks for a human, when hardship needs review, when the account cannot be found, or when the conversation cannot proceed. A specialist will call the consumer back within one business day.',
  parameters: z.object({
    reason: z.enum(escalationReasons).describe('Why the call is being escalated'),
    details: z.string().optional().describe('Brief context for the specialist'),
  }),
  execute: traced('escalateToHuman', async ({ reason, details }, { ctx }) => {
    const state = ctx.userData;
    state.repo.recordEscalation({
      callId: state.callId,
      accountId: state.account?.id,
      reason,
      details,
    });
    state.escalated = true;
    state.trace.event('escalation', { reason, details });
    return 'Escalation recorded. Tell the caller a specialist will call them back within one business day.';
  }),
});

const recordableOutcomes = [
  'wrong_person',
  'verification_failed',
  'account_not_found',
  'callback_requested',
  'escalated',
  'no_agreement',
] as const;

export const recordCallOutcome = llm.tool({
  name: 'recordCallOutcome',
  description:
    'Record the final disposition of this call when it ends WITHOUT a payment agreement. For agreed payments, plans, or settlements use finalizeAgreement instead. Call this once, just before ending the call.',
  parameters: z.object({
    outcome: z.enum(recordableOutcomes).describe('The final call disposition'),
    notes: z.string().optional().describe('Brief summary of what happened'),
  }),
  execute: traced('recordCallOutcome', async ({ outcome, notes }, { ctx }) => {
    const state = ctx.userData;
    if (state.outcomeRecorded) {
      return 'An outcome has already been recorded for this call. End the call politely.';
    }
    state.repo.recordOutcome({
      callId: state.callId,
      accountId: state.account?.id,
      outcome,
      notes,
    });
    state.outcomeRecorded = true;
    state.trace.event('outcome', { outcome, notes });
    return `Outcome recorded as ${outcome}. Wrap up and end the call politely.`;
  }),
});
