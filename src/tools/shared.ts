import { beta, llm } from '@livekit/agents';
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

/**
 * Lets the agent hang up gracefully: the SDK's prebuilt tool waits for the
 * goodbye to finish playing, shuts the session down, and deletes the room.
 *
 * TODO(POC): a production build would warm-transfer escalations to a live
 * agent (SIP REFER, or adding a human participant to the room) instead of
 * promising a callback and hanging up. For this prototype, ending the room is
 * the whole exit path.
 */
export function createEndCall() {
  return beta.createEndCallTool<CallState>({
    extraDescription:
      'Also call this to wrap up a completed call: an outcome must already be recorded (finalizeAgreement or recordCallOutcome). Calling this tool generates the goodbye and hangs up after it finishes playing, so do NOT compose a farewell yourself and do NOT announce that you are ending or wrapping up the call - ending the call means calling this tool, nothing more. If the caller asked a question you have not answered yet, answer it before calling end_call - but an acknowledgment ("okay", "that is fine", "sounds good") is not a question: on an acknowledgment after the business is done, call end_call right away instead of repeating anything. Never call it in the same turn as finalizeAgreement: the caller must hear the recap and respond first.',
    // The tool's designed flow: end_call generates the ONE goodbye (from this
    // instruction), waits for it to finish playing, then shuts down. Keeping
    // the goodbye here, rather than asking the model to pair farewell text
    // with a tool call in a single completion, is what makes hanging up
    // reliable. The conditional covers the model occasionally saying its own
    // goodbye anyway.
    endInstructions:
      'Say one brief, warm goodbye: thank the caller for their time and wish them well, in one short sentence. No new information, no questions, no greetings. If your last message was already a goodbye, output nothing at all.',
    ignoreOnEnter: true,
    onToolCalled: ({ ctx }) => {
      ctx.userData.trace.event('end_call', { by: 'agent' });
    },
  });
}

const escalationReasons = [
  'caller_requested',
  'wrong_person',
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
    // TODO(POC): this is where a live transfer would happen; see createEndCall.
    state.trace.event('escalation', {
      reason,
      details,
      note: 'triggered handoff to live agent (POC: callback promised, agent ends call)',
    });
    return 'Escalation recorded. Tell the caller a specialist will call them back within one business day. Then record the call outcome if none is recorded yet, and call end_call when the caller is done.';
  }),
});

const recordableOutcomes = [
  'wrong_person',
  'verification_failed',
  'account_not_found',
  'callback_requested',
  'escalated',
  'no_agreement',
  'no_balance_due',
  'dispute',
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
      return 'An outcome has already been recorded for this call. Call end_call when the caller is done.';
    }
    state.repo.recordOutcome({
      callId: state.callId,
      accountId: state.account?.id,
      outcome,
      notes,
    });
    state.outcomeRecorded = true;
    state.trace.event('outcome', { outcome, notes });
    return `Outcome recorded as ${outcome}. Wrap up: relay anything the caller still needs to hear, then call end_call - it says the goodbye and hangs up for you.`;
  }),
});
