import { type inference, initializeLogger, llm, type voice } from '@livekit/agents';
import dotenv from 'dotenv';
import { z } from 'zod';
import { openDb } from '../db/db.ts';
import { type Account, Repository } from '../db/repository.ts';
import { seedIfEmpty } from '../db/seed.ts';
import { type CallState, createCallState } from '../state.ts';
import { Tracer } from '../trace.ts';

// LiveKit Inference credentials for the agent LLM and the judge.
dotenv.config({ path: '.env.local' });

// The SDK logger must be initialized before any Tracer is constructed; 'warn'
// keeps info-level trace events out of test output.
initializeLogger({ pretty: false, level: 'warn' });

/** The model driving the agent under test — same default as production. */
export const AGENT_MODEL = process.env.LLM_MODEL ?? 'openai/gpt-4.1-mini';

/** The judge model used to grade agent responses in evals. */
export const JUDGE_MODEL = 'openai/gpt-4.1-mini';

/**
 * Everything the agent said during a run, in order. Skips content-free
 * fragments small models occasionally emit (for example "}" or "</thead>").
 */
export function assistantTranscript(result: voice.testing.RunResult): string {
  const texts: string[] = [];
  for (const event of result.events) {
    if (event.type !== 'message' || event.item.role !== 'assistant') continue;
    const text = event.item.textContent ?? '';
    if ((text.match(/[a-z]{2,}/gi) ?? []).length < 2) continue;
    texts.push(text);
  }
  if (texts.length === 0) throw new Error('Run contains no substantive assistant message');
  return texts.join('\n');
}

/**
 * LLM-judge a whole agent turn against an intent. Unlike the SDK's per-message
 * `judge()`, this evaluates every assistant message from the run together, so
 * a turn split across messages (say a promise, then a goodbye before the
 * end_call tool) is judged as one response. Throws on a failed judgment.
 */
export async function judgeTurn(
  judgeLlm: inference.LLM,
  result: voice.testing.RunResult,
  options: { intent: string },
): Promise<void> {
  const transcript = assistantTranscript(result);

  let verdict: { success: boolean; reason: string } | undefined;
  const checkIntent = llm.tool({
    name: 'check_intent',
    description: 'Report whether the agent turn fulfills the given intent.',
    parameters: z.object({
      success: z.boolean().describe('Whether the turn satisfies the intent'),
      reason: z.string().describe('A concise explanation justifying the result'),
    }),
    execute: async (args: { success: boolean; reason: string }) => {
      verdict = args;
      return args;
    },
  });

  const chatCtx = llm.ChatContext.empty();
  chatCtx.addMessage({
    role: 'system',
    content:
      'You are a test evaluator for conversational agents.\n' +
      'You will be shown everything an agent said during one conversational turn (messages in order), and a target intent.\n' +
      'Determine whether the turn as a whole accomplishes the intent.\n' +
      'Only respond by calling the `check_intent(success: bool, reason: str)` function with your final judgment.\n' +
      'Be strict: if the turn does not clearly fulfill the intent, return `success = false` and explain why.',
  });
  chatCtx.addMessage({
    role: 'user',
    content: `Intent:\n${options.intent}\n\nAgent turn:\n${transcript}`,
  });

  const stream = judgeLlm.chat({
    chatCtx,
    toolCtx: [checkIntent],
    toolChoice: 'required',
    extraKwargs: { temperature: 0 },
  });
  for await (const chunk of stream) {
    const toolCall = chunk.delta?.toolCalls?.[0];
    if (toolCall?.args) {
      try {
        verdict = JSON.parse(toolCall.args);
      } catch {
        // Args may stream incrementally; keep the last valid parse.
      }
    }
  }

  if (!verdict) throw new Error('Judge LLM returned no verdict.');
  if (!verdict.success) {
    throw new Error(`Turn judgment failed: ${verdict.reason}\nAgent turn was:\n${transcript}`);
  }
}

let testCounter = 0;

/**
 * Fresh, isolated call state for a test: an in-memory SQLite database with the
 * seed accounts, and a silent tracer. Mirrors exactly what main.ts builds for
 * a real call.
 */
export function createTestState(): CallState {
  const repo = new Repository(openDb(':memory:'));
  seedIfEmpty(repo);
  const callId = `test-${++testCounter}`;
  return createCallState({ callId, repo, trace: new Tracer(callId) });
}

/**
 * Mark the state as already verified for the given seed account, as if the
 * caller had passed the verification phase. Used to test the negotiation
 * agent in isolation.
 */
export function markVerified(state: CallState, accountNumber = 'ATL-1001'): Account {
  const account = markLocated(state, accountNumber);
  state.verified = true;
  return account;
}

/**
 * Attach a located (but unverified) account to the state, as caller-ID lookup
 * or the lookupAccount tool would. Pair it with
 * `createVerificationAgent({ locatedFirstName })` so the prompt matches the
 * state, exactly as main.ts wires the caller-ID flow.
 */
export function markLocated(state: CallState, accountNumber = 'ATL-1001'): Account {
  const account = state.repo.findAccountByNumber(accountNumber);
  if (!account) throw new Error(`Seed account ${accountNumber} not found`);
  state.account = account;
  return account;
}
